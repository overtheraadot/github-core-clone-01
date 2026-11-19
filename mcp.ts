// mcp.ts — Model Context Protocol over Streamable HTTP (plain JSON answers).
// Modern revision 2026-07-28 (server/discover, no handshake/session) with a
// legacy initialize fallback. Tools act on the same store as REST/GraphQL.

import { globalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { doMerge, issueJson, pullIsMergeable, pullJson, repoJson } from './rest.ts';
import { jsonResult, type HandlerResult, type ReqCtx } from './types.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------------------------------------
// Tools (a module-level constant: two tools/list calls answer byte-identical JSON)
// ---------------------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------------------------------------

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function resolveRepo(store: Store, owner: string, repoName: string): Repo | null {
  const repo = store.getRepo(repoName);
  if (!repo || owner !== store.tokenOwner) return null;
  store.learnOwner(owner);
  return repo;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return toolError(`Unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(repoName)) return toolError(`Repository ${repoName} already exists`);
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      const result = repoJson(store, repo);
      return toolResult(result);
    }
    case 'get_repo': {
      const repo = resolveRepo(store, String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        number,
        id: store.nextId(),
        globalId: globalId('Issue', repo.databaseId, number),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.nextSeq,
      };
      store.nextSeq += 1;
      repo.issues.set(number, issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult({ issues: issues.map((i) => issueJson(store, repo, i)) });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      let head = String(args.head);
      let base = String(args.base);
      if (head.includes(':')) head = head.split(':').pop()!;
      if (base.includes(':')) base = base.split(':').pop()!;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('Invalid head or base branch');
      for (const existing of repo.pulls.values()) {
        if (existing.headRef === head && existing.state === 'open') {
          return toolError('A pull request already exists');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRequest = {
        number,
        id: store.nextId(),
        globalId: globalId('PullRequest', repo.databaseId, number),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdSeq: store.nextSeq,
      };
      store.nextSeq += 1;
      repo.pulls.set(number, pull);
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = asNumber(args.pull_number);
      if (number === null) return toolError('Missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      if (!pullIsMergeable(repo, pull)) return toolError('Merge conflict');
      const result = doMerge(store, repo, pull, 'merge');
      if (!result.ok) return toolError(result.reason);
      return toolResult({ number: pull.number, merged: true, state: 'closed', sha: result.sha, ...pullJson(store, repo, pull) });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMcp(store: Store, ctx: ReqCtx): Promise<HandlerResult> {
  if (ctx.method === 'DELETE') {
    // A legacy session close: nothing is held (stateless server).
    return jsonResult(405, { message: 'Method Not Allowed' });
  }
  if (ctx.method !== 'POST') return jsonResult(405, { message: 'Method Not Allowed' });
  let body: unknown;
  try {
    body = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = body as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params as Record<string, unknown> | undefined) ?? {};

  // A JSON-RPC notification (no id): accepted, no body.
  if (id === undefined) {
    return { status: 202 };
  }

  if (method === 'server/discover') {
    return jsonResult(200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return jsonResult(200, rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
  }
  if (method === 'ping') {
    return jsonResult(200, rpcResult(id, {}));
  }
  if (method === 'tools/list') {
    return jsonResult(200, rpcResult(id, { tools: TOOLS }));
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    if (!TOOLS.some((t) => t.name === name)) {
      return jsonResult(200, rpcError(id, -32601, `Method not found: ${name}`));
    }
    const result = callTool(store, name, args);
    return jsonResult(200, rpcResult(id, result));
  }
  return jsonResult(200, rpcError(id, -32601, `Method not found: ${method}`));
}
