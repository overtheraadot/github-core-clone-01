// app.ts — the HTTP server: routing, bearer auth, request ids, JSON bodies.
// The handlers (rest / graphql / mcp / git) own the semantics; this file
// owns the socket. Every reply is application/json (or a git content type)
// with a non-empty X-GitHub-Request-Id, including 401s and 404s.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Repo } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  RECEIVE_V0_CAPS,
  UPLOAD_V0_CAPS,
  advertisementV0,
  advertisementV2,
  applyPush,
  fetchResponseV0,
  fetchResponseV2,
  lsRefsV2,
  parseReceivePackBody,
  parseUploadPackV0,
  parseUploadPackV2,
  pushReportResponse,
  readPack,
} from './git.ts';
import type { HandlerResult, ReqCtx } from './types.ts';

// -- response writers ---------------------------------------------------------------------------

function writeResult(res: ServerResponse, requestId: string, result: HandlerResult, contentType = 'application/json'): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...(result.headers ?? {}),
  };
  if (result.raw !== undefined) {
    if (contentType) headers['content-type'] = contentType;
    headers['content-length'] = String(result.raw.length);
    res.writeHead(result.status, headers);
    res.end(result.raw);
    return;
  }
  if (result.status === 204 || result.status === 202) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  const body = JSON.stringify(result.body ?? {});
  if (contentType) headers['content-type'] = contentType;
  headers['content-length'] = String(Buffer.byteLength(body));
  res.writeHead(result.status, headers);
  res.end(body);
}

function writeJson(res: ServerResponse, requestId: string, status: number, body: unknown): void {
  writeResult(res, requestId, { status, body });
}

// -- git route handlers -------------------------------------------------------------------------

function handleInfoRefs(res: ServerResponse, requestId: string, ctx: ReqCtx, repo: Repo): void {
  if (ctx.method !== 'GET') {
    writeJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  const service = ctx.query.get('service') ?? '';
  if (service === 'git-receive-pack') {
    writeResult(res, requestId, { status: 200, raw: advertisementV0('git-receive-pack', repo, RECEIVE_V0_CAPS) }, 'application/x-git-receive-pack-advertisement');
    return;
  }
  if (service !== 'git-upload-pack') {
    writeJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    writeResult(res, requestId, { status: 200, raw: advertisementV2() }, 'application/x-git-upload-pack-advertisement');
  } else {
    writeResult(res, requestId, { status: 200, raw: advertisementV0('git-upload-pack', repo, UPLOAD_V0_CAPS) }, 'application/x-git-upload-pack-advertisement');
  }
}

function handleUploadPack(res: ServerResponse, requestId: string, ctx: ReqCtx, repo: Repo): void {
  if (ctx.method !== 'POST') {
    writeJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
  try {
    if (isV2) {
      const parsed = parseUploadPackV2(ctx.rawBody);
      if (parsed.command === 'ls-refs') {
        writeResult(res, requestId, { status: 200, raw: lsRefsV2(repo, parsed.prefixes, parsed.peel, parsed.symrefs, parsed.unborn) }, 'application/x-git-upload-pack-result');
        return;
      }
      if (parsed.command === 'fetch' && parsed.fetch) {
        writeResult(res, requestId, { status: 200, raw: fetchResponseV2(repo, parsed.fetch) }, 'application/x-git-upload-pack-result');
        return;
      }
      writeJson(res, requestId, 400, { message: `unknown git-upload-pack command ${JSON.stringify(parsed.command)}` });
      return;
    }
    const fetch = parseUploadPackV0(ctx.rawBody);
    writeResult(res, requestId, { status: 200, raw: fetchResponseV0(repo, fetch) }, 'application/x-git-upload-pack-result');
  } catch (err) {
    writeJson(res, requestId, 400, { message: err instanceof Error ? err.message : String(err) });
  }
}

function handleReceivePack(res: ServerResponse, requestId: string, ctx: ReqCtx, repo: Repo): void {
  if (ctx.method !== 'POST') {
    writeJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  try {
    const { commands, pack } = parseReceivePackBody(ctx.rawBody);
    let packObjects: Array<{ oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> = [];
    if (pack.length > 0) {
      try {
        packObjects = readPack(pack, (oid) => repo.objects.get(oid));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const outcome = {
          unpackOk: false,
          unpackDetail: detail,
          refs: commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack error' })),
        };
        writeResult(res, requestId, { status: 200, raw: pushReportResponse(outcome) }, 'application/x-git-receive-pack-result');
        return;
      }
    }
    const outcome = applyPush(repo, commands, packObjects);
    writeResult(res, requestId, { status: 200, raw: pushReportResponse(outcome) }, 'application/x-git-receive-pack-result');
  } catch (err) {
    writeJson(res, requestId, 400, { message: err instanceof Error ? err.message : String(err) });
  }
}

// -- the server ---------------------------------------------------------------------------------

export function createApp(): { server: Server; store: Store } {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': `req-${requestCounter}` });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      } catch {
        // The socket is already gone.
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req-${(requestCounter += 1)}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    const segments = pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }
    const ctx: ReqCtx = {
      method: req.method ?? 'GET',
      pathname,
      segments,
      query: url.searchParams,
      headers,
      host: req.headers.host ?? '127.0.0.1',
      rawBody,
      json: undefined,
      jsonError: false,
      requestId,
    };
    const send = (result: HandlerResult): void => writeResult(res, requestId, result);

    // /healthz — the boot probe, no auth.
    if (pathname === '/healthz') {
      if (ctx.method !== 'GET') return send({ status: 404, body: { message: 'Not Found' } });
      return send({ status: 200, body: { ok: true } });
    }

    // Bearer auth on every other route when a token is configured.
    if (token !== '') {
      const auth = headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) {
        return send({ status: 401, body: { message: 'Bad credentials' } });
      }
    }

    // GraphQL (POST /api/graphql; the handler parses its own raw body).
    if (pathname === '/api/graphql') {
      if (ctx.method !== 'POST') return send({ status: 404, body: { message: 'Not Found' } });
      return send(await handleGraphQL(store, ctx));
    }

    // MCP (POST/DELETE /mcp; the handler parses its own raw body).
    if (pathname === '/mcp') {
      return send(await handleMcp(store, ctx));
    }

    // REST v3 (JSON bodies parsed here; a malformed body is a 400).
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (rawBody.length > 0) {
        try {
          ctx.json = JSON.parse(rawBody.toString('utf8'));
        } catch {
          ctx.jsonError = true;
        }
      }
      const restCtx: ReqCtx = { ...ctx, segments: segments.slice(2) };
      return send(await handleRest(store, restCtx));
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
    const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const service = gitMatch[3];
      const repo = store.getRepo(repoName);
      if (!repo || owner !== store.tokenOwner) {
        return send({ status: 404, body: { message: 'Not Found' } });
      }
      store.learnOwner(owner);
      if (service === 'info/refs') return handleInfoRefs(res, requestId, ctx, repo);
      if (service === 'git-upload-pack') return handleUploadPack(res, requestId, ctx, repo);
      return handleReceivePack(res, requestId, ctx, repo);
    }

    return send({ status: 404, body: { message: 'Not Found' } });
  }

  return { server, store };
}
