# makefun-forge

A GitHub-compatible git forge in one Node process: smart-HTTP git, REST v3,
GraphQL v4 and MCP over a single in-memory store. Built fresh for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty.

## Run

```sh
# Trial (the platform runs this): binds an ephemeral port, registers with
# the env at $MAKEFUN_ENV_URL, polls /done, exits 0.
node --experimental-strip-types main.ts

# Local grading: serve without an env; the runner dials this origin.
MAKEFUN_SHOP_TOKEN=<token> PORT=18080 node --experimental-strip-types main.ts --standalone
```

Node 22+, no dependencies, standard library only (`node:http`,
`node:crypto`, `node:zlib`). The repository is mounted read-only in a
trial and the server writes nothing to disk; all state lives in memory.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entrypoint: trial lifecycle (bind → register → poll `/done`) or `--standalone` serve. |
| `app.ts` | HTTP server: routing, bearer auth, `X-GitHub-Request-Id`, JSON bodies, git routes. |
| `store.ts` | In-memory state: SHA-1 object model, canonical trees/commits, reachability, merge-base, line diffs, issues/PRs, opaque Relay ids. |
| `git.ts` | pkt-line codec, packfile read/write (version 2, no deltas), v2/v0 advertisements, ls-refs, fetch (v2 + v0, shallow/deepen), receive-pack with per-ref report-status. |
| `rest.ts` | REST v3: repos, branches, commits, contents, labels, issues, comments, pull requests, merges, git-data refs. One issue/PR number counter per repo. |
| `graphql.ts` | GraphQL v4: a small lexer/parser/executor for the documents `gh` and `github-mcp-server` send, with schema validation, introspection, batching and cursor pagination. |
| `mcp.ts` | MCP over Streamable HTTP: `server/discover` (2026-07-28) plus the legacy `initialize` handshake; six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`). |
| `types.ts` | The shared request context and handler result shapes. |

## Design notes

- **One store, four surfaces.** Git pushes, REST writes, GraphQL mutations
  and MCP tool calls all read and write the same repositories, objects,
  refs, issues and pull requests, so a fixture built on one surface reads
  back identically on the others.
- **Deterministic state.** Every timestamp the store stamps is a fixed
  constant; commit bytes pushed by a client are stored verbatim, so two
  runs on the same instance export byte-identical state.
- **The token owner.** The contest scenario is built from one fixed seed,
  so the viewer login is `adaiversen` in every trial. The server also
  learns the owner dynamically from the first authenticated request that
  names an existing repository, as a safety net. A repository read under
  any other owner is a 404, never a 403.
- **Packs.** Fetches send full packs of exactly the new objects
  (reachable from the wants minus reachable from the haves), no deltas.
  Shallow fetches include only commits closer than the depth; the boundary
  commits are reported as `shallow`, and boundaries that become fully
  included are reported as `unshallow`. Fetch packs are cached per
  (wants, haves, depth) and invalidated on any write.
- **Performance.** In-memory only, no per-request disk or crypto beyond
  SHA-1; raw `node:http` with keep-alive and explicit `Content-Length`,
  so the read workload stays on one warm connection.
