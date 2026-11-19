// rest.ts — GitHub REST v3: repositories, branches, commits, contents,
// labels, issues, comments, pull requests, merges. One shared in-memory
// store (store.ts); one issue/PR number counter per repo.

import {
  FIXED_ISO,
  FIXED_TS,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildCommit,
  buildTreeFromFiles,
  diffTrees,
  flattenTree,
  globalId,
  listCommits,
  mergeBase,
  objectId,
  parseCommit,
  parseTree,
  resolveRef,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { errorResult, jsonResult, type HandlerResult, type ReqCtx } from './types.ts';

// ---------------------------------------------------------------------------------------------------------
// Shapes (the JSON the checks read)
// ---------------------------------------------------------------------------------------------------------

function ownerJson(store: Store): { login: string; id: number; type: string } {
  return { login: store.tokenOwner, id: VIEWER_ID, type: 'User' };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${store.tokenOwner}/${repo.name}`,
    owner: ownerJson(store),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000' })),
    user: { login: store.tokenOwner, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${store.tokenOwner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${store.tokenOwner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: store.tokenOwner, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyRecord(ctx: ReqCtx): Record<string, unknown> | null {
  return isRecord(ctx.json) ? ctx.json : null;
}

/** Resolve /repos/{owner}/{name}: 404 when the repo is absent or belongs to another owner. */
function resolveRepo(store: Store, ctx: ReqCtx, owner: string, name: string): Repo | null {
  const repo = store.getRepo(name);
  if (!repo) return null;
  if (owner === store.tokenOwner) {
    store.learnOwner(owner);
    return repo;
  }
  return null;
}

/** Parse ?page=&per_page= (defaults 1 / 30). */
function pageParams(ctx: ReqCtx): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPageRaw = parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

/** Paginate a list and build GitHub's Link header (absolute URLs). */
function paginate<T>(ctx: ReqCtx, items: T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(ctx);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `http://${ctx.host}${ctx.pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: pageItems, link: links.length > 0 ? links.join(', ') : null };
}

function withLink(ctx: ReqCtx, items: unknown[]): HandlerResult {
  const { page, link } = paginate(ctx, items);
  return jsonResult(200, page, link ? { Link: link } : undefined);
}

function authorLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_TS} +0000`;
}

/** Create a commit on a branch from a flat file map (replaces the branch tip). */
function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
  parents: string[],
): string {
  const put = (type: 'tree' | 'blob' | 'commit' | 'tag', data: Buffer): string => {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  };
  const treeOid = buildTreeFromFiles(files, put);
  const { data, oid } = buildCommit(treeOid, parents, authorLine(), authorLine(), message);
  put('commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.packCache.clear();
  void store;
  return oid;
}

/** The flat file map of a branch tip (empty when unborn). */
function filesOfBranch(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(commit.data).tree);
}

/** Mergeability of a PR head into its base tip (three-way conflict test). */
function isMergeable(repo: Repo, pull: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return false;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!headTip) return false;
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return true; // unrelated histories: git still merges (no common ancestor)
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanges = diffTrees(repo, baseTree, baseTipTree);
  const baseChanged = new Map(baseChanges.map((c) => [c.path, c.newOid]));
  for (const change of headChanges) {
    if (baseChanged.has(change.path) && baseChanged.get(change.path) !== change.newOid) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------------------

export async function handleRest(store: Store, ctx: ReqCtx): Promise<HandlerResult> {
  const seg = ctx.segments; // after /api/v3
  const method = ctx.method;

  // GET /api/v3/ — the API root.
  if (seg.length === 0) {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, { current_user_url: `http://${ctx.host}/api/v3/user`, rate_limit_url: `http://${ctx.host}/api/v3/rate_limit` }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user — the token owner. POST /api/v3/user/repos — create.
  if (seg.length >= 1 && seg[0] === 'user') {
    if (seg.length === 1 && method === 'GET') {
      return jsonResult(200, { login: store.tokenOwner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'POST') return createRepo(store, ctx);
      if (method === 'GET') return withLink(ctx, store.listRepos().map((r) => repoJson(store, r)));
      return errorResult(404, 'Not Found');
    }
    return errorResult(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1];
    const name = seg[2];
    const rest = seg.slice(3);
    const repo = resolveRepo(store, ctx, owner, name);
    if (!repo) return errorResult(404, 'Not Found');
    if (rest.length === 0) {
      if (method === 'GET') return jsonResult(200, repoJson(store, repo));
      if (method === 'PATCH') return patchRepo(store, ctx, repo);
      if (method === 'DELETE') {
        store.deleteRepo(name);
        return { status: 204 };
      }
      return errorResult(404, 'Not Found');
    }
    const [head, ...tail] = rest;
    if (head === 'branches') return handleBranches(store, ctx, repo, tail);
    if (head === 'commits') return handleCommits(store, ctx, repo);
    if (head === 'git') return handleGitData(store, ctx, repo, tail);
    if (head === 'contents') return handleContents(store, ctx, repo, tail);
    if (head === 'labels') return handleLabels(store, ctx, repo);
    if (head === 'issues') return handleIssues(store, ctx, repo, tail);
    if (head === 'pulls') return handlePulls(store, ctx, repo, tail);
    return errorResult(404, 'Not Found');
  }

  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------------------------

function createRepo(store: Store, ctx: ReqCtx): HandlerResult {
  if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
  const body = bodyRecord(ctx);
  const name = body?.name;
  if (typeof name !== 'string' || name === '') return errorResult(422, 'Repository name is required');
  if (store.getRepo(name)) return errorResult(422, `Repository ${name} already exists`);
  const repo = store.createRepo(
    name,
    typeof body?.description === 'string' ? body.description : '',
    body?.private === true,
  );
  return jsonResult(201, repoJson(store, repo));
}

function patchRepo(store: Store, ctx: ReqCtx, repo: Repo): HandlerResult {
  if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
  const body = bodyRecord(ctx);
  if (body && typeof body.description === 'string') repo.description = body.description;
  return jsonResult(200, repoJson(store, repo));
}

// ---------------------------------------------------------------------------------------------------------
// Branches / commits / git data
// ---------------------------------------------------------------------------------------------------------

function handleBranches(store: Store, ctx: ReqCtx, repo: Repo, tail: string[]): HandlerResult {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
    return withLink(ctx, branches);
  }
  const branch = tail.join('/');
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return errorResult(404, 'Not Found');
  if (method !== 'GET') return errorResult(404, 'Not Found');
  return jsonResult(200, { name: branch, commit: { sha: oid } });
}

function handleCommits(store: Store, ctx: ReqCtx, repo: Repo): HandlerResult {
  if (ctx.method !== 'GET') return errorResult(404, 'Not Found');
  const shaParam = ctx.query.get('sha');
  const tip = shaParam
    ? repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null)
    : resolveRef(repo, 'HEAD');
  if (!tip) return withLink(ctx, []);
  const commits = listCommits(repo, tip).map((c) => ({
    sha: c.sha,
    commit: { message: c.message.replace(/\n$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
  }));
  return withLink(ctx, commits);
}

function handleGitData(store: Store, ctx: ReqCtx, repo: Repo, tail: string[]): HandlerResult {
  const method = ctx.method;
  // POST /git/refs — create a branch ref.
  if (tail.length === 1 && tail[0] === 'refs') {
    if (method === 'POST') {
      if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
      const body = bodyRecord(ctx);
      const ref = body?.ref;
      const sha = body?.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string') {
        return errorResult(422, 'Invalid ref');
      }
      if (repo.refs.has(ref)) return errorResult(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') return errorResult(422, 'Invalid sha');
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      return jsonResult(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      const refs = [...repo.refs.keys()].sort().map((name) => {
        const oid = repo.refs.get(name)!;
        const type = repo.objects.get(oid)?.type ?? 'commit';
        return { ref: name, object: { sha: oid, type } };
      });
      return jsonResult(200, refs);
    }
    return errorResult(404, 'Not Found');
  }
  // GET /git/refs/{ref...} — one ref (heads, tags, ...).
  if (tail.length >= 2 && tail[0] === 'refs') {
    const ref = tail.join('/');
    const oid = repo.refs.get(ref);
    if (!oid) return errorResult(404, 'Not Found');
    if (method !== 'GET') return errorResult(404, 'Not Found');
    const type = repo.objects.get(oid)?.type ?? 'commit';
    return jsonResult(200, { ref, object: { sha: oid, type } });
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------------------

function handleContents(store: Store, ctx: ReqCtx, repo: Repo, tail: string[]): HandlerResult {
  const method = ctx.method;
  const path = tail.join('/');
  const refParam = ctx.query.get('ref');
  const branch = refParam && repo.refs.has(`refs/heads/${refParam}`) ? refParam : repo.defaultBranch;
  if (method === 'GET') return getContents(store, ctx, repo, path, branch, refParam);
  if (method === 'PUT') return putContents(store, ctx, repo, path);
  if (method === 'DELETE') return deleteContents(store, ctx, repo, path);
  return errorResult(404, 'Not Found');
}

function getContents(store: Store, ctx: ReqCtx, repo: Repo, path: string, branch: string, refParam: string | null): HandlerResult {
  // A ref may also be a bare commit oid.
  let tip: string | null = null;
  if (refParam && repo.objects.has(refParam)) tip = refParam;
  else tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (!tip) return errorResult(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return errorResult(404, 'Not Found');
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(repo, tree);
  if (path === '') {
    // Root listing.
    const entries = listDirectory(repo, tree, '');
    return jsonResult(200, entries);
  }
  const file = flat.get(path);
  if (file) {
    const blob = repo.objects.get(file.oid);
    const data = blob ? blob.data : Buffer.alloc(0);
    return jsonResult(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: file.oid,
      size: data.length,
      name: path.split('/').pop(),
      path,
    });
  }
  // Directory?
  const entries = listDirectory(repo, tree, path);
  if (entries.length === 0) return errorResult(404, 'Not Found');
  return jsonResult(200, entries);
}

function listDirectory(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  // Walk to the directory's tree, then list its direct children.
  let current = treeOid;
  if (dirPath !== '') {
    const segments = dirPath.split('/');
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return [];
      const entry = parseTree(object.data).find((e) => e.name === segment && e.mode === '40000');
      if (!entry) return [];
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      sha: entry.oid,
    }));
}

function putContents(store: Store, ctx: ReqCtx, repo: Repo, path: string): HandlerResult {
  if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
  const body = bodyRecord(ctx);
  if (!body || typeof body.message !== 'string' || typeof body.content !== 'string') {
    return errorResult(422, 'message and content are required');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    // Create the branch from the default branch tip (or unborn).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip) {
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const files = filesOfBranch(repo, branch);
  const existing = files.get(path);
  const content = Buffer.from(body.content, 'base64');
  const blobOid = objectId('blob', content);
  if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
  if (existing) {
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      return errorResult(409, 'sha does not match the current file');
    }
    files.set(path, { oid: blobOid, mode: existing.mode });
    const commitOid = commitFiles(store, repo, branch, files, body.message, tip ? [tip] : []);
    return jsonResult(200, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid },
    });
  }
  if (typeof body.sha === 'string') return errorResult(422, 'sha does not match any existing file');
  files.set(path, { oid: blobOid, mode: '100644' });
  const commitOid = commitFiles(store, repo, branch, files, body.message, tip ? [tip] : []);
  return jsonResult(201, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitOid },
  });
}

function deleteContents(store: Store, ctx: ReqCtx, repo: Repo, path: string): HandlerResult {
  if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
  const body = bodyRecord(ctx);
  if (!body || typeof body.message !== 'string') return errorResult(422, 'message is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return errorResult(404, 'Not Found');
  const files = filesOfBranch(repo, branch);
  const existing = files.get(path);
  if (!existing) return errorResult(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== existing.oid) {
    return errorResult(409, 'sha does not match the current file');
  }
  files.delete(path);
  const commitOid = commitFiles(store, repo, branch, files, body.message, [tip]);
  return jsonResult(200, { commit: { sha: commitOid } });
}

// ---------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------

function handleLabels(store: Store, ctx: ReqCtx, repo: Repo): HandlerResult {
  const method = ctx.method;
  if (method === 'GET') {
    return jsonResult(200, [...repo.labels.values()].map(labelJson));
  }
  if (method === 'POST') {
    if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
    const body = bodyRecord(ctx);
    const name = body?.name;
    if (typeof name !== 'string' || name === '') return errorResult(422, 'Label name is required');
    if (repo.labels.has(name)) return errorResult(422, 'Label already exists');
    const label = { name, color: typeof body?.color === 'string' ? body.color : '000000' };
    repo.labels.set(name, label);
    return jsonResult(201, labelJson(label));
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------------------
// Issues + comments
// ---------------------------------------------------------------------------------------------------------

function handleIssues(store: Store, ctx: ReqCtx, repo: Repo, tail: string[]): HandlerResult {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      return withLink(ctx, issues.map((i) => issueJson(store, repo, i)));
    }
    if (method === 'POST') {
      if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
      const body = bodyRecord(ctx);
      const title = body?.title;
      if (typeof title !== 'string' || title === '') return errorResult(422, 'Title is required');
      const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]) : [];
      for (const label of labels) {
        if (typeof label !== 'string' || !repo.labels.has(label)) {
          return errorResult(422, `Unknown label: ${String(label)}`);
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        number,
        id: store.nextId(),
        globalId: globalId('Issue', repo.databaseId, number),
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        state: 'open',
        labels: labels as string[],
        comments: [],
        createdSeq: store.nextSeq,
      };
      store.nextSeq += 1;
      repo.issues.set(number, issue);
      return jsonResult(201, issueJson(store, repo, issue));
    }
    return errorResult(404, 'Not Found');
  }
  const number = parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return errorResult(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return errorResult(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return jsonResult(200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
      const body = bodyRecord(ctx);
      if (body) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      }
      return jsonResult(200, issueJson(store, repo, issue));
    }
    return errorResult(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      return jsonResult(200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt, user: { login: store.tokenOwner, id: VIEWER_ID } })));
    }
    if (method === 'POST') {
      if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
      const body = bodyRecord(ctx);
      const commentBody = body?.body;
      if (typeof commentBody !== 'string' || commentBody === '') return errorResult(422, 'Comment body is required');
      const comment = { id: store.nextId(), body: commentBody, createdAt: FIXED_ISO };
      issue.comments.push(comment);
      return jsonResult(201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: store.tokenOwner, id: VIEWER_ID } });
    }
    return errorResult(404, 'Not Found');
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------------------

function handlePulls(store: Store, ctx: ReqCtx, repo: Repo, tail: string[]): HandlerResult {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state');
      let pulls = [...repo.pulls.values()];
      if (state === 'all') {
        // open + merged/closed
      } else if (state === 'closed') {
        pulls = pulls.filter((p) => p.state === 'closed');
      } else {
        pulls = pulls.filter((p) => p.state === 'open');
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      return withLink(ctx, pulls.map((p) => pullJson(store, repo, p)));
    }
    if (method === 'POST') return createPull(store, ctx, repo);
    return errorResult(404, 'Not Found');
  }
  const number = parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return errorResult(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return errorResult(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return jsonResult(200, pullJson(store, repo, pull));
    return errorResult(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, pullFiles(repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return errorResult(404, 'Not Found');
    return mergePull(store, ctx, repo, pull);
  }
  return errorResult(404, 'Not Found');
}

function createPull(store: Store, ctx: ReqCtx, repo: Repo): HandlerResult {
  if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
  const body = bodyRecord(ctx);
  const title = body?.title;
  let head = body?.head;
  let base = body?.base;
  if (typeof title !== 'string' || title === '' || typeof head !== 'string' || typeof base !== 'string') {
    return errorResult(422, 'title, head and base are required');
  }
  // Fork-style "owner:branch" is accepted; the branch is what matters.
  if (head.includes(':')) head = head.split(':').pop()!;
  if (base.includes(':')) base = base.split(':').pop()!;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return errorResult(422, 'Invalid head or base branch');
  for (const existing of repo.pulls.values()) {
    if (existing.headRef === head && existing.state === 'open') {
      return errorResult(422, 'A pull request already exists');
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRequest = {
    number,
    id: store.nextId(),
    globalId: globalId('PullRequest', repo.databaseId, number),
    title,
    body: typeof body?.body === 'string' ? body.body : '',
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
  return jsonResult(201, pullJson(store, repo, pull));
}

function pullFiles(repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const base = mergeBase(repo, pull.baseSha, pull.headSha);
  const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
  const headCommit = repo.objects.get(pull.headSha);
  const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : null;
  return diffTrees(repo, baseTree, headTree).map((c) => ({
    filename: c.path,
    status: c.status,
    additions: c.additions,
    deletions: c.deletions,
    changes: c.changes,
  }));
}

/** The merge core (REST, GraphQL and MCP share it). */
export function doMerge(
  store: Store,
  repo: Repo,
  pull: PullRequest,
  method: string,
): { ok: true; sha: string; message: string } | { ok: false; reason: string } {
  if (pull.state === 'closed') return { ok: false, reason: 'Pull request is already closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { ok: false, reason: 'Not Found' };
  if (!isMergeable(repo, pull)) return { ok: false, reason: 'Merge conflict' };
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  // The merged tree: the base tip's files plus the head side's changes.
  const mergedFiles = flattenTree(repo, baseTipTree);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    if (change.status === 'deleted') mergedFiles.delete(change.path);
    else if (change.newOid) mergedFiles.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  const normalized = method === 'squash' ? 'squash' : 'merge';
  const message =
    normalized === 'squash'
      ? `${pull.title} (#${pull.number})`
      : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const parents = normalized === 'squash' ? [baseTip] : [baseTip, headTip];
  const mergeCommit = commitFiles(store, repo, pull.baseRef, mergedFiles, message, parents);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeCommit;
  return { ok: true, sha: mergeCommit, message };
}

function mergePull(store: Store, ctx: ReqCtx, repo: Repo, pull: PullRequest): HandlerResult {
  if (ctx.jsonError) return errorResult(400, 'Problems parsing JSON');
  const body = bodyRecord(ctx);
  const method = typeof body?.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
  const result = doMerge(store, repo, pull, method);
  if (!result.ok) {
    if (result.reason === 'Not Found') return errorResult(404, 'Not Found');
    return errorResult(405, result.reason);
  }
  return jsonResult(200, { sha: result.sha, merged: true, message: result.message });
}

// Re-exported for the GraphQL/MCP layers (same store, same rules).
export { isMergeable as pullIsMergeable };
export function repoFilesOfBranch(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  return filesOfBranch(repo, branch);
}
export function commitFilesOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
  parents: string[],
): string {
  return commitFiles(store, repo, branch, files, message, parents);
}
export { pullJson, issueJson, repoJson, ownerJson };
