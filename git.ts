// git smart HTTP: upload-pack protocol v2 (with a v0 fallback) and receive-pack
// v0, over the store in store.ts. Real object store, packfile encode/decode,
// pkt-line framing, side-band-64k, shallow fetch / deepen, fast-forward-only
// pushes with per-ref report-status.

import { createHash } from 'node:crypto';
import {
  ZERO_OID, applyDelta, hashObject, isAncestor, parseCommit, parseTag,
  parseTree, peelToCommit, putObject, readPack, writePack,
  type GitObject, type GitObjectType, type Repo,
} from './store.ts';

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into {data packets, control kinds}. */
export function decodePktLines(buf: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); offset += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); offset += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); offset += 4; continue; }
    if (len < 4 || offset + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split a decoded stream at the first flush: returns [packets before flush, rest offset]. */
export function splitAtFlush(buf: Buffer): { packets: Buffer[]; rest: Buffer } {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) return { packets, rest: buf.subarray(offset + 4) };
    if (len === 1 || len === 2) { offset += 4; continue; }
    if (len < 4 || offset + len > buf.length) break;
    packets.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** v0 ref advertisement body (with the "# service=" preamble). */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow agent=forge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (tip !== ZERO_OID) {
      parts.push(pktLine(`${tip} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      first = false;
      const obj = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(repo, ref.oid)} ${ref.name}^{}\n`));
      }
    }
    if (first) parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement body (no "# service=" preamble). */
export function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Plan a fetch: wants, haves (already held), previous shallow boundaries and an
 * optional depth. Returns the objects to send plus the new shallow boundaries.
 */
export function planFetch(repo: Repo, wants: string[], haves: string[], prevShallow: string[], depth: number | null): FetchPlan {
  // What the client already holds: the closure of its haves, but NOT past a
  // shallow boundary — a shallow clone holds the boundary commit itself, not
  // its ancestors (that is exactly what a deepen has to deliver).
  const stopAt = new Set(prevShallow);
  const held = new Set<string>();
  for (const have of haves) collectReachableBounded(repo, have, held, stopAt);
  // Commits to include, by BFS distance from the wants.
  const included = new Set<string>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const seenDist = new Map<string, number>();
  while (queue.length) {
    const [oid, dist] = queue.shift() as [string, number];
    if (seenDist.has(oid)) continue;
    seenDist.set(oid, dist);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!held.has(oid)) included.add(oid);
      queue.push([target, dist]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (held.has(oid)) {
      // Already held: not sent, but its parents are still one step further out.
      for (const p of parseCommit(obj.data).parents) queue.push([p, dist + 1]);
      continue;
    }
    if (depth !== null && dist >= depth) continue;
    included.add(oid);
    for (const p of parseCommit(obj.data).parents) queue.push([p, dist + 1]);
  }
  // Shallow boundaries: included commits whose parent is not included.
  const shallow: string[] = [];
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) { shallow.push(oid); continue; }
    if (parents.some((p) => !included.has(p) && !held.has(p))) shallow.push(oid);
    else if (parents.some((p) => !included.has(p))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const b of prevShallow) {
    const obj = repo.objects.get(b);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((p) => included.has(p) || held.has(p))) unshallow.push(b);
  }
  // Objects: included commits + their trees/blobs (+ tag objects + targets).
  const objects = new Map<string, GitObject>();
  const addReachable = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (objects.has(oid)) return;
    if (obj.type === 'commit') {
      if (!included.has(oid)) return;
      objects.set(oid, obj);
      const commit = parseCommit(obj.data);
      addTree(repo, commit.tree, objects, held);
      for (const p of commit.parents) {
        if (included.has(p)) addReachable(p);
      }
    } else if (obj.type === 'tag') {
      objects.set(oid, obj);
      addReachable(parseTag(obj.data).object);
    }
  };
  for (const w of wants) addReachable(w);
  // Also include trees/blobs of included commits reachable via tag targets etc.
  for (const oid of [...included]) {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      objects.set(oid, obj);
      addTree(repo, parseCommit(obj.data).tree, objects, held);
    }
  }
  return { objects: [...objects.values()], shallow, unshallow };
}

function addTree(repo: Repo, treeOid: string, out: Map<string, GitObject>, held: Set<string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree' || out.has(treeOid)) return;
  out.set(treeOid, obj);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') addTree(repo, e.oid, out, held);
    else if (!held.has(e.oid) && !out.has(e.oid)) {
      const blob = repo.objects.get(e.oid);
      if (blob) out.set(e.oid, blob);
    }
  }
}

function collectReachableBounded(repo: Repo, root: string, out: Set<string>, stopAt: Set<string>): void {
  const queue: string[] = [root];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      // Do not descend past a shallow boundary: the client holds the boundary
      // commit object, but not its parents.
      if (!stopAt.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    }
  }
}

function collectReachable(repo: Repo, root: string, out: Set<string>): void {
  collectReachableBounded(repo, root, out, new Set());
}

/** Sideband-wrap a pack: band-1 pkt-lines of at most 65515 payload bytes each. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** Build the v2 fetch response body for a planned fetch. */
export function v2FetchResponse(plan: FetchPlan): Buffer {
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build the v0 fetch response body for a planned fetch. */
export function v0FetchResponse(plan: FetchPlan): Buffer {
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const tip = defaultTip(repo);
  const lines: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (args.prefixes.length === 0) {
    if (tip === ZERO_OID) {
      lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      lines.push(pktLine(`${tip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (args.peel && ref.name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      line += ` peeled:${peelToCommit(repo, ref.oid)}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand { oldOid: string; newOid: string; ref: string }

export interface PushReportLine { ref: string; ok: boolean; reason: string }

/** Apply a parsed pack + command list to a repo; returns per-ref report lines. */
export function applyPush(repo: Repo, commands: PushCommand[], packObjects: Map<string, GitObject>): { unpackOk: boolean; lines: PushReportLine[] } {
  for (const [oid, obj] of packObjects) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  const lines: PushReportLine[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) { lines.push({ ref: cmd.ref, ok: false, reason: 'no such ref' }); continue; }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { lines.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' }); continue; }
      repo.refs.delete(cmd.ref);
      lines.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(cmd.newOid);
    if (!target) { lines.push({ ref: cmd.ref, ok: false, reason: 'unpack error' }); continue; }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== ZERO_OID) { lines.push({ ref: cmd.ref, ok: false, reason: 'already exists' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // Update: old must match, new must fast-forward from current.
    if (cmd.oldOid !== current) { lines.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' }); continue; }
    if (cmd.newOid === current) { lines.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
    const newCommit = peelToCommit(repo, cmd.newOid);
    const curCommit = current === ZERO_OID ? ZERO_OID : peelToCommit(repo, current);
    if (current !== ZERO_OID && !isAncestor(repo, curCommit, newCommit)) {
      lines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, lines };
}

/** report-status body, sideband-wrapped (band 1). */
export function pushReportResponse(unpackOk: boolean, lines: PushReportLine[]): Buffer {
  const items: Array<string | 'flush'> = [];
  items.push(unpackOk ? 'unpack ok\n' : 'unpack error\n');
  for (const line of lines) {
    items.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  items.push('flush');
  const report = pktLines(items as Array<string | Buffer | 'flush' | 'delim'>);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < report.length; off += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(off, Math.min(report.length, off + CHUNK))])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a receive-pack body: commands (up to the first flush) + the raw pack after it. */
export function parseReceiveBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null; malformed: boolean } {
  const { packets, rest } = splitAtFlush(body);
  const commands: PushCommand[] = [];
  for (const raw of packets) {
    let text = raw.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!m) return { commands, pack: null, malformed: true };
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  if (commands.length === 0) return { commands, pack: null, malformed: true };
  const hasUpdate = commands.some((c) => c.newOid !== ZERO_OID);
  return { commands, pack: hasUpdate ? rest : null, malformed: false };
}

export function packChecksumHex(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

export { applyDelta, readPack, writePack, hashObject };
export type { GitObject, GitObjectType };
