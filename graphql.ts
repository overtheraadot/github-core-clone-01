// GraphQL v4: a small parser + executor for the documents gh and
// github-mcp-server send (viewer, repository, issue(s), pullRequest(s),
// createIssue/closeIssue/createPullRequest/mergePullRequest/addComment, node,
// __type introspection, batched operations). No dependencies.

import {
  diffTrees, globalId, mergeBase, parseCommit, pullConflicts,
  squashMerge, stamp, store, walkCommits,
  type Issue, type Pull, type Repo,
} from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null; name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeName: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface Fragment { typeName: string; selection: SelectionNode[] }

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }

  private skip(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos] as string)) this.pos += 1;
      if (this.src[this.pos] === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      break;
    }
  }
  private peek(): string { this.skip(); return this.src[this.pos] ?? ''; }
  private eat(ch: string): boolean { this.skip(); if (this.src[this.pos] === ch) { this.pos += 1; return true; } return false; }
  private expect(ch: string): void { if (!this.eat(ch)) throw new Error(`expected ${ch} at ${this.pos}`); }
  private name(): string {
    this.skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private string(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos] as string;
      if (ch === '"') { this.pos += 1; return out; }
      if (ch === '\\') {
        const esc = this.src[this.pos + 1] as string;
        this.pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'u') { out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16)); this.pos += 4; }
        else out += esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }
  private value(): ValueNode {
    this.skip();
    const ch = this.src[this.pos] as string;
    if (ch === '$') { this.pos += 1; return { kind: 'variable', name: this.name() }; }
    if (ch === '"') return { kind: 'string', value: this.string() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (!this.eat(']')) { values.push(this.value()); this.eat(','); }
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.eat('}')) { const n = this.name(); this.expect(':'); fields.push({ name: n, value: this.value() }); this.eat(','); }
      return { kind: 'object', fields };
    }
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (m && /^[0-9-]/.test(ch)) {
      this.pos += m[0].length;
      return m[0].includes('.') || /[eE]/.test(m[0]) ? { kind: 'float', value: Number(m[0]) } : { kind: 'int', value: Number(m[0]) };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }
  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (!this.eat('}')) {
      if (this.peek() === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skip();
        if (this.src.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          const typeName = this.name();
          out.push({ kind: 'inline', typeName, selection: this.selectionSet() });
        } else {
          out.push({ kind: 'spread', name: this.name() });
        }
        continue;
      }
      const first = this.name();
      let alias: string | null = null;
      let fname = first;
      if (this.eat(':')) { alias = first; fname = this.name(); }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.eat('(')) {
        while (!this.eat(')')) { const n = this.name(); this.expect(':'); args.push({ name: n, value: this.value() }); this.eat(','); }
      }
      let selection: SelectionNode[] | null = null;
      if (this.peek() === '{') selection = this.selectionSet();
      out.push({ kind: 'field', field: { alias, name: fname, args, selection } });
    }
    return out;
  }
  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.pos < this.src.length) {
      this.skip();
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === '{') {
        operations.push({ type: 'query', name: null, varDefs: [], selection: this.selectionSet() });
        continue;
      }
      const keyword = this.name();
      if (keyword === 'fragment') {
        const fname = this.name();
        this.expect('on');
        const typeName = this.name();
        fragments.set(fname, { typeName, selection: this.selectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') throw new Error(`unexpected ${keyword}`);
      let opName: string | null = null;
      if (/[A-Za-z_]/.test(this.peek())) opName = this.name();
      const varDefs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
      if (this.eat('(')) {
        while (!this.eat(')')) {
          this.expect('$');
          const vn = this.name();
          this.expect(':');
          // Skip the type (name, brackets, !) — values are resolved from variables.
          let depth = 0;
          while (this.pos < this.src.length) {
            const ch = this.src[this.pos] as string;
            if (ch === '[') depth += 1;
            else if (ch === ']') depth -= 1;
            else if ((ch === ',' || ch === ')') && depth === 0) break;
            else if (ch === '=' && depth === 0) break;
            this.pos += 1;
          }
          let def: ValueNode | null = null;
          if (this.eat('=')) def = this.value();
          varDefs.push({ name: vn, defaultValue: def });
          this.eat(',');
        }
      }
      operations.push({ type: keyword as 'query' | 'mutation', name: opName, varDefs, selection: this.selectionSet() });
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------- executor

type Json = Record<string, unknown>;
type Resolver = (obj: unknown, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  errors: Array<{ message: string }>;
  fragments: Map<string, Fragment>;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'assignees', 'assignee', 'milestone', 'locked', 'repository', 'createdAtHumanized'];
const PR_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'labels', 'comments', 'repository', 'isDraft', 'draft'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazers', 'watchers', 'primaryLanguage', 'languages', 'licenseInfo', 'repositoryTopics', 'diskUsage', 'visibility'];
const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type', '__schema', 'search', 'user', 'organization'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'addReaction'];

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name];
    case 'string': return node.value;
    case 'int': case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, vars);
      return out;
    }
  }
}

function typeNameOf(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return '';
  const t = (obj as { __typename?: string }).__typename;
  return typeof t === 'string' ? t : '';
}

const FIELD_SETS: Record<string, string[]> = {
  Query: QUERY_FIELDS,
  Mutation: MUTATION_FIELDS,
  Repository: REPO_FIELDS,
  Issue: ISSUE_FIELDS,
  PullRequest: PR_FIELDS,
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Actor: ['id', 'login'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['oid', 'id', 'message', 'abbreviatedOid'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  LabelConnection: ['nodes', 'edges', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  CommentConnection: ['nodes', 'edges', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  SearchResultItemConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
};

function fieldsForType(typeName: string): string[] {
  return FIELD_SETS[typeName] ?? [];
}

interface RepoWrap { __typename: 'Repository'; repo: Repo }
interface IssueWrap { __typename: 'Issue'; repo: Repo; issue: Issue }
interface PullWrap { __typename: 'PullRequest'; repo: Repo; pull: Pull }
interface UserWrap { __typename: 'User'; login: string }
interface RefWrap { __typename: 'Ref'; name: string; repo: Repo }

function repoWrap(repo: Repo): RepoWrap { return { __typename: 'Repository', repo }; }
function issueWrap(repo: Repo, issue: Issue): IssueWrap { return { __typename: 'Issue', repo, issue }; }
function pullWrap(repo: Repo, pull: Pull): PullWrap { return { __typename: 'PullRequest', repo, pull }; }

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => dir * (a.number - b.number));
  const afterNum = numberFromCursor(args.after);
  if (afterNum !== null) {
    list = dir === -1 ? list.filter((i) => i.number < afterNum) : list.filter((i) => i.number > afterNum);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueWrap(repo, i)),
    totalCount: list.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: afterNum !== null,
      startCursor: page.length ? cursorFor(page[0]!.number) : null,
      endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => want.has(p.state));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const afterNum = numberFromCursor(args.after);
  if (afterNum !== null) list = list.filter((p) => p.number < afterNum);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullWrap(repo, p)),
    totalCount: list.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: list.length > first,
      hasPreviousPage: afterNum !== null,
      startCursor: page.length ? cursorFor(page[0]!.number) : null,
      endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function prFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): Record<string, unknown> {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  let files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  if (baseTip && headTip) {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (baseCommit && headCommit) {
      const mb = mergeBase(repo, baseTip, headTip);
      const mbObj = mb ? repo.objects.get(mb) : undefined;
      const mbTree = mbObj ? parseCommit(mbObj.data).tree : parseCommit(baseCommit.data).tree;
      files = diffTrees(repo, mbTree, parseCommit(headCommit.data).tree);
    }
  }
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
    totalCount: files.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function resolveGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch { return null; }
}

function findRepoByGlobalId(id: string): Repo | null {
  const parsed = resolveGlobalId(id);
  if (!parsed || parsed.kind !== 'repo') return null;
  const [owner, name] = parsed.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const parsed = resolveGlobalId(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const m = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
  if (!m) return null;
  const repo = store.getRepo(m[1] as string, m[2] as string);
  if (!repo) return null;
  const issue = repo.issues.get(Number(m[3]));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const parsed = resolveGlobalId(id);
  if (!parsed || parsed.kind !== 'pr') return null;
  const m = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
  if (!m) return null;
  const repo = store.getRepo(m[1] as string, m[2] as string);
  if (!repo) return null;
  const pull = repo.pulls.get(Number(m[3]));
  return pull ? { repo, pull } : null;
}

function executeSelection(obj: unknown, selection: SelectionNode[], vars: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typeNameOf(obj);
  for (const sel of selection) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) {
        if (frag.typeName && typeName && frag.typeName !== typeName) continue;
        Object.assign(out, executeSelection(obj, frag.selection, vars, ctx));
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeName && typeName && sel.typeName !== typeName) continue;
      Object.assign(out, executeSelection(obj, sel.selection, vars, ctx));
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') { out[key] = typeName; continue; }
    const known = fieldsForType(typeName);
    if (typeName !== '' && !known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of field.args) args[a.name] = evalValue(a.value, vars);
    const value = resolveField(obj, field.name, args, ctx);
    if (field.selection && value !== null && value !== undefined) {
      out[key] = Array.isArray(value)
        ? value.map((item) => executeSelection(item, field.selection as SelectionNode[], vars, ctx))
        : executeSelection(value, field.selection, vars, ctx);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveField(obj: unknown, name: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const typeName = typeNameOf(obj);
  if (typeName.endsWith('Payload') || typeName.endsWith('Edge')) {
    const o = obj as Record<string, unknown>;
    return o[name] ?? null;
  }
  if (typeName === 'Query') {
    if (name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = store.getRepo(owner, repoName);
      return repo ? repoWrap(repo) : null;
    }
    if (name === 'node') {
      const id = String(args.id ?? '');
      const repo = findRepoByGlobalId(id);
      if (repo) return repoWrap(repo);
      const issue = findIssueByGlobalId(id);
      if (issue) return issueWrap(issue.repo, issue.issue);
      const pull = findPullByGlobalId(id);
      if (pull) return pullWrap(pull.repo, pull.pull);
      return null;
    }
    if (name === '__type') return introspectType(String(args.name ?? ''));
    if (name === '__schema') return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' }, mutationType: { __typename: '__Type', name: 'Mutation' }, types: [] };
    if (name === 'user' || name === 'organization') return { __typename: 'User', login: String(args.login ?? '') };
    return null;
  }
  if (typeName === 'Mutation') {
    return resolveMutation(name, args);
  }
  if (typeName === 'Repository') {
    const repo = (obj as RepoWrap).repo;
    switch (name) {
      case 'id': return globalId('repo', `${repo.owner}/${repo.name}`);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return { __typename: 'User', login: repo.owner };
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, repo } as RefWrap;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'isPrivate': return repo.private;
      case 'fork': return false;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueWrap(repo, issue) : null;
      }
      case 'issues': return issuesConnection(repo, args);
      case 'pullRequests': return pullsConnection(repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullWrap(repo, pull) : null;
      }
    }
    return null;
  }
  if (typeName === 'Issue') {
    const { repo, issue } = obj as IssueWrap;
    switch (name) {
      case 'id': return globalId('issue', `${repo.owner}/${repo.name}#${issue.number}`);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'author': return { __typename: 'User', login: VIEWER_LOGIN };
      case 'labels': return { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l, color: 'ededed', description: '' })), totalCount: issue.labels.length };
      case 'comments': return { __typename: 'CommentConnection', nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('comment', `${repo.owner}/${repo.name}#${issue.number}:${c.id}`), body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt })), totalCount: issue.comments.length };
      case 'repository': return repoWrap(repo);
    }
    return null;
  }
  if (typeName === 'PullRequest') {
    const { repo, pull } = obj as PullWrap;
    switch (name) {
      case 'id': return globalId('pr', `${repo.owner}/${repo.name}#${pull.number}`);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pull.state.toUpperCase();
      case 'body': return pull.body;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'mergeable': return pull.merged ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'merged': return pull.merged;
      case 'files': return prFiles(repo, pull, args);
      case 'headRef': return { __typename: 'Ref', name: pull.head, repo } as RefWrap;
      case 'baseRef': return { __typename: 'Ref', name: pull.base, repo } as RefWrap;
      case 'author': return { __typename: 'User', login: VIEWER_LOGIN };
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'closedAt': return pull.closedAt;
      case 'mergedAt': return pull.mergedAt;
      case 'mergeCommit': {
        if (!pull.mergeCommitSha) return null;
        return { __typename: 'Commit', oid: pull.mergeCommitSha, id: pull.mergeCommitSha, message: '' };
      }
      case 'repository': return repoWrap(repo);
      case 'isDraft': case 'draft': return false;
    }
    return null;
  }
  if (typeName === 'User') {
    const login = (obj as UserWrap).login;
    switch (name) {
      case 'id': return globalId('user', login);
      case 'login': return login;
      case 'name': return login === VIEWER_LOGIN ? VIEWER_NAME : login;
      case 'email': return login === VIEWER_LOGIN ? `${VIEWER_LOGIN}@example.invalid` : '';
      case 'avatarUrl': return '';
      case 'url': return `https://github.com/${login}`;
    }
    return null;
  }
  if (typeName === 'Ref') {
    const ref = obj as RefWrap;
    switch (name) {
      case 'id': return globalId('ref', `${ref.repo.owner}/${ref.repo.name}#${ref.name}`);
      case 'name': return ref.name;
      case 'prefix': return 'refs/heads/';
      case 'target': {
        const tip = ref.repo.refs.get(`refs/heads/${ref.name}`);
        if (!tip) return null;
        return { __typename: 'Commit', oid: tip, id: tip, message: '' };
      }
    }
    return null;
  }
  if (typeName === 'Commit') {
    const c = obj as { oid: string };
    if (name === 'oid' || name === 'id') return c.oid;
    if (name === 'abbreviatedOid') return c.oid.slice(0, 7);
    if (name === 'message') return '';
    return null;
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'LabelConnection' || typeName === 'CommentConnection') {
    const conn = obj as Record<string, unknown>;
    if (name === 'nodes') return conn.nodes ?? [];
    if (name === 'totalCount') return conn.totalCount ?? 0;
    if (name === 'pageInfo') return conn.pageInfo ?? null;
    if (name === 'edges') {
      const nodes = (conn.nodes as unknown[]) ?? [];
      return nodes.map((n) => ({ __typename: typeName.replace('Connection', 'Edge'), node: n, cursor: '' }));
    }
    return null;
  }
  if (typeName === 'PageInfo') {
    const p = obj as Record<string, unknown>;
    return p[name] ?? null;
  }
  if (typeName === '__Type') {
    const t = obj as Record<string, unknown>;
    if (name === 'fields') {
      const names = t._fields as string[] | undefined;
      return names ? names.map((n) => ({ __typename: '__Field', name: n, description: null, args: [], type: null, isDeprecated: false, deprecationReason: null })) : null;
    }
    if (name === 'enumValues') {
      const vals = t._enumValues as string[] | undefined;
      return vals ? vals.map((n) => ({ __typename: '__EnumValue', name: n, description: null, isDeprecated: false, deprecationReason: null })) : null;
    }
    if (name === 'name' || name === 'kind' || name === 'description') return t[name] ?? null;
    return null;
  }
  if (typeName === '__Field' || typeName === '__EnumValue' || typeName === '__Schema' || typeName === '__InputValue') {
    const o = obj as Record<string, unknown>;
    return o[name] ?? null;
  }
  if (typeName === 'PullRequestChangedFile') {
    const o = obj as Record<string, unknown>;
    return o[name] ?? null;
  }
  if (typeName === 'Label' || typeName === 'IssueComment') {
    const o = obj as Record<string, unknown>;
    return o[name] ?? null;
  }
  if (typeName.endsWith('Edge')) {
    const o = obj as Record<string, unknown>;
    return o[name] ?? null;
  }
  return null;
}

function introspectType(name: string): Record<string, unknown> | null {
  const base: Record<string, unknown> = { __typename: '__Type', name, kind: 'OBJECT', description: null };
  if (name === 'Issue') return { ...base, _fields: ISSUE_FIELDS };
  if (name === 'PullRequest') return { ...base, _fields: PR_FIELDS };
  if (name === 'Repository') return { ...base, _fields: REPO_FIELDS };
  if (name === 'SearchType') return { ...base, kind: 'ENUM', _enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'] };
  if (name === 'User') return { ...base, _fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'] };
  if (name === 'Query') return { ...base, _fields: QUERY_FIELDS };
  if (name === 'Mutation') return { ...base, _fields: MUTATION_FIELDS };
  return null;
}

function createIssueInRepo(repo: Repo, title: string, body: string, labels: string[] = []): Issue {
  const now = stamp();
  const issue: Issue = {
    id: store.nextIssueId, number: repo.nextNumber, title, body,
    state: 'open', labels, createdAt: now, updatedAt: now, closedAt: null,
    comments: [], seq: repo.nextNumber,
  };
  store.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullInRepo(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const now = stamp();
  const pull: Pull = {
    id: store.nextPullId, number: repo.nextNumber, title, body, state: 'open',
    head, base, headSha: headTip, baseSha: baseTip,
    merged: false, mergedAt: null, mergeCommitSha: null,
    createdAt: now, updatedAt: now, closedAt: null, seq: repo.nextNumber,
  };
  store.nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function resolveMutation(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) return { __typename: 'CreateIssuePayload', issue: null };
    const issue = createIssueInRepo(repo, String(input.title ?? ''), String(input.body ?? ''));
    return { __typename: 'CreateIssuePayload', issue: issueWrap(repo, issue) };
  }
  if (name === 'closeIssue') {
    const found = findIssueByGlobalId(String(input.issueId ?? ''));
    if (!found) return { __typename: 'CloseIssuePayload', issue: null };
    found.issue.state = 'closed';
    found.issue.closedAt = new Date().toISOString();
    found.issue.updatedAt = found.issue.closedAt;
    return { __typename: 'CloseIssuePayload', issue: issueWrap(found.repo, found.issue) };
  }
  if (name === 'createPullRequest') {
    const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const pull = createPullInRepo(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pull ? pullWrap(repo, pull) : null };
  }
  if (name === 'mergePullRequest') {
    const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
    if (!found) return { __typename: 'MergePullRequestPayload', pullRequest: null };
    squashMerge(found.repo, found.pull);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullWrap(found.repo, found.pull) };
  }
  if (name === 'addComment') {
    const found = findIssueByGlobalId(String(input.subjectId ?? ''));
    if (!found) return { __typename: 'AddCommentPayload', commentEdge: null };
    const comment = {
      id: found.repo.nextCommentId,
      body: String(input.body ?? ''),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    found.repo.nextCommentId += 1;
    found.issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: globalId('comment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt },
        cursor: '',
      },
    };
  }
  return null;
}

/** Execute one GraphQL operation body; returns the {data, errors?} envelope. */
export function executeGraphQL(body: unknown): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { errors: [], fragments: new Map() };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with query and variables.' }] };
  }
  const query = (body as Record<string, unknown>).query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request needs a query string.' }] };
  }
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  const operationName = (body as Record<string, unknown>).operationName as string | undefined;
  let parsed;
  try {
    parsed = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  ctx.fragments = parsed.fragments;
  let op: Operation | undefined;
  if (parsed.operations.length === 1) op = parsed.operations[0];
  else if (operationName) op = parsed.operations.find((o) => o.name === operationName);
  else op = parsed.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation to execute.' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (!(def.name in vars) && def.defaultValue !== null) vars[def.name] = evalValue(def.defaultValue, vars);
  }
  const root: Record<string, unknown> = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, op.selection, vars, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Execute a batched array body; one envelope per operation, in order. */
export function executeGraphQLBatch(body: unknown[]): Array<{ data: Record<string, unknown> | null; errors?: Array<{ message: string }> }> {
  return body.map((entry) => executeGraphQL(entry));
}

export { createIssueInRepo, createPullInRepo, findRepoByGlobalId };
export type { Issue, Pull, Repo };
export { walkCommits };
