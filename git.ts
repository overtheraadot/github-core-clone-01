// git.ts — git smart HTTP: pkt-line framing, packfile read/write (no deltas),
// v2/v0 advertisements, ls-refs, fetch (v2 + v0, shallow/deepen), receive-pack.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  reachable,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

export const AGENT = 'makefun-forge/1.0.0';
export const PKT_LINE_MAX = 65520;

// ---------------------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer; // for 'data' only (without the 4-byte length)
}

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed first length (the malformed-POST check). */
export function decodePktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`not a pkt-line: ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return packets;
}

/** Encode data pkt-lines from strings/buffers. */
export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Split a sideband payload into band-1 packets (max 65515 data bytes each). */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 5; // 4 length + 1 band
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    out.push(pktLine(payload));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
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

import { createHash } from 'node:crypto';
function sha1Of(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Build a version-2 pack with no deltas. Entries sorted by oid (deterministic). */
export function writePack(objects: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const list = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const checksum = Buffer.from(sha1Of(body), 'hex');
  return Buffer.concat([body, checksum]);
}

/** The 32-byte empty pack (header + count 0 + trailer). */
export function emptyPack(): Buffer {
  return writePack([]);
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/** Parse a packfile. Resolves OFS/REF deltas against objects in the same pack or `lookup`. */
export function readPack(buf: Buffer, lookup?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Trailer check.
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const expected = sha1Of(buf.subarray(0, buf.length - 20));
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    let byte = buf[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType | null = CODE_TYPE[typeCode] ?? null;
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeCode === 6) {
      // OFS_DELTA: offset varint.
      byte = buf[offset++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - base;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!type) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const consumed = zlibConsumed(buf.subarray(offset), size);
    const inflated = inflateSync(buf.subarray(offset, offset + consumed));
    offset += consumed;
    let data = inflated;
    if (typeCode === 6 || typeCode === 7) {
      let base: PackEntry | undefined;
      if (baseOffset >= 0) base = byOffset.get(baseOffset);
      else if (baseOid) {
        base = entries.find((e) => e.oid === baseOid);
        if (!base && lookup) {
          const found = lookup(baseOid);
          if (found) base = { oid: baseOid, type: found.type, data: found.data };
        }
      }
      if (!base) throw new Error('delta base not found');
      data = applyDelta(base.data, inflated);
      type = base.type;
    }
    const oid = objectId(type!, data);
    const entry: PackEntry = { oid, type: type!, data };
    entries.push(entry);
    byOffset.set(entryStart, entry);
  }
  return entries;
}

/**
 * Bytes a zlib stream starting at `buf` consumes. inflateSync ignores trailing
 * garbage and throws on a truncated stream, so "inflates to exactly
 * `expectedLength` bytes" is monotonic in the prefix length: binary-search
 * the smallest prefix that does.
 */
function zlibConsumed(buf: Buffer, expectedLength: number): number {
  let low = 1;
  let high = buf.length;
  let answer = -1;
  const ok = (end: number): boolean => {
    try {
      return inflateSync(buf.subarray(0, end)).length === expectedLength;
    } catch {
      return false;
    }
  };
  if (!ok(high)) throw new Error('zlib stream never terminated');
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ok(mid)) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (answer < 0) throw new Error('zlib stream never terminated');
  return answer;
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Advertisement + ls-refs + fetch + receive-pack (pure functions over a Repo)
// ---------------------------------------------------------------------------------------------------------

export interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs a client may see, HEAD first, then sorted. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (headOid) {
    out.push({ name: 'HEAD', oid: headOid, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object && object.type === 'tag') peeled = peelToCommit(repo, oid);
    out.push({ name, oid, peeled });
  }
  return out;
}

/** v2 upload-pack advertisement body. */
export function advertisementV2(): Buffer {
  const lines = [
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ];
  return encodePktLines(lines);
}

/** v0 advertisement body for a service. `caps` is the space-joined capability list. */
export function advertisementV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, caps: string): Buffer {
  const refs = listRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // First ref line carries the capabilities after NUL. HEAD is first.
    const [first, ...rest] = refs;
    const firstLine = first.unborn
      ? `${ZERO_OID} capabilities^{}\0${caps}\n`
      : `${first.oid} ${first.name}\0${caps}\n`;
    parts.push(pktLine(firstLine));
    for (const ref of rest) {
      if (ref.unborn) continue;
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
    // An unborn HEAD with existing refs cannot happen (HEAD follows the default branch).
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export const UPLOAD_V0_CAPS =
  `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`;
export const RECEIVE_V0_CAPS =
  `report-status report-status-v2 side-band-64k delete-refs thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`;

/** v2 ls-refs response. Prefixes filter server-side; HEAD is included only when it matches (or no filter). */
export function lsRefsV2(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const refs = listRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (!unborn) continue;
      lines.push(`unborn ${ref.name} symref-target:${ref.symrefTarget}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const parts = [encodePktLines(lines), PKT_FLUSH];
  return Buffer.concat(parts);
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/**
 * Compute a fetch: the pack objects, shallow/unshallow boundary lists, and the ack lines.
 * `objects` is the set of new objects to send (already minus the haves' closure).
 */
export function computeFetch(
  repo: Repo,
  req: FetchRequest,
): { objects: PackEntry[]; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean } {
  const depth = req.depth;
  const wanted = reachable(repo, req.wants, depth ?? undefined);
  // The client holds its haves only up to its shallow boundaries: below a
  // boundary it holds nothing, so the ancestry under a boundary is not held.
  const held = reachable(repo, req.haves, undefined, new Set(req.shallowBoundaries));
  const send = new Set<string>();
  for (const oid of wanted.objects) {
    if (!held.objects.has(oid)) send.add(oid);
  }
  const objects: PackEntry[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object) objects.push({ oid, type: object.type, data: object.data });
  }
  // Shallow boundary: commits at distance depth-1 from the wants.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null && depth > 0) {
    for (const [oid, dist] of wanted.commitDist) {
      if (dist === depth - 1) shallow.push(oid);
    }
    for (const boundary of req.shallowBoundaries) {
      const dist = wanted.commitDist.get(boundary);
      if (dist !== undefined && dist < depth - 1) unshallow.push(boundary);
    }
  }
  // Acknowledgments: every have is a known commit -> ACK + ready; else NAK.
  let allKnown = req.haves.length > 0;
  for (const have of req.haves) {
    const object = repo.objects.get(have);
    if (!object || object.type !== 'commit') {
      allKnown = false;
      break;
    }
  }
  const acks = allKnown ? [req.haves[0]] : [];
  return { objects, shallow, unshallow, acks, nak: !allKnown };
}

/** v2 fetch response: acknowledgments / shallow-info / packfile sections, then flush. */
export function fetchResponseV2(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow, acks, nak } = computeFetch(repo, req);
  const cacheKey = packCacheKey(req);
  let pack = repo.packCache.get(cacheKey);
  if (!pack) {
    pack = writePack(objects);
    if (repo.packCache.size > 64) repo.packCache.clear();
    repo.packCache.set(cacheKey, pack);
  }
  const parts: Buffer[] = [];
  const ackLines: string[] = ['acknowledgments\n'];
  if (nak) ackLines.push('NAK\n');
  else {
    for (const ack of acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  }
  parts.push(encodePktLines(ackLines));
  parts.push(PKT_DELIM);
  if (shallow.length > 0 || unshallow.length > 0) {
    const infoLines: string[] = ['shallow-info\n'];
    for (const oid of shallow) infoLines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) infoLines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(infoLines));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLines(['packfile\n']));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK/ACK + shallow/unshallow lines, then the sideband pack, then flush. */
export function fetchResponseV0(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow, acks, nak } = computeFetch(repo, req);
  const cacheKey = packCacheKey(req);
  let pack = repo.packCache.get(cacheKey);
  if (!pack) {
    pack = writePack(objects);
    if (repo.packCache.size > 64) repo.packCache.clear();
    repo.packCache.set(cacheKey, pack);
  }
  const parts: Buffer[] = [];
  const headLines: string[] = [];
  if (nak) headLines.push('NAK\n');
  else {
    for (const ack of acks) headLines.push(`ACK ${ack}\n`);
  }
  for (const oid of shallow) headLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) headLines.push(`unshallow ${oid}\n`);
  if (headLines.length > 0) parts.push(encodePktLines(headLines));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function packCacheKey(req: FetchRequest): string {
  return [
    [...req.wants].sort().join(','),
    [...req.haves].sort().join(','),
    [...req.shallowBoundaries].sort().join(','),
    req.depth ?? '',
    req.deepenSince ?? '',
    [...req.deepenNot].sort().join(','),
  ].join('|');
}

// ---------------------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

/**
 * Apply a receive-pack: store the pack's objects FIRST, then evaluate each
 * ref update (fast-forward only). Returns the report-status outcome.
 */
export function applyPush(repo: Repo, commands: PushCommand[], packObjects: PackEntry[]): PushOutcome {
  // Store pack objects first (a refused ref still unpacks).
  for (const entry of packObjects) {
    if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
  }
  repo.packCache.clear();
  const refs: PushOutcome['refs'] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        refs.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new tip must exist in the store.
    if (!repo.objects.has(command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'unpack error: object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) {
        refs.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === null) {
      refs.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      continue;
    }
    if (command.oldOid !== current) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === current) {
      refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Fast-forward: new tip must descend from the old tip.
    const newObject = repo.objects.get(command.newOid);
    if (!newObject || newObject.type !== 'commit') {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestorOf(repo, command.oldOid, command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

function isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
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

/** The report-status stream (pkt-lined) wrapped in sideband band-1 packets, then flush. */
export function pushReportResponse(outcome: PushOutcome): Buffer {
  const lines: string[] = [`unpack ${outcome.unpackDetail}\n`];
  for (const ref of outcome.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  const report = encodePktLines([...lines, 'flush']);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, report)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * Parse a receive-pack body: command pkt-lines up to the flush, then raw pack
 * bytes. Walks the buffer by hand and STOPS at the flush: the pack bytes
 * after it are not pkt-lines and must never be decoded as such.
 */
export function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let pos = 0;
  let packStart = body.length;
  while (pos + 4 <= body.length) {
    const lenText = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`not a pkt-line: ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packStart = pos + 4;
      break;
    }
    if (len === 1) {
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > body.length) throw new Error('pkt-line length out of range');
    const payload = body.subarray(pos + 4, pos + len);
    const text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    pos += len;
  }
  return { commands, pack: body.subarray(packStart) };
}

/** Parse an upload-pack v2 request body into commands. Throws on a malformed pkt-line. */
export function parseUploadPackV2(body: Buffer): { command: string; prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean; fetch: FetchRequest | null } {
  const packets = decodePktLines(body);
  let command = '';
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const fetch: FetchRequest = {
    wants: [],
    haves: [],
    shallowBoundaries: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
  };
  let inFetch = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      inFetch = command === 'fetch';
      continue;
    }
    if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice('ref-prefix '.length));
      continue;
    }
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetch.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) fetch.deepenSince = parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) fetch.deepenNot.push(line.slice(11).trim());
    // agent=, object-format=, thin-pack, no-progress, ofs-delta, filter, done: accepted, ignored.
  }
  void inFetch;
  return { command, prefixes, peel, symrefs, unborn, fetch: command === 'fetch' ? fetch : null };
}

/** Parse an upload-pack v0 request body (want/have/shallow/deepen lines, two flush-separated sections). */
export function parseUploadPackV0(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const fetch: FetchRequest = {
    wants: [],
    haves: [],
    shallowBoundaries: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
  };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const space = rest.indexOf(' ');
      fetch.wants.push(space >= 0 ? rest.slice(0, space) : rest);
    } else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetch.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) fetch.deepenSince = parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) fetch.deepenNot.push(line.slice(11).trim());
  }
  return fetch;
}
