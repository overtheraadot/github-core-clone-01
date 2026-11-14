# GRADE — github-core-clone-01

Final local grade from a **full env trial** (program/env/server.mjs on 8080 + this entry's main.ts, MAKEFUN_ENV_URL set), run 2026-11-14 ~08:01–08:02 WIB. The env wrote state.json + perf.json to the state dir; those files are the authoritative result quoted here.

## Score

| Component | Points | Max | How |
|---|---|---|---|
| Feature (conformance) | **600** | 600 | 120/120 checks passed |
| Agent (MCP) | **200** | 200 | 15/15 MCP checks passed |
| Perf | **6** | 200 | push 6, clone 0, read 0, write 0 (see below) |
| **Total** | **806** | **1000** | |

Standalone conformance re-runs (sdk/run.ts, no --perf) also pass **120/120**; the last standalone --perf run on a fresh server passed 120/120 with perf 2 points (push p50 1794 ms). Perf points vary run to run on this loaded sandbox — see the perf note.

## Checks by group (env trial)

- git: 30/30
- graphql: 20/20
- issues: 15/15
- mcp: 15/15
- protocol: 5/5
- pulls: 20/20
- repos: 15/15

## Perf (env trial, perf.json)

| Workload | Ops | p50 ms | p99 ms | T_ref ms | Points |
|---|---|---|---|---|---|
| push | 200 | 1489.185 | 1983.167 | 514.838 | 6 |
| clone | 50 | 521.787 | 673.026 | 121.436 | 0 |
| read | 2000 | 3820.059 | 4322.033 | 899.962 | 0 |
| write | 200 | 617.279 | 689.665 | 120.093 | 0 |

perf_p50_us: 1163452; points_total: 6. Rounds: push [1983.167, 1489.185, 1030.794]; clone [673.026, 521.787, 277.56]; read [4322.033, 3069.813, 3820.059]; write [600.976, 617.279, 689.665].

### Perf note (why perf is low locally)

T_ref was calibrated on a quiet e2e rig (2 CPUs, loopback, reference forge). This sandbox is a loaded shared VM (1.5 shared CPUs): a bare node:http server measured here does ~1.1 ms per keep-alive request, versus ~0.45 ms implied by T_ref for the read workload — so even a zero-work server scores ~0 read points locally. The forge itself adds nothing measurable over a bare server on the hot paths (verified: issue GET ~1.1 ms/request with a raw keep-alive client, same as bare node:http; all hot paths are Map lookups, no scans). Perf should be materially better on the quiet 2-CPU trial pod. The only workload with headroom locally is push (6 points in the env trial).

## Full check table (all 120 pass)

| Check | Result |
|---|---|
| git.advertise-headers — info/refs answers the smart-HTTP content type and preamble | ✅ pass |
| git.advertise-receive-pack — receive-pack serves a v0 ref advertisement with push capabilities | ✅ pass |
| git.advertise-v2 — protocol v2 capability advertisement is served and well formed | ✅ pass |
| git.clone-annotated-tag — an annotated tag object round-trips and peels to its commit | ✅ pass |
| git.clone-blob-bytes — every cloned blob equals the pushed bytes | ✅ pass |
| git.clone-commit-bytes — commit objects round-trip byte-exactly with their metadata | ✅ pass |
| git.clone-empty — a repository with no refs clones as an empty repository | ✅ pass |
| git.clone-object-hashes — a full clone verifies object-for-object | ✅ pass |
| git.clone-tree-entries — cloned trees round-trip paths, modes and nested directories | ✅ pass |
| git.fetch-incremental — an incremental fetch sends only the new objects and advances the tip | ✅ pass |
| git.fetch-nothing-new — a fetch with the tip already held transfers no objects | ✅ pass |
| git.fetch-shallow-deepen — deepen 2 extends a shallow clone by exactly one generation | ✅ pass |
| git.fetch-shallow-depth1 — a depth-1 shallow clone lands the tip only | ✅ pass |
| git.fetch-shallow-new-tip — a shallow fetch of a new tip does not pull the old history | ✅ pass |
| git.ls-refs — v2 ls-refs reports refs, HEAD symref and peeled tags | ✅ pass |
| git.ls-refs-prefix — v2 ls-refs honours ref-prefix filtering | ✅ pass |
| git.pack-deltas — delta-compressed objects resolve correctly (when the server sends them) | ✅ pass |
| git.pack-integrity — a fetched pack is structurally valid and checksummed | ✅ pass |
| git.push-100-files — a 100-file single-commit push round-trips byte-exactly | ✅ pass |
| git.push-create-branch — creating a branch from an existing commit is reported and advertised | ✅ pass |
| git.push-delete-branch — deleting a branch is reported and removes the ref | ✅ pass |
| git.push-delete-tag — deleting a tag ref is reported and removes the ref | ✅ pass |
| git.push-first-commit — a first commit pushes to an unborn branch and becomes the tip | ✅ pass |
| git.push-mixed-report — one command list reports ok and ng per ref, and applies only the ok one | ✅ pass |
| git.push-non-fast-forward — a non-fast-forward update is refused per-ref and changes nothing | ✅ pass |
| git.push-sideband-report — the push report arrives in valid sideband frames | ✅ pass |
| git.push-update-ref — a fast-forward update moves a branch and clones see it | ✅ pass |
| git.repo-survives-errors — the server stays healthy through 404s, refusals and a malformed request | ✅ pass |
| git.sideband-framing — the fetch packfile section is valid sideband framing | ✅ pass |
| git.unknown-repo-404 — a missing repository advertises 404 and the server stays up | ✅ pass |
| graphql.add-comment — addComment writes an issue comment the REST view lists | ✅ pass |
| graphql.batched-operations — two operation documents in one body answer in order | ✅ pass |
| graphql.close-issue — closeIssue closes an issue the REST view shows closed | ✅ pass |
| graphql.create-issue — createIssue creates an issue the REST view sees | ✅ pass |
| graphql.create-pull-request — createPullRequest creates a pull request | ✅ pass |
| graphql.global-id-stability — global ids are opaque and equal on repeated reads | ✅ pass |
| graphql.introspection-issue — __type(name: "Issue") lists the fields gh feature-detects | ✅ pass |
| graphql.introspection-types — __type lists PullRequest, Repository and SearchType (gh's other probes, one check) | ✅ pass |
| graphql.invalid-field — an invalid field is a 200 with an errors array | ✅ pass |
| graphql.issue-by-number — issue(number:) reads one issue | ✅ pass |
| graphql.issues-open-order — issues(first: 10, states: [OPEN], orderBy: CREATED_AT DESC) filters and orders | ✅ pass |
| graphql.issues-pagination — issues(first, after) pages by cursor to the end | ✅ pass |
| graphql.merge-pull-request — mergePullRequest SQUASH merges and the REST view shows merged: true | ✅ pass |
| graphql.node-repository — node(id:) round-trips a repository | ✅ pass |
| graphql.pull-request-files — pullRequest(number:).files lists the changed paths | ✅ pass |
| graphql.pull-requests-list — pullRequests(first: 5) lists number, headRefName, baseRefName, mergeable and state | ✅ pass |
| graphql.repository-fields — repository(owner:, name:) answers id, databaseId, name, owner, defaultBranchRef, viewerPermission and hasIssuesEnabled | ✅ pass |
| graphql.unauthenticated — an unauthenticated query is a 401 | ✅ pass |
| graphql.unknown-repository — an unknown repository reads data.repository = null with no errors | ✅ pass |
| graphql.viewer-login — query { viewer { login } } answers the token owner | ✅ pass |
| issues.bad-label — POST /issues with an unknown label is 422 | ✅ pass |
| issues.comment-create — POST /issues/{n}/comments creates a comment | ✅ pass |
| issues.comments-list — GET /issues/{n}/comments lists the comment | ✅ pass |
| issues.create — POST /issues creates a 201 open issue with a number | ✅ pass |
| issues.create-labels — POST /issues attaches an existing label | ✅ pass |
| issues.create-title-body — POST /issues echoes the title and body | ✅ pass |
| issues.get-one — GET /issues/{n} returns the issue | ✅ pass |
| issues.list-open — GET /issues?state=open lists the open issue | ✅ pass |
| issues.list-open-excludes-closed — GET /issues?state=open omits a closed issue | ✅ pass |
| issues.list-shape — GET /issues returns the GitHub issue shape | ✅ pass |
| issues.list-sort-asc — GET /issues?sort=created&direction=asc orders by creation | ✅ pass |
| issues.list-sort-desc — GET /issues?sort=created&direction=desc reverses it | ✅ pass |
| issues.numbers-increment — issue numbers increment by one | ✅ pass |
| issues.patch-close — PATCH /issues/{n} closes it | ✅ pass |
| issues.patch-close-persists — the close survives a later GET | ✅ pass |
| mcp.auth-required — a tools/call with no Authorization header answers HTTP 401 | ✅ pass |
| mcp.concurrent-calls — two concurrent tool calls answer under their own ids and their own objects | ✅ pass |
| mcp.create-issue — tools/call create_issue creates an issue the REST surface lists | ✅ pass |
| mcp.create-pull-request — tools/call create_pull_request opens a pull request REST reads back with the same head and base | ✅ pass |
| mcp.initialize — initialize: serverInfo.name/version and capabilities.tools, over whichever era the server negotiates | ✅ pass |
| mcp.list-issues — tools/call list_issues returns an issue the repository holds | ✅ pass |
| mcp.merge-pull-request — tools/call merge_pull_request merges; REST reads merged:true | ✅ pass |
| mcp.missing-arguments — tools/call with missing required arguments answers isError:true or JSON-RPC -32602 | ✅ pass |
| mcp.parse-error — a body that is not JSON answers HTTP 400 with JSON-RPC -32700 | ✅ pass |
| mcp.rest-parity — a repository and an issue created over MCP are the same objects over REST, ids stable | ✅ pass |
| mcp.server-discover — server/discover: a DiscoverResult with supportedVersions, or the pre-discover era | ✅ pass |
| mcp.tool-schemas — every tool has a non-empty description and an inputSchema of type object | ✅ pass |
| mcp.tools-list — tools/list: at least six tools, all six required ones present by name or obvious alias | ✅ pass |
| mcp.tools-list-idempotent — two tools/list answers hold the same tools array, byte for byte | ✅ pass |
| mcp.unknown-tool — an unknown tool name answers JSON-RPC -32602 or -32601, never HTTP 500 | ✅ pass |
| protocol.content-type-json — every REST reply is application/json, never HTML | ✅ pass |
| protocol.error-message — 401, 404 and 422 bodies carry a string message | ✅ pass |
| protocol.malformed-body-400 — a malformed JSON body is a 400 | ✅ pass |
| protocol.request-id — every reply carries a non-empty X-GitHub-Request-Id | ✅ pass |
| protocol.unknown-route-json-404 — an unknown /api/v3 route is a JSON 404 | ✅ pass |
| pulls.create — POST /pulls creates an open pull request from a head branch | ✅ pass |
| pulls.create-base-sha — the pull base.sha is the base branch tip | ✅ pass |
| pulls.create-body — POST /pulls echoes the title and body | ✅ pass |
| pulls.create-head-sha — the pull head.sha is the head branch tip | ✅ pass |
| pulls.files-list — GET /pulls/{n}/files lists the changed path | ✅ pass |
| pulls.files-multiple — GET /pulls/{n}/files lists every changed path | ✅ pass |
| pulls.files-shape — pull files carry filename, status and the change counts | ✅ pass |
| pulls.get-one — GET /pulls/{n} returns the pull request | ✅ pass |
| pulls.get-unknown — GET an unknown pull request is 404 | ✅ pass |
| pulls.list-default-open — GET /pulls defaults to open pull requests | ✅ pass |
| pulls.list-shape — GET /pulls returns the GitHub pull-request shape | ✅ pass |
| pulls.list-state-all — GET /pulls?state=all lists open and merged pull requests | ✅ pass |
| pulls.merge-body — the merge reply is {merged:true, sha, message} | ✅ pass |
| pulls.merge-closes — the merged pull is closed, merged and carries merged_at | ✅ pass |
| pulls.merge-commit-on-default — the merge commit appears on the default branch | ✅ pass |
| pulls.merge-commit-sha — the pull reports merge_commit_sha equal to the merge sha | ✅ pass |
| pulls.merge-conflict — merging a conflicted pull request is 405 | ✅ pass |
| pulls.merge-content-on-default — the squash content is on the default branch | ✅ pass |
| pulls.merge-status — PUT /pulls/{n}/merge with merge_method=squash is 200 | ✅ pass |
| pulls.merge-unknown — merging an unknown pull request is 404 | ✅ pass |
| repos.branches — GET /branches lists a branch created through POST /git/refs | ✅ pass |
| repos.commits — GET /commits reflects a commit made on a branch and not the default branch | ✅ pass |
| repos.contents-create — PUT /contents creates a file with a commit; GET returns base64 content and sha | ✅ pass |
| repos.contents-delete — DELETE /contents removes the file with a commit and GET is 404 | ✅ pass |
| repos.contents-directory — GET /contents on a directory lists its entries | ✅ pass |
| repos.contents-stale-sha — PUT /contents with a stale sha is 409 | ✅ pass |
| repos.create — POST /user/repos creates and GET round-trips name, private and default_branch | ✅ pass |
| repos.delete — DELETE /repos/{o}/{r} deletes it and a later GET is 404 | ✅ pass |
| repos.foreign-token — the same repository name under another owner is a 404 for this token | ✅ pass |
| repos.meta — GET /api/v3/meta reports installed_version | ✅ pass |
| repos.not-found — GET a missing repository is a JSON 404 | ✅ pass |
| repos.pagination — GET /user/repos pages 30 seeded repos at per_page=10 through Link rel="next" | ✅ pass |
| repos.patch — PATCH /repos/{o}/{r} updates the description | ✅ pass |
| repos.root — GET /api/v3/ answers 200 JSON with X-OAuth-Scopes | ✅ pass |
| repos.unauthorized — a request without a token is 401 | ✅ pass |

## How to reproduce

Standalone (fast, conformance only):

```bash
# terminal 1 — start the forge on a port with a test token
cd ~/workspace/makefun/github-core-clone-01
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types -e "import('./app.ts').then(m => m.startServer(34571))"

# terminal 2 — grade it (from the kit directory)
cd ~/workspace/makefun/github-core-clone-01-kit
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:34571 --token test-token-123 [--perf] [--json]
```

Full env trial (what produced the score above — runs the suite + bench and writes the export):

```bash
rm -rf /tmp/env-state && mkdir -p /tmp/env-state
cd ~/workspace/makefun/github-core-clone-01-kit
MAKEFUN_STATE_DIR=/tmp/env-state MAKEFUN_SHOP_TOKEN=test-token-123 node program/env/server.mjs &
cd ~/workspace/makefun/github-core-clone-01
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types main.ts
# when main.ts prints "[entry] done", read /tmp/env-state/export/state.json and perf.json
```

Notes: use a FRESH server process per grade run — the suite creates repos by fixed scenario names, so grading twice against one server makes the second run fail on 422s (repos already exist). Never bind port 8080 in the entry; main.ts binds an ephemeral port. Node 24.22.1 was used locally; the code uses stable Node 22-compatible APIs only.
