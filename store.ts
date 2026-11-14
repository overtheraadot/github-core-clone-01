// The forge's in-memory store: git objects, refs, repositories, issues, pull
// requests, labels and comments. One process, no persistence, no dependencies.
// All timestamps derive from a fixed base plus a monotonic counter, so two runs
// on the same requests answer the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const la = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const lb = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(la, lb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string; parents: string[]; author: string; committer: string; message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, blank < 0 ? data.length : blank).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag object (recursively) to the commit it points at. */
export function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return cur;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else return cur;
  }
  return cur;
}

/** Is `ancestor` reachable from `descendant` by following commit parents? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** First common ancestor of two commits (nearest to both, BFS by distance). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const qa: Array<[string, number]> = [[a, 0]];
  while (qa.length) {
    const [oid, d] = qa.shift() as [string, number];
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push([p, d + 1]);
  }
  const qb: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestD = Infinity;
  while (qb.length) {
    const [oid, d] = qb.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined && da + d < bestD) { best = oid; bestD = da + d; }
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push([p, d + 1]);
  }
  return best;
}

/** Flatten a tree object to path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

interface TreeNode { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, TreeNode> }

/** Build (and store) a tree from a flat file map; returns the root tree oid. */
export function treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const make = (): TreeNode => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const name = segs[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as TreeNode;
    }
    node.files.set(segs[segs.length - 1] as string, entry);
  }
  const build = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of [...node.files].sort((x, y) => (x[0] < y[0] ? -1 : 1))) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of [...node.dirs].sort((x, y) => (x[0] < y[0] ? -1 : 1))) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- packfile

function writePackHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else throw new Error('delta opcode 0');
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number; typeCode: number; size: number; data: Buffer;
  baseOffset?: number; baseOid?: string;
  resolved?: Buffer; resolvedType?: GitObjectType; oid?: string;
}

/** Parse a packfile (plain, OFS_DELTA and REF_DELTA), resolving deltas. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error('unknown pack type');
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase ? resolveBase(entry.baseOid as string) : undefined;
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------- domain model

let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
/** Deterministic-ish ISO timestamp: fixed base + sequence seconds. */
export function stamp(): string {
  return new Date((1735689600 + nextSeq()) * 1000).toISOString();
}
export function commitStamp(): number {
  return 1735689600 + nextSeq();
}

export interface Label { id: number; name: string; color: string; description: string }
export interface Comment { id: number; body: string; createdAt: string; updatedAt: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: Comment[]; seq: number;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null; seq: number;
}

export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string; seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

export class Store {
  repos = new Map<string, Repo>(); // key: owner/name
  nextRepoId = 5000;
  nextIssueId = 100000;
  nextPullId = 200000;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const owner = VIEWER_LOGIN;
    if (this.repos.has(`${owner}/${name}`)) return null;
    const now = stamp();
    const repo: Repo = {
      id: this.nextRepoId, name, owner, description, private: isPrivate,
      defaultBranch: 'main', createdAt: now, updatedAt: now, seq: nextSeq(),
      objects: new Map(), refs: new Map(), issues: new Map(), pulls: new Map(),
      labels: new Map(), nextNumber: 1, nextCommentId: 1, nextLabelId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}

export const store = new Store();

// ---------------------------------------------------------------- git helpers on a repo

export function refTip(repo: Repo, ref: string): string {
  return repo.refs.get(ref) ?? ZERO_OID;
}

export function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const ts = commitStamp();
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8'));
}

/** Commit one contents change on `branch` (creating the branch from the default tip when new). */
export function commitContents(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; contentSha: string | null } {
  const branchRef = `refs/heads/${branch}`;
  let tip = repo.refs.get(branchRef);
  if (tip === undefined) {
    // New branch: fork from the default branch tip (or start unborn).
    const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (base !== undefined) {
      repo.refs.set(branchRef, base);
      tip = base;
    }
  }
  const files = new Map<string, { oid: string; mode: string }>();
  let parents: string[] = [];
  if (tip !== undefined) {
    parents = [tip];
    const commit = repo.objects.get(tip);
    if (commit && commit.type === 'commit') flattenTree(repo, parseCommit(commit.data).tree, '', files);
  }
  let contentSha: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    contentSha = putObject(repo, 'blob', content);
    files.set(path, { oid: contentSha, mode: '100644' });
  }
  const treeOid = treeFromFiles(repo, files);
  const commitSha = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(branchRef, commitSha);
  return { commitSha, contentSha };
}

/** Resolve a ref name / sha / branch to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj && obj.type === 'tag') return peelToCommit(repo, ref);
    return null;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return head;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  return null;
}

/** Walk commits newest-first from `tip` (first-parent order is enough for the suite). */
export function walkCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

/** Diff two trees (flattened): changed paths with line counts. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseTree) flattenTree(repo, baseTree, '', base);
  if (headTree) flattenTree(repo, headTree, '', head);
  const out: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const lines = countLines(repo, b.oid);
      out.push({ path, status: 'removed', additions: 0, deletions: lines });
    } else if (!b && h) {
      const lines = countLines(repo, h.oid);
      out.push({ path, status: 'added', additions: lines, deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const [add, del] = diffLines(repo, b.oid, h.oid);
      out.push({ path, status: 'modified', additions: add, deletions: del });
    }
  }
  return out;
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

function countLines(repo: Repo, oid: string): number {
  const text = blobText(repo, oid);
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function diffLines(repo: Repo, aOid: string, bOid: string): [number, number] {
  const a = blobText(repo, aOid).split('\n');
  const b = blobText(repo, bOid).split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  // LCS on lines (files here are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return [Math.max(1, n - common), m - common];
}

/** Would squash-merging `pull` conflict? (3-way, same path changed both sides differently.) */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const baseCommit = repo.objects.get(baseTip);
  const headCommit = repo.objects.get(headTip);
  if (!baseCommit || !headCommit) return false;
  const mb = mergeBase(repo, baseTip, headTip);
  const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : '';
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const mbFiles = new Map<string, { oid: string; mode: string }>();
  const baseFiles = new Map<string, { oid: string; mode: string }>();
  const headFiles = new Map<string, { oid: string; mode: string }>();
  if (mbTree) flattenTree(repo, mbTree, '', mbFiles);
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path)?.oid ?? null;
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    if (b !== m && h !== m && b !== h) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (pullConflicts(repo, pull)) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const headCommit = repo.objects.get(headTip);
  if (!headCommit || headCommit.type !== 'commit') return null;
  const headTree = parseCommit(headCommit.data).tree;
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const mergeSha = makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp();
  pull.closedAt = pull.mergedAt;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  return mergeSha;
}

// ---------------------------------------------------------------- JSON shapes (REST v3)

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: globalId('user', repo.owner), type: 'User', avatar_url: '' },
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('label', `${repo.owner}/${repo.name}#${label.name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('user', VIEWER_LOGIN), type: 'User' },
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelJson(repo, l) : { id: 0, node_id: '', name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  // GitHub reports the CURRENT tip of each branch, not the sha at creation.
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('pr', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('user', VIEWER_LOGIN), type: 'User' },
    labels: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: !pullConflicts(repo, pull),
    mergeable_state: pull.merged ? 'unknown' : pullConflicts(repo, pull) ? 'dirty' : 'clean',
    merged_by: pull.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID } : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: `${VIEWER_LOGIN}:${pull.head}`,
      ref: pull.head,
      sha: headSha,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      repo: repoJson(repo),
    },
    base: {
      label: `${VIEWER_LOGIN}:${pull.base}`,
      ref: pull.base,
      sha: baseSha,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      repo: repoJson(repo),
    },
    author_association: 'OWNER',
    draft: false,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', `${repo.owner}/${repo.name}#${issueNumber}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('user', VIEWER_LOGIN), type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}
