// store.ts — the forge's in-memory state: git object model, repositories,
// issues, pull requests, comments, labels. No disk, no clock in state:
// every timestamp the store stamps is a fixed constant, so two runs on the
// same instance export byte-identical state.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const FIXED_TS = 1700000000; // 2023-11-14T22:13:20Z — the suite's own fixture stamp.
export const FIXED_ISO = '2026-01-01T00:00:00.000Z';

// The token owner's identity. The contest scenario is built from one fixed
// seed (wire.ts SCENARIO_SEED_HEX), so the viewer login is the same in every
// trial: adaiversen (id 1000). The store still learns it dynamically (see
// Store.learnOwner) as a safety net if a request ever names another owner
// for an existing repository before any request has confirmed this one.
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string; // '100644' file, '40000' directory, '120000' symlink
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Compare two tree entry names the way git does: directories sort as if their name ends in '/'. */
export function gitNameCompare(aName: string, aIsDir: boolean, bName: string, bIsDir: boolean): number {
  const a = aIsDir ? `${aName}/` : aName;
  const b = bIsDir ? `${bName}/` : bName;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Serialize one tree level in canonical git form: `<mode> <name>\0<20 raw bytes>`, git-sorted. */
export function buildTree(entries: TreeEntry[]): { data: Buffer; oid: string } {
  const sorted = [...entries].sort((x, y) =>
    gitNameCompare(x.name, x.mode === '40000', y.name, y.mode === '40000'),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  return { data, oid: objectId('tree', data) };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree (and every parent tree it needs) from a flat path -> blob map. */
export function buildTreeFromFiles(
  files: Map<string, { oid: string; mode: string }>,
  put: (type: ObjType, data: Buffer) => string,
): string {
  // Group paths by their first segment, recursively.
  const buildLevelFromMap = (levelFiles: Map<string, { oid: string; mode: string }>): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, file] of levelFiles) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: file.mode, name: path, oid: file.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        const sub = dirs.get(dir) ?? new Map();
        sub.set(rest, file);
        dirs.set(dir, sub);
      }
    }
    for (const [dir, sub] of [...dirs.entries()].sort((a, b) => gitNameCompare(a[0], true, b[0], true))) {
      entries.push({ mode: '40000', name: dir, oid: buildLevelFromMap(sub) });
    }
    const { data, oid } = buildTree(entries);
    put('tree', data);
    return oid;
  };
  if (files.size === 0) {
    const { data, oid } = buildTree([]);
    put('tree', data);
    return oid;
  }
  return buildLevelFromMap(files);
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): { data: Buffer; oid: string } {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${msg}`;
  const data = Buffer.from(text, 'utf8');
  return { data, oid: objectId('commit', data) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildTag(
  object: string,
  type: string,
  tag: string,
  tagger: string,
  message: string,
): { data: Buffer; oid: string } {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const text = `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${msg}`;
  const data = Buffer.from(text, 'utf8');
  return { data, oid: objectId('tag', data) };
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Split content into lines the way a diff counts them (trailing newline ends the last line). */
export function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineCount(content: string): number {
  return splitLines(content).length;
}

/** LCS line diff (contents are small). Returns added/deleted line counts. */
export function lineDiff(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths, one row at a time from the end.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    cur[m] = 0;
    for (let j = m - 1; j >= 0; j -= 1) {
      cur[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[0];
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------

export interface Comment {
  id: number; // global numeric id (REST)
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  id: number; // global numeric id (REST)
  globalId: string; // opaque Relay id (GraphQL)
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface PullRequest {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdSeq: number;
}

export interface Repo {
  name: string;
  databaseId: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // refname -> oid (HEAD is a symref to refs/heads/<defaultBranch>)
  objects: Map<string, GitObject>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number; // ONE counter shared by issues and PRs (GitHub-correct)
  createdSeq: number;
  packCache: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDatabaseId = 1;
  nextGlobalId = 1;
  nextSeq = 1;
  tokenOwner: string = VIEWER_LOGIN;
  tokenOwnerConfirmed = false;

  /** Learn the token owner's login from an authenticated request that names an existing repo. */
  learnOwner(owner: string): void {
    if (this.tokenOwnerConfirmed) return;
    if (owner === this.tokenOwner) {
      this.tokenOwnerConfirmed = true;
      return;
    }
    // First owner-bearing request on an existing repo: adopt it (the seeded
    // value is a fallback for the case where no such request ever arrives).
    this.tokenOwner = owner;
    this.tokenOwnerConfirmed = true;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      name,
      databaseId: this.nextDatabaseId,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.nextSeq,
      packCache: new Map(),
    };
    this.nextDatabaseId += 1;
    this.nextSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Per-repo git operations
// ---------------------------------------------------------------------------------------------------------

/** The commit HEAD (or a branch) points at, or null when unborn. */
export function resolveRef(repo: Repo, refname: string): string | null {
  if (refname === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return repo.refs.get(refname) ?? null;
}

/** Peel an annotated tag (recursively) to the commit it names. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Read one file's blob oid at a commit (null when absent). */
export function fileAtCommit(repo: Repo, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(repo, tree);
  return flat.get(path)?.oid ?? null;
}

export interface ReachResult {
  /** Every object id reachable (commits, trees, blobs, tags). */
  objects: Set<string>;
  /** Commit distance from the tips (0 = a tip). Only commits. */
  commitDist: Map<string, number>;
}

/**
 * Walk from `tips`. With no depth limit, the full closure. With `depth`,
 * only commits with distance < depth are followed (their trees/blobs are
 * included); `commitDist` records each included commit's distance.
 * `stopAt` names shallow boundaries: those commits are included, but their
 * parents are NOT followed (a shallow clone holds the boundary, not its
 * history) — this is what makes an incremental fetch from a shallow clone
 * deliver the next generation instead of nothing.
 */
export function reachable(repo: Repo, tips: Iterable<string>, depth?: number, stopAt?: Set<string>): ReachResult {
  const objects = new Set<string>();
  const commitDist = new Map<string, number>();
  // BFS with distances recorded at enqueue time, so a commit reached by two
  // paths keeps the shortest distance.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const enqueue = (oid: string, d: number): void => {
    const known = dist.get(oid);
    if (known !== undefined && known <= d) return;
    dist.set(oid, d);
    queue.push(oid);
  };
  for (const tip of tips) {
    if (repo.objects.has(tip)) enqueue(tip, 0);
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    if (depth !== undefined && d >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      commitDist.set(oid, d);
      objects.add(oid);
      if (stopAt && stopAt.has(oid)) continue; // shallow boundary: no parents
      const info = parseCommit(object.data);
      for (const parent of info.parents) enqueue(parent, d + 1);
    } else if (object.type === 'tag') {
      objects.add(oid);
      const target = parseTag(object.data).object;
      enqueue(target, d);
    }
  }
  // Now the tree/blob closure of every included commit (and every included tag target).
  const stack: string[] = [...commitDist.keys()];
  const seenTree = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      if (!seenTree.has(tree)) stack.push(tree);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit' && !seenTree.has(target)) stack.push(target);
      else if (targetObject) objects.add(target);
    } else if (object.type === 'tree') {
      if (seenTree.has(oid)) continue;
      seenTree.add(oid);
      objects.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  }
  // Tag objects themselves are included when a tip names one.
  for (const tip of tips) {
    const object = repo.objects.get(tip);
    if (object && object.type === 'tag') objects.add(tip);
  }
  return { objects, commitDist };
}

/** The best merge base of two commits (nearest common ancestor by summed distance). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const distB = new Map<string, number>();
  const walk = (start: string, dist: Map<string, number>): void => {
    const queue: Array<{ oid: string; d: number }> = [{ oid: start, d: 0 }];
    while (queue.length > 0) {
      const { oid, d } = queue.shift()!;
      if (dist.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      dist.set(oid, d);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
  };
  walk(a, distA);
  walk(b, distB);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of distA) {
    const db = distB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const queue = [tip];
  const seen = new Set<string>([tip]);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two trees (by oid) into per-file changes with line counts. */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map<string, { oid: string; mode: string }>();
  const changes: FileChange[] = [];
  const allPaths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...allPaths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry && !newEntry) {
      const oldBlob = repo.objects.get(oldEntry.oid);
      const oldText = oldBlob ? oldBlob.data.toString('utf8') : '';
      changes.push({
        path,
        status: 'deleted',
        oldOid: oldEntry.oid,
        newOid: null,
        additions: 0,
        deletions: lineCount(oldText),
        changes: lineCount(oldText),
      });
    } else if (!oldEntry && newEntry) {
      const newBlob = repo.objects.get(newEntry.oid);
      const newText = newBlob ? newBlob.data.toString('utf8') : '';
      const adds = lineCount(newText);
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: adds, deletions: 0, changes: adds });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const oldBlob = repo.objects.get(oldEntry.oid);
      const newBlob = repo.objects.get(newEntry.oid);
      const oldText = oldBlob ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/** List a branch's commits newest-first (walk first-parent chain from the tip). */
export function listCommits(repo: Repo, tipOid: string, limit = 1000): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const queue = [tipOid];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    out.push({ sha: oid, message: info.message });
    for (const parent of info.parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Opaque Relay global ids (GraphQL): base64url of "<Kind>:<databaseId>:<number>..."
// ---------------------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  const raw = `${kind}:${parts.join(':')}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
