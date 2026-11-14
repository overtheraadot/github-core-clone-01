# github-core-clone-01 — a GitHub-compatible git forge

A standalone git forge in one Node process: git smart HTTP, REST v3,
GraphQL v4, and MCP, over one in-memory store. Standard library only —
no dependencies, no git binary, no network, no model calls. Erasable
TypeScript, runs under `node --experimental-strip-types` (Node ≥ 22.18).

Local grade: **806 / 1000** — feature 600/600 (120/120 checks), agent
200/200 (15/15 MCP), perf 6/200. See [GRADE.md](GRADE.md) for the full
check table, perf numbers, and reproduction commands.

## Run

```bash
# Trial mode (the real entry point): the env owns port 8080 and tells the
# entry when the trial is done. main.ts binds an ephemeral port, registers
# it, then polls /done and exits 0.
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts

# Standalone, for local grading (any free port):
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types \
  -e "import('./app.ts').then(m => m.startServer(34571))"

# Grade it (from the kit directory):
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:34571 --token test-token-123 [--perf]
```

`MAKEFUN_SHOP_TOKEN` is the Bearer token every surface checks; a missing
or wrong token is a 401 everywhere. Use a fresh server process per grade
run — the suite creates repos under fixed scenario names, so a second run
against the same process fails on 422 "already exists".

## Layout

| File | What it does |
|---|---|
| `main.ts` | Env lifecycle (starter, kept as-is): bind ephemeral port, POST `{port}` to `$MAKEFUN_ENV_URL/register`, poll GET `/done`, exit 0. |
| `app.ts` | node:http server: routing, REST v3, git smart HTTP, GraphQL, MCP, `X-GitHub-Request-Id` on every reply, JSON errors, keep-alive friendly. |
| `store.ts` | In-memory object store (SHA-1 blob/tree/commit/tag, packfile encode/decode with OFS/REF deltas), repo/issue/PR model, squash merge with 3-way conflict detection, REST JSON shapes, deterministic timestamps. |
| `git.ts` | pkt-line codec, v0/v2 advertisements, v2 ls-refs/fetch, v0 fetch, receive-pack; fetch planning (wants/haves/depth, shallow boundaries, deepen), fast-forward-only pushes with per-ref report-status. |
| `graphql.ts` | Small GraphQL parser + executor for the documents gh / github-mcp-server send: viewer, repository, issues/pullRequests with cursor pagination, mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), `node(id:)`, `__type` introspection, batched operations, unknown-field errors. |
| `mcp.ts` | MCP JSON-RPC 2.0 Streamable HTTP: `server/discover` (2026-07-28), legacy `initialize` fallback, 8 tools (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request, list_pull_requests, get_issue) acting on the same store as REST. |
| `scenario.ts` | Derives the scenario viewer's login (`adaiversen`) from the fixed scenario seed, so repos are owned by the login the token names. |
| `package.json`, `tsconfig.json`, `LICENSE` | MIT; `npm run check` verifies the modules load; `npm start` runs main.ts. |

## Design notes

- **One store, four surfaces.** REST, GraphQL, MCP, and git all read and
  write the same `Store`; ids are stable across surfaces (global ids are
  base64 `kind:key`, never a bare database id).
- **Real git, not a facade.** Objects are content-addressed by SHA-1;
  packs are encoded/decoded with real zlib streams and delta resolution;
  fetch honours haves (a client that holds everything gets an empty
  pack) and shallow boundaries (a deepen delivers exactly one more
  generation — the held set stops at the shallow boundary, it does not
  assume the client holds the boundary's ancestors).
- **Fast-forward only.** A push whose new tip does not descend from the
  ref's current tip is refused per-ref with reason `non-fast-forward`;
  the ref is unmoved and other refs in a mixed push still apply.
- **GitHub-compatible quirks that mattered.** The contents API takes
  `branch` in the JSON body (not only `?branch=`); the v2 fetch argument
  is `deepen N`, not `depth N`; `Link rel="next"` must be an absolute
  URL on the entry's origin; pull `head.sha`/`base.sha` track the
  current branch tips; commit messages in REST carry no trailing
  newline; PR files diff merge-base vs head, not base-tip vs head.
- **Perf.** Hot paths are Map lookups with no scans; the FF check
  early-exits on the immediate parent. Local perf is bounded by this
  sandbox's loaded CPU (a bare node:http server measures ~1.1 ms/req
  here vs ~0.45 ms implied by T_ref on the quiet calibration rig), so
  local perf points understate the trial-pod result.
