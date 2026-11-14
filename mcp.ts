// MCP: JSON-RPC 2.0 Streamable HTTP at /mcp. Modern-era server/discover plus a
// legacy initialize fallback; tools act on the same store as REST and GraphQL.

import {
  createIssueInRepo, createPullInRepo, findRepoByGlobalId,
} from './graphql.ts';
import {
  globalId, issueJson, pullJson, repoJson, squashMerge, store,
  type Issue, type Pull, type Repo,
} from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Pull request state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'number', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
];

export function toolsList(): { tools: ToolDef[] } {
  // A fixed prebuilt structure: byte-identical across calls.
  return { tools: TOOLS };
}

// ---------------------------------------------------------------- shapes
// Same JSON shapes as REST v3 (store.ts), so objects/ids match across surfaces.

export const repoJsonFor = repoJson;
export const issueJsonFor = issueJson;
export const pullJsonFor = pullJson;

function textResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

// ---------------------------------------------------------------- dispatch

function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n];
  return undefined;
}

export function callTool(name: string, argsIn: unknown): { result: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const args = (argsIn && typeof argsIn === 'object' && !Array.isArray(argsIn)) ? (argsIn as Record<string, unknown>) : {};
  const tool = TOOLS.find((t) => t.name === name.toLowerCase());
  if (!tool) return { result: errorResult(`Unknown tool: ${name}`), rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { result: errorResult(`Missing required argument: ${req}`), rpcError: { code: -32602, message: `Missing required argument: ${req}` } };
    }
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const owner = VIEWER_LOGIN;
        if (store.getRepo(owner, repoName)) return { result: errorResult('Repository already exists') };
        const repo = store.createRepo(repoName, String(args.description ?? ''), Boolean(args.private ?? false));
        if (!repo) return { result: errorResult('Repository already exists') };
        return { result: textResult(repoJsonFor(repo)) };
      }
      case 'get_repo': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        return { result: textResult(repoJsonFor(repo)) };
      }
      case 'create_issue': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        const issue = createIssueInRepo(repo, String(args.title), String(args.body ?? ''));
        return { result: textResult(issueJsonFor(repo, issue)) };
      }
      case 'list_issues': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        const state = String(args.state ?? 'open');
        let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const out = list.map((i) => issueJsonFor(repo, i));
        return { result: textResult(out) };
      }
      case 'create_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        const head = String(args.head);
        const base = String(args.base);
        if (repo.refs.get(`refs/heads/${head}`) === undefined) return { result: errorResult(`Head branch ${head} does not exist`) };
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return { result: errorResult(`Base branch ${base} does not exist`) };
        const pull = createPullInRepo(repo, String(args.title), String(args.body ?? ''), head, base);
        if (!pull) return { result: errorResult('Could not create pull request') };
        return { result: textResult(pullJsonFor(repo, pull)) };
      }
      case 'merge_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        const pull = repo.pulls.get(Number(pickArg(args, 'pull_number', 'pullNumber', 'number')));
        if (!pull) return { result: errorResult('Not Found') };
        const merged = squashMerge(repo, pull);
        if (!merged) return { result: errorResult('Merge conflict') };
        return { result: textResult({ ...pullJsonFor(repo, pull), merged: true, sha: pull.mergeCommitSha, message: 'Pull request successfully merged' }) };
      }
      case 'list_pull_requests': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        const state = String(args.state ?? 'open');
        let list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        return { result: textResult(list.map((p) => pullJsonFor(repo, p))) };
      }
      case 'get_issue': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: errorResult('Not Found') };
        const issue = repo.issues.get(Number(pickArg(args, 'issue_number', 'issueNumber', 'number')));
        if (!issue) return { result: errorResult('Not Found') };
        return { result: textResult(issueJsonFor(repo, issue)) };
      }
      default:
        return { result: errorResult(`Unknown tool: ${name}`), rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
    }
  } catch (err) {
    return { result: errorResult(err instanceof Error ? err.message : 'Tool call failed') };
  }
}

export { findRepoByGlobalId, globalId };
