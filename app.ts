// Forge server: node:http, stdlib only. Routes:
//   GET  /healthz
//   /api/v3/*        REST v3 (Bearer auth, X-GitHub-Request-Id on every reply)
//   POST /api/graphql
//   POST /mcp         JSON-RPC 2.0 Streamable HTTP
//   /{owner}/{repo}.git/*   git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   everything else -> 404 JSON

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  applyPush, decodePktLines, lsRefsResponse, parseReceiveBody, planFetch,
  pushReportResponse, readPack, v0Advertisement, v0FetchResponse,
  v2Advertisement, v2FetchResponse,
} from './git.ts';
import { createIssueInRepo, createPullInRepo, executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import { callTool, toolsList } from './mcp.ts';
import { VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import {
  commentJson, commitContents, diffTrees, flattenTree, issueJson, labelJson,
  mergeBase, parseCommit, pullConflicts, pullJson, repoJson, resolveRef, squashMerge, stamp,
  store, walkCommits, ZERO_OID,
  type GitObject, type Issue, type Pull, type Repo,
} from './store.ts';

export const VERSION = '1.0.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY = 64 * 1024 * 1024;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000_000;
  return `req_${requestCounter.toString(36)}${Date.now().toString(36)}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown, extra?: Record<string, string>): void {
  const text = JSON.stringify(obj);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'X-GitHub-Request-Id': nextRequestId(),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendBinary(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
  });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? (m[1] as string) : null;
}

function authOk(req: IncomingMessage): boolean {
  if (!TOKEN) return false;
  return bearerToken(req) === TOKEN;
}

function parseJsonBody(body: Buffer | null): { ok: true; value: unknown } | { ok: false; message: string } {
  if (body === null || body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, message: 'Problems parsing JSON' };
  }
}

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) { sendError(res, 404, 'Not Found'); return null; }
  const repo = store.getRepo(owner, name);
  if (!repo) { sendError(res, 404, 'Not Found'); return null; }
  return repo;
}

/** Parse a git identity line "Name <email> 1735689601 +0000". */
function parseIdentity(raw: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (!m) return { name: raw, email: '', date: new Date(0).toISOString() };
  const ts = Number(m[3]);
  return { name: m[1] as string, email: m[2] as string, date: new Date(ts * 1000).toISOString() };
}

function commitViewJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdentity(c.author);
  const committer = parseIdentity(c.committer);
  return {
    sha: oid,
    node_id: oid,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: c.message.replace(/\n+$/, ''),
      tree: { sha: c.tree },
    },
    author: { login: VIEWER_LOGIN, id: 1000 },
    committer: { login: VIEWER_LOGIN, id: 1000 },
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

function flatFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOid, '', out);
  return out;
}

function listReposPage(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const all = store.listRepos();
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  // Link URLs must be absolute and stay on the entry's origin: clients follow
  // rel="next" verbatim and reject a URL that leaves the origin.
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const base = `${origin}/api/v3/user/repos`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  sendJson(res, 200, slice.map((r) => repoJson(r)), { Link: links.join(', ') });
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, body: Buffer | null): Promise<void> {
  const method = req.method ?? 'GET';
  if (path === '/api/v3' || path === '/api/v3/') {
    if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
    sendJson(res, 200, { current_user_url: 'https://api.github.com/user', repository_url: 'https://api.github.com/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, user' });
    return;
  }
  if (path === '/api/v3/meta') {
    if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: VERSION, git: ['127.0.0.1'], hooks: [], web: [], api: [], packages: [] });
    return;
  }
  if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }

  const json = parseJsonBody(body);
  if (!json.ok) { sendError(res, 400, json.message); return; }
  const payload = (json.value ?? {}) as Record<string, unknown>;

  // /user and /user/repos
  if (path === '/api/v3/user') {
    if (method !== 'GET') { sendError(res, 404, 'Not Found'); return; }
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, node_id: `user:${VIEWER_LOGIN}`, name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, type: 'User', html_url: `https://github.com/${VIEWER_LOGIN}`, url: 'https://api.github.com/user' });
    return;
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') { listReposPage(req, res, query); return; }
    if (method === 'POST') {
      const name = String(payload.name ?? '');
      if (!name) { sendError(res, 422, 'name is required'); return; }
      if (store.getRepo(VIEWER_LOGIN, name)) { sendError(res, 422, 'Repository already exists'); return; }
      const repo = store.createRepo(name, String(payload.description ?? ''), Boolean(payload.private ?? false));
      if (!repo) { sendError(res, 422, 'Repository already exists'); return; }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) { sendError(res, 404, 'Not Found'); return; }
  const owner = decodeURIComponent(m[1] as string);
  const repoName = decodeURIComponent(m[2] as string);
  const rest = m[3] ?? '';

  // Repo CRUD (no trailing segment).
  if (rest === '') {
    const repo = repoOr404(res, owner, repoName);
    if (!repo) return;
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      if (typeof payload.description === 'string') repo.description = payload.description;
      if (typeof payload.name === 'string' && payload.name !== repo.name && payload.name !== '') {
        store.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = payload.name;
        store.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      repo.updatedAt = stamp();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const repo = repoOr404(res, owner, repoName);
  if (!repo) return;

  const parts = rest.split('/').map((p) => decodeURIComponent(p));

  // Branches.
  if (parts[0] === 'branches') {
    if (parts.length === 1 && method === 'GET') {
      const out = [...repo.refs.keys()]
        .filter((n) => n.startsWith('refs/heads/'))
        .map((n) => n.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '' }, protected: false }));
      sendJson(res, 200, out);
      return;
    }
    if (parts.length === 2 && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${parts[1]}`);
      if (tip === undefined) { sendError(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: parts[1], commit: { sha: tip }, protected: false });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Git refs.
  if (parts[0] === 'git' && parts[1] === 'refs') {
    if (parts.length === 2 && method === 'GET') {
      const out = [...repo.refs.entries()].map(([name, oid]) => ({ ref: name, url: `https://api.github.com/repos/${owner}/${repoName}/git/refs/${name}`, object: { sha: oid, type: 'commit' } }));
      sendJson(res, 200, out);
      return;
    }
    if (parts.length >= 4 && parts[2] === 'heads' && method === 'GET') {
      const branch = parts.slice(3).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) { sendError(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      return;
    }
    if (parts.length === 2 && method === 'POST') {
      const ref = String(payload.ref ?? '');
      const sha = String(payload.sha ?? '');
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) { sendError(res, 422, 'Invalid ref or sha'); return; }
      if (repo.refs.has(ref)) { sendError(res, 422, 'Reference already exists'); return; }
      if (!repo.objects.has(sha)) { sendError(res, 422, 'Unknown object'); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, url: `https://api.github.com/repos/${owner}/${repoName}/git/refs/${ref}`, object: { sha, type: 'commit' } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Commits.
  if (parts[0] === 'commits') {
    if (parts.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam ? resolveRef(repo, shaParam) : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
      if (tip === null || tip === ZERO_OID) { sendJson(res, 200, []); return; }
      const walked = walkCommits(repo, tip);
      const out = walked.map((oid) => commitViewJson(repo, oid)).filter(Boolean);
      sendJson(res, 200, out);
      return;
    }
    if (parts.length === 2 && method === 'GET') {
      const oid = parts[1] as string;
      const obj = commitViewJson(repo, oid);
      if (!obj) { sendError(res, 404, 'Not Found'); return; }
      sendJson(res, 200, obj);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Contents.
  if (parts[0] === 'contents') {
    const filePath = parts.slice(1).join('/');
    // The branch may arrive in the JSON body (GitHub's contents API) or as a
    // ?branch= / ?ref= query parameter; the body wins when both are present.
    const bodyBranch = typeof payload.branch === 'string' ? payload.branch : null;
    const branch = bodyBranch ?? query.get('branch') ?? query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) { sendError(res, 404, 'Not Found'); return; }
      const commit = repo.objects.get(tip);
      if (!commit) { sendError(res, 404, 'Not Found'); return; }
      const flat = flatFiles(repo, parseCommit(commit.data).tree);
      if (filePath === '') {
        const names = new Set<string>();
        for (const p of flat.keys()) names.add(p.split('/')[0] as string);
        const out = [...names].sort().map((name) => {
          const isDir = [...flat.keys()].some((p) => p.startsWith(`${name}/`));
          const entry = flat.get(name);
          return { type: isDir ? 'dir' : 'file', name, path: name, sha: entry ? entry.oid : '' };
        });
        sendJson(res, 200, out);
        return;
      }
      const entry = flat.get(filePath);
      if (entry !== undefined) {
        const blob = repo.objects.get(entry.oid);
        const content = blob ? blob.data.toString('base64') : '';
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0, name: filePath.split('/').pop(), path: filePath, content, sha: entry.oid });
        return;
      }
      const prefix = `${filePath}/`;
      const children = [...flat.keys()].filter((p) => p.startsWith(prefix));
      if (children.length > 0) {
        const names = new Set<string>();
        for (const p of children) names.add(p.slice(prefix.length).split('/')[0] as string);
        const out = [...names].sort().map((name) => {
          const full = `${filePath}/${name}`;
          const isDir = children.some((p) => p.startsWith(`${full}/`));
          const child = flat.get(full);
          return { type: isDir ? 'dir' : 'file', name, path: full, sha: child ? child.oid : '' };
        });
        sendJson(res, 200, out);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const message = String(payload.message ?? 'Update file');
      const contentB64 = String(payload.content ?? '');
      let content: Buffer;
      try { content = Buffer.from(contentB64, 'base64'); } catch { sendError(res, 422, 'Invalid content encoding'); return; }
      const givenSha = typeof payload.sha === 'string' ? payload.sha : null;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      let currentSha: string | undefined;
      let existed = false;
      if (tip !== undefined) {
        const commit = repo.objects.get(tip);
        if (commit) {
          const flat = flatFiles(repo, parseCommit(commit.data).tree);
          currentSha = flat.get(filePath)?.oid;
          existed = currentSha !== undefined;
        }
      } else if (branch !== repo.defaultBranch && repo.refs.get(`refs/heads/${repo.defaultBranch}`) === undefined && repo.refs.size > 0) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (existed && givenSha !== null && givenSha !== currentSha) { sendError(res, 409, 'sha does not match'); return; }
      if (!existed && givenSha !== null) { sendError(res, 409, 'sha does not match'); return; }
      const { commitSha, contentSha } = commitContents(repo, branch, filePath, content, message);
      repo.updatedAt = stamp();
      sendJson(res, existed ? 200 : 201, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const message = String(payload.message ?? 'Delete file');
      const givenSha = typeof payload.sha === 'string' ? payload.sha : null;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) { sendError(res, 404, 'Not Found'); return; }
      const commit = repo.objects.get(tip);
      if (!commit) { sendError(res, 404, 'Not Found'); return; }
      const flat = flatFiles(repo, parseCommit(commit.data).tree);
      const currentSha = flat.get(filePath)?.oid;
      if (currentSha === undefined) { sendError(res, 404, 'Not Found'); return; }
      if (givenSha !== null && givenSha !== currentSha) { sendError(res, 409, 'sha does not match'); return; }
      const { commitSha } = commitContents(repo, branch, filePath, null, message);
      repo.updatedAt = stamp();
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Labels.
  if (parts[0] === 'labels') {
    if (method === 'POST') {
      const name = String(payload.name ?? '');
      if (!name) { sendError(res, 422, 'name is required'); return; }
      if (repo.labels.has(name)) { sendError(res, 422, 'Label already exists'); return; }
      const label = { id: repo.nextLabelId, name, color: String(payload.color ?? 'ededed'), description: String(payload.description ?? '') };
      repo.nextLabelId += 1;
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(repo, label));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Issues.
  if (parts[0] === 'issues') {
    if (parts.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        list.sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
        sendJson(res, 200, list.map((i) => issueJson(repo, i)));
        return;
      }
      if (method === 'POST') {
        const title = String(payload.title ?? '');
        if (!title) { sendError(res, 422, 'title is required'); return; }
        const labels = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) { sendError(res, 422, `Label does not exist: ${l}`); return; }
        }
        const issue = createIssueInRepo(repo, title, String(payload.body ?? ''), labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const num = Number(parts[1]);
    const issue = repo.issues.get(num);
    if (parts.length === 2) {
      if (!issue) { sendError(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        if (typeof payload.title === 'string') issue.title = payload.title;
        if (typeof payload.body === 'string') issue.body = payload.body;
        if (typeof payload.state === 'string' && (payload.state === 'open' || payload.state === 'closed')) {
          issue.state = payload.state;
          issue.closedAt = payload.state === 'closed' ? stamp() : null;
        }
        issue.updatedAt = stamp();
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (parts.length === 3 && parts[2] === 'comments') {
      if (!issue) { sendError(res, 404, 'Not Found'); return; }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue.number, c)));
        return;
      }
      if (method === 'POST') {
        const now = stamp();
        const comment = { id: repo.nextCommentId, body: String(payload.body ?? ''), createdAt: now, updatedAt: now };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(repo, issue.number, comment));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Pulls.
  if (parts[0] === 'pulls') {
    if (parts.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        sendJson(res, 200, list.map((p) => pullJson(repo, p)));
        return;
      }
      if (method === 'POST') {
        const title = String(payload.title ?? '');
        const head = String(payload.head ?? '');
        const base = String(payload.base ?? repo.defaultBranch);
        if (!title || !head) { sendError(res, 422, 'title and head are required'); return; }
        if (repo.refs.get(`refs/heads/${head}`) === undefined) { sendError(res, 422, `Head branch ${head} does not exist`); return; }
        if (repo.refs.get(`refs/heads/${base}`) === undefined) { sendError(res, 422, `Base branch ${base} does not exist`); return; }
        const dup = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
        if (dup) { sendError(res, 422, 'A pull request already exists for these branches'); return; }
        const pull = createPullInRepo(repo, title, String(payload.body ?? ''), head, base);
        if (!pull) { sendError(res, 422, 'Could not create pull request'); return; }
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const num = Number(parts[1]);
    const pull = repo.pulls.get(num);
    if (parts.length === 2) {
      if (!pull) { sendError(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
      if (method === 'PATCH') {
        if (typeof payload.title === 'string') pull.title = payload.title;
        if (typeof payload.body === 'string') pull.body = payload.body;
        if (typeof payload.state === 'string' && payload.state === 'closed' && pull.state === 'open') {
          pull.state = 'closed';
          pull.closedAt = stamp();
        }
        pull.updatedAt = stamp();
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (parts.length === 3 && parts[2] === 'files' && method === 'GET') {
      if (!pull) { sendError(res, 404, 'Not Found'); return; }
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      let files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
      if (baseTip && headTip) {
        const baseCommit = repo.objects.get(baseTip);
        const headCommit = repo.objects.get(headTip);
        if (baseCommit && headCommit) {
          // GitHub diffs merge-base vs head, not base-tip vs head: a file the
          // base gained after branching is not a PR change.
          const mb = mergeBase(repo, baseTip, headTip);
          const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : parseCommit(baseCommit.data).tree;
          files = diffTrees(repo, mbTree, parseCommit(headCommit.data).tree).map((f) => ({
            filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions,
          }));
        }
      }
      sendJson(res, 200, files);
      return;
    }
    if (parts.length === 3 && parts[2] === 'merge' && method === 'PUT') {
      if (!pull) { sendError(res, 404, 'Not Found'); return; }
      const mergeMethod = String(payload.merge_method ?? 'squash');
      if (mergeMethod !== 'squash') { sendError(res, 405, 'Only squash merge is supported'); return; }
      if (pull.state !== 'open') { sendError(res, 405, 'Pull request is not open'); return; }
      const merged = squashMerge(repo, pull);
      if (!merged) { sendError(res, 405, 'Merge conflict'); return; }
      sendJson(res, 200, { merged: true, sha: pull.mergeCommitSha, message: 'Pull request successfully merged' });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- git smart HTTP

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string, query: URLSearchParams, body: Buffer | null): Promise<void> {
  const method = req.method ?? 'GET';
  const repo = store.getRepo(owner, repoName);
  if (rest === 'info/refs') {
    if (method !== 'GET') { sendError(res, 404, 'Not Found'); return; }
    if (!repo) { sendError(res, 404, 'Not Found'); return; }
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') sendBinary(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      else sendBinary(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendBinary(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 400, 'service parameter required');
    return;
  }
  if (!repo) { sendError(res, 404, 'Not Found'); return; }
  if (rest === 'git-upload-pack') {
    if (method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
    if (!body || body.length === 0) { sendError(res, 400, 'empty request'); return; }
    const isV2 = req.headers['git-protocol'] === 'version=2';
    const decoded = decodePktLines(body);
    const first = decoded[0];
    if (!first || first.kind !== 'data' || !first.payload) { sendError(res, 400, 'bad request'); return; }
    const firstText = first.payload.toString('utf8');
    try {
      if (isV2 && firstText.startsWith('command=ls-refs')) {
        let peel = false;
        let symrefs = false;
        const prefixes: string[] = [];
        for (const item of decoded) {
          if (item.kind !== 'data' || !item.payload) continue;
          const t = item.payload.toString('utf8').trim();
          if (t === 'peel') peel = true;
          else if (t === 'symrefs') symrefs = true;
          else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
          else if (t.startsWith('ref-prefix=')) prefixes.push(t.slice('ref-prefix='.length));
        }
        sendBinary(res, 200, lsRefsResponse(repo, { peel, symrefs, prefixes }), 'application/x-git-upload-pack-result');
        return;
      }
      if (isV2 && firstText.startsWith('command=fetch')) {
        const wants: string[] = [];
        const haves: string[] = [];
        let depth: number | null = null;
        const prevShallow: string[] = [];
        for (const item of decoded) {
          if (item.kind !== 'data' || !item.payload) continue;
          const t = item.payload.toString('utf8').trim();
          if (t.startsWith('want ')) wants.push(t.slice(5));
          else if (t.startsWith('have ')) haves.push(t.slice(5));
          else if (t.startsWith('deepen ')) depth = Number(t.slice(7)) || null;
          else if (t.startsWith('depth ')) depth = Number(t.slice(6)) || null;
          else if (t.startsWith('shallow ')) prevShallow.push(t.slice(8));
        }
        const plan = planFetch(repo, wants, haves, prevShallow, depth);
        sendBinary(res, 200, v2FetchResponse(plan), 'application/x-git-upload-pack-result');
        return;
      }
      // v0 fetch: want/have/deepen lines across two sections.
      const wants: string[] = [];
      const haves: string[] = [];
      let depth: number | null = null;
      for (const item of decoded) {
        if (item.kind !== 'data' || !item.payload) continue;
        const t = item.payload.toString('utf8').trim();
        if (t.startsWith('want ')) wants.push(t.slice(5));
        else if (t.startsWith('have ')) haves.push(t.slice(5));
        else if (t.startsWith('deepen ')) depth = Number(t.slice(7)) || null;
      }
      if (wants.length === 0) { sendError(res, 400, 'no want lines'); return; }
      const plan = planFetch(repo, wants, haves, [], depth);
      sendBinary(res, 200, v0FetchResponse(plan), 'application/x-git-upload-pack-result');
      return;
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'bad request');
      return;
    }
  }
  if (rest === 'git-receive-pack') {
    if (method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
    if (!body || body.length === 0) { sendError(res, 400, 'empty request'); return; }
    const parsed = parseReceiveBody(body);
    if (parsed.malformed) { sendError(res, 400, 'malformed receive request'); return; }
    let packObjects = new Map<string, GitObject>();
    if (parsed.pack && parsed.pack.length > 0) {
      try {
        packObjects = readPack(parsed.pack, (oid) => repo.objects.get(oid));
      } catch {
        sendBinary(res, 200, pushReportResponse(false, parsed.commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack error' }))), 'application/x-git-receive-pack-result');
        return;
      }
    }
    const result = applyPush(repo, parsed.commands, packObjects);
    sendBinary(res, 200, pushReportResponse(result.unpackOk, result.lines), 'application/x-git-receive-pack-result');
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer | null): Promise<void> {
  if (req.method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
  if (!authOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
  const json = parseJsonBody(body);
  if (!json.ok) { sendError(res, 400, json.message); return; }
  if (Array.isArray(json.value)) {
    sendJson(res, 200, executeGraphQLBatch(json.value));
    return;
  }
  sendJson(res, 200, executeGraphQL(json.value));
}

// ---------------------------------------------------------------- MCP

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResponse(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer | null): Promise<void> {
  if (req.method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
  if (!authOk(req)) {
    sendJson(res, 401, rpcError(null, -32000, 'Unauthorized'));
    return;
  }
  if (!body || body.length === 0) { sendJson(res, 400, rpcError(null, -32700, 'Parse error')); return; }
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(body.toString('utf8')) as JsonRpcRequest;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.method !== 'string') {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const isNotification = parsed.id === undefined || parsed.id === null;
  const id = isNotification ? null : (parsed.id as string | number);
  const method = parsed.method;
  const params = (parsed.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const result = {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: VERSION },
      protocolVersion: '2026-07-28',
    };
    if (isNotification) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, rpcResponse(id, result));
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const result = {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: VERSION },
    };
    if (isNotification) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, rpcResponse(id, result));
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'ping') {
    if (isNotification) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, rpcResponse(id, {}));
    return;
  }
  if (method === 'tools/list') {
    if (isNotification) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, rpcResponse(id, toolsList()));
    return;
  }
  if (method === 'tools/call') {
    if (isNotification) { res.writeHead(202); res.end(); return; }
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const { result, rpcError: rpcErr } = callTool(name, args);
    if (rpcErr && (result as Record<string, unknown>).isError) {
      sendJson(res, 200, rpcError(id, rpcErr.code, rpcErr.message));
      return;
    }
    sendJson(res, 200, rpcResponse(id, result));
    return;
  }
  if (isNotification) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------- server

export function createApp(): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;
        const query = url.searchParams;
        if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
          sendJson(res, 200, { ok: true });
          return;
        }
        const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
        const body = needsBody ? await readBody(req) : null;
        if (path.startsWith('/api/v3')) {
          await handleRest(req, res, path, query, body);
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphQL(req, res, body);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res, body);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          await handleGit(req, res, owner, repoName, gitMatch[3] as string, query, body);
          return;
        }
        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
        else res.destroy();
      }
    })();
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return server;
}

export function startServer(port: number): ReturnType<typeof createServer> {
  const server = createApp();
  server.listen(port, '127.0.0.1');
  return server;
}
