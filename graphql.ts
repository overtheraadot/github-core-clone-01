// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server actually send (see checks-graphql.ts GRAPHQL_DOCUMENTS).
// Hand-written lexer/parser for the subset used: operations, variables,
// aliases, inline input objects/lists, enums, inline fragments, batching.
// Validation reports unknown fields by name (the invalid-field check).

import {
  FIXED_ISO,
  diffTrees,
  globalId,
  mergeBase,
  parseCommit,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { doMerge, pullIsMergeable } from './rest.ts';
import { jsonResult, type HandlerResult, type ReqCtx } from './types.ts';

// ---------------------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // String (no block strings in the suite's documents).
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------------------

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
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name' && t.kind !== 'string') throw new Error(`expected a name, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArgs();
    }
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        const opKind = t.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVarDefs() : [];
        this.skipDirectives();
        doc.operations.push({ kind: opKind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        doc.fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${t.value} in document`);
    }
    return doc;
  }

  private parseVarDefs(): Array<{ name: string; defaultValue: ValueNode | null }> {
    this.expectPunct('(');
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArgs() : [];
    this.skipDirectives();
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Schema (for validation + introspection)
// ---------------------------------------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Node: ['id'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'];

// The object type a field returns (for validation + fragment matching).
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentNode>,
  errors: string[],
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const field = selection.field;
      const fields = SCHEMA[parentType];
      if (!fields || !fields.includes(field.name)) {
        errors.push(`Cannot query field "${field.name}" on type "${parentType}".`);
        continue;
      }
      const childType = FIELD_TYPE[parentType]?.[field.name];
      if (childType && field.selections.length > 0) {
        validateSelections(field.selections, childType, fragments, errors);
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment) validateSelections(fragment.selections, fragment.typeCondition, fragments, errors);
    } else if (selection.kind === 'inlineFragment') {
      validateSelections(selection.selections, selection.typeCondition ?? parentType, fragments, errors);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------------------

type GqlObject =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo; owner: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'PullRequestConnection'; nodes: Array<{ __typename: 'PullRequest'; repo: Repo; pull: PullRequest }> }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Array<{ __typename: 'PullRequestChangedFile'; path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'CreateIssuePayload'; issue: { __typename: 'Issue'; repo: Repo; issue: Issue } | null }
  | { __typename: 'CloseIssuePayload'; issue: { __typename: 'Issue'; repo: Repo; issue: Issue } | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: { __typename: 'PullRequest'; repo: Repo; pull: PullRequest } | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: { __typename: 'PullRequest'; repo: Repo; pull: PullRequest } | null }
  | { __typename: 'AddCommentPayload'; commentEdge: { __typename: 'IssueCommentEdge'; node: { __typename: 'IssueComment'; id: string; body: string } } | null }
  | { __typename: 'IssueCommentEdge'; node: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'IssueComment'; id: string; body: string }
  | { __typename: '__Type'; kind: 'object' | 'enum'; fields: string[]; enumValues: string[] };

interface Ctx {
  store: Store;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(name);
  if (!repo || owner !== ctx.store.tokenOwner) return null;
  ctx.store.learnOwner(owner);
  return repo;
}

function resolveRepoByGlobalId(ctx: Ctx, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const databaseId = parseInt(parsed.parts[0], 10);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return null;
}

function resolveIssueByGlobalId(ctx: Ctx, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const databaseId = parseInt(parsed.parts[0], 10);
  const number = parseInt(parsed.parts[1], 10);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== databaseId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function resolvePullByGlobalId(ctx: Ctx, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const databaseId = parseInt(parsed.parts[0], 10);
  const number = parseInt(parsed.parts[1], 10);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== databaseId) continue;
    const pull = repo.pulls.get(number);
    if (pull) return { repo, pull };
  }
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const n = parseInt(raw.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Execute one operation. Returns {data} or {errors} (or both). */
function executeOperation(
  ctx: Ctx,
  operation: OperationNode,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(operation.selections, rootType, fragments, errors);
  if (errors.length > 0) {
    return { errors: errors.map((message) => ({ message })), data: null };
  }
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    const resolved = resolveSelections(ctx, [selection], rootType, null, fragments, variables);
    Object.assign(data, resolved);
  }
  return { data };
}

function resolveSelections(
  ctx: Ctx,
  selections: SelectionNode[],
  parentType: string,
  parent: GqlObject | null,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = resolveField(ctx, field, parentType, parent, fragments, variables);
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) continue;
      if (parent && fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, resolveSelections(ctx, fragment.selections, fragment.typeCondition, parent, fragments, variables));
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && parent && selection.typeCondition !== parent.__typename) continue;
      Object.assign(
        out,
        resolveSelections(ctx, selection.selections, selection.typeCondition ?? parentType, parent, fragments, variables),
      );
    }
  }
  return out;
}

function resolveField(
  ctx: Ctx,
  field: FieldNode,
  parentType: string,
  parent: GqlObject | null,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  const args = argsOf(field, variables);
  const sub = (value: GqlObject | null, type: string): unknown => {
    if (value === null) return null;
    if (field.selections.length === 0) return value;
    return resolveSelections(ctx, field.selections, type, value, fragments, variables);
  };
  const subList = (values: GqlObject[], type: string): unknown[] =>
    values.map((v) => resolveSelections(ctx, field.selections, type, v, fragments, variables));

  // Root fields.
  if (parent === null) {
    if (field.name === 'viewer') {
      return sub({ __typename: 'User', login: ctx.store.tokenOwner }, 'User');
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = findRepo(ctx, owner, name);
      if (!repo) return null;
      return sub({ __typename: 'Repository', repo, owner }, 'Repository');
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = resolveRepoByGlobalId(ctx, id);
        if (!repo) return null;
        return sub({ __typename: 'Repository', repo, owner: ctx.store.tokenOwner }, 'Repository');
      }
      if (parsed.kind === 'Issue') {
        const found = resolveIssueByGlobalId(ctx, id);
        if (!found) return null;
        return sub({ __typename: 'Issue', repo: found.repo, issue: found.issue }, 'Issue');
      }
      if (parsed.kind === 'PullRequest') {
        const found = resolvePullByGlobalId(ctx, id);
        if (!found) return null;
        return sub({ __typename: 'PullRequest', repo: found.repo, pull: found.pull }, 'PullRequest');
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (name === 'Issue') return sub({ __typename: '__Type', kind: 'object', fields: SCHEMA.Issue, enumValues: [] }, '__Type');
      if (name === 'PullRequest') return sub({ __typename: '__Type', kind: 'object', fields: SCHEMA.PullRequest, enumValues: [] }, '__Type');
      if (name === 'Repository') return sub({ __typename: '__Type', kind: 'object', fields: SCHEMA.Repository, enumValues: [] }, '__Type');
      if (name === 'SearchType') return sub({ __typename: '__Type', kind: 'enum', fields: [], enumValues: SEARCH_TYPE_VALUES }, '__Type');
      return null;
    }
    // Mutations.
    if (field.name === 'createIssue') return mutationCreateIssue(ctx, field, args, fragments, variables);
    if (field.name === 'closeIssue') return mutationCloseIssue(ctx, field, args, fragments, variables);
    if (field.name === 'createPullRequest') return mutationCreatePullRequest(ctx, field, args, fragments, variables);
    if (field.name === 'mergePullRequest') return mutationMergePullRequest(ctx, field, args, fragments, variables);
    if (field.name === 'addComment') return mutationAddComment(ctx, field, args, fragments, variables);
    return null;
  }

  // Scalar + object fields by parent type.
  switch (parent.__typename) {
    case 'User':
      if (field.name === 'login') return parent.login;
      return null;
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.databaseId);
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${parent.owner}/${repo.name}`;
        case 'owner':
          return sub({ __typename: 'User', login: parent.owner }, 'User');
        case 'defaultBranchRef': {
          const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!oid) return null;
          return sub({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref');
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          if (!issue) return null;
          return sub({ __typename: 'Issue', repo, issue }, 'Issue');
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
          const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
          const orderField = String(orderBy.field ?? 'CREATED_AT');
          const direction = String(orderBy.direction ?? 'ASC');
          let issues = [...repo.issues.values()].filter((i) => states.includes(issueState(i)));
          issues.sort((a, b) => {
            const byNumber = a.number - b.number;
            if (orderField === 'CREATED_AT' || orderField === 'UPDATED_AT' || orderField === 'COMMENTS') {
              return direction === 'DESC' ? -byNumber : byNumber;
            }
            return byNumber;
          });
          const first = typeof args.first === 'number' ? args.first : issues.length;
          const afterNumber = numberFromCursor(args.after as string | null | undefined);
          if (afterNumber !== null) {
            issues = issues.filter((i) => (direction === 'DESC' ? i.number < afterNumber : i.number > afterNumber));
          }
          const page = issues.slice(0, first);
          const hasNextPage = issues.length > first;
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
          const connection: GqlObject = {
            __typename: 'IssueConnection',
            repo,
            issues: page,
            pageInfo: { hasNextPage, endCursor },
          };
          return sub(connection, 'IssueConnection');
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const pulls = [...repo.pulls.values()]
            .filter((p) => p.state === 'open')
            .sort((a, b) => b.createdSeq - a.createdSeq)
            .slice(0, first);
          const connection: GqlObject = {
            __typename: 'PullRequestConnection',
            nodes: pulls.map((pull) => ({ __typename: 'PullRequest' as const, repo, pull })),
          };
          return sub(connection, 'PullRequestConnection');
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          if (!pull) return null;
          return sub({ __typename: 'PullRequest', repo, pull }, 'PullRequest');
        }
        default:
          return null;
      }
    }
    case 'Ref':
      return field.name === 'name' ? parent.name : null;
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id':
          return issue.globalId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return subList(
          parent.issues.map((issue) => ({ __typename: 'Issue' as const, repo: parent.repo, issue })),
          'Issue',
        );
      }
      if (field.name === 'pageInfo') {
        return sub({ __typename: 'PageInfo', ...parent.pageInfo }, 'PageInfo');
      }
      return null;
    }
    case 'PageInfo':
      return field.name === 'hasNextPage' ? parent.hasNextPage : field.name === 'endCursor' ? parent.endCursor : null;
    case 'PullRequest': {
      const pull = parent.pull;
      switch (field.name) {
        case 'id':
          return pull.globalId;
        case 'number':
          return pull.number;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pullIsMergeable(parent.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const base = mergeBase(parent.repo, pull.baseSha, pull.headSha);
          const baseTree = base ? parseCommit(parent.repo.objects.get(base)!.data).tree : null;
          const headTree = parseCommit(parent.repo.objects.get(pull.headSha)!.data).tree;
          const changes = diffTrees(parent.repo, baseTree, headTree).slice(0, first);
          const connection: GqlObject = {
            __typename: 'PullRequestChangedFileConnection',
            nodes: changes.map((c) => ({ __typename: 'PullRequestChangedFile' as const, path: c.path })),
          };
          return sub(connection, 'PullRequestChangedFileConnection');
        }
        default:
          return null;
      }
    }
    case 'PullRequestConnection':
      if (field.name === 'nodes') return subList(parent.nodes, 'PullRequest');
      return null;
    case 'PullRequestChangedFileConnection':
      if (field.name === 'nodes') return subList(parent.nodes, 'PullRequestChangedFile');
      return null;
    case 'PullRequestChangedFile':
      return field.name === 'path' ? parent.path : null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field.name === 'issue') return parent.issue ? sub(parent.issue, 'Issue') : null;
      return null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return parent.pullRequest ? sub(parent.pullRequest, 'PullRequest') : null;
      return null;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return parent.commentEdge ? sub(parent.commentEdge, 'IssueCommentEdge') : null;
      return null;
    case 'IssueCommentEdge':
      if (field.name === 'node') return sub(parent.node, 'IssueComment');
      return null;
    case 'IssueComment':
      return field.name === 'id' ? parent.id : field.name === 'body' ? parent.body : null;
    case '__Type': {
      if (field.name === 'fields') {
        return (parent.fields as string[]).map((name) => ({ __typename: '__Field' as const, name }));
      }
      if (field.name === 'enumValues') {
        return (parent.enumValues as string[]).map((name) => ({ __typename: '__EnumValue' as const, name }));
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Mutations (shared rules with REST)
// ---------------------------------------------------------------------------------------------------------

function mutationCreateIssue(
  ctx: Ctx,
  field: FieldNode,
  args: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const repo = resolveRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
  if (!repo) return resolveSelections(ctx, field.selections, 'CreateIssuePayload', { __typename: 'CreateIssuePayload', issue: null }, fragments, variables);
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    id: ctx.store.nextId(),
    globalId: globalId('Issue', repo.databaseId, number),
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: ctx.store.nextSeq,
  };
  ctx.store.nextSeq += 1;
  repo.issues.set(number, issue);
  const payload: GqlObject = {
    __typename: 'CreateIssuePayload',
    issue: { __typename: 'Issue', repo, issue },
  };
  return resolveSelections(ctx, field.selections, 'CreateIssuePayload', payload, fragments, variables);
}

function mutationCloseIssue(
  ctx: Ctx,
  field: FieldNode,
  args: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const found = resolveIssueByGlobalId(ctx, String(input.issueId ?? ''));
  if (!found) return resolveSelections(ctx, field.selections, 'CloseIssuePayload', { __typename: 'CloseIssuePayload', issue: null }, fragments, variables);
  found.issue.state = 'closed';
  const payload: GqlObject = {
    __typename: 'CloseIssuePayload',
    issue: { __typename: 'Issue', repo: found.repo, issue: found.issue },
  };
  return resolveSelections(ctx, field.selections, 'CloseIssuePayload', payload, fragments, variables);
}

function mutationCreatePullRequest(
  ctx: Ctx,
  field: FieldNode,
  args: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const repo = resolveRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? '');
  let created: { __typename: 'PullRequest'; repo: Repo; pull: PullRequest } | null = null;
  if (repo) {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    const duplicate = [...repo.pulls.values()].some((p) => p.headRef === headRef && p.state === 'open');
    if (headSha && baseSha && !duplicate) {
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRequest = {
        number,
        id: ctx.store.nextId(),
        globalId: globalId('PullRequest', repo.databaseId, number),
        title: String(input.title ?? ''),
        body: '',
        headRef,
        baseRef,
        headSha,
        baseSha,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdSeq: ctx.store.nextSeq,
      };
      ctx.store.nextSeq += 1;
      repo.pulls.set(number, pull);
      created = { __typename: 'PullRequest', repo, pull };
    }
  }
  const payload: GqlObject = { __typename: 'CreatePullRequestPayload', pullRequest: created };
  return resolveSelections(ctx, field.selections, 'CreatePullRequestPayload', payload, fragments, variables);
}

function mutationMergePullRequest(
  ctx: Ctx,
  field: FieldNode,
  args: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const found = resolvePullByGlobalId(ctx, String(input.pullRequestId ?? ''));
  let merged: { __typename: 'PullRequest'; repo: Repo; pull: PullRequest } | null = null;
  if (found && found.pull.state === 'open') {
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
    const result = doMerge(ctx.store, found.repo, found.pull, method);
    if (result.ok) merged = { __typename: 'PullRequest', repo: found.repo, pull: found.pull };
  }
  const payload: GqlObject = { __typename: 'MergePullRequestPayload', pullRequest: merged };
  return resolveSelections(ctx, field.selections, 'MergePullRequestPayload', payload, fragments, variables);
}

function mutationAddComment(
  ctx: Ctx,
  field: FieldNode,
  args: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const body = String(input.body ?? '');
  const subjectId = String(input.subjectId ?? '');
  let node: { __typename: 'IssueComment'; id: string; body: string } | null = null;
  const issueFound = resolveIssueByGlobalId(ctx, subjectId);
  if (issueFound) {
    const comment = { id: ctx.store.nextId(), body, createdAt: FIXED_ISO };
    issueFound.issue.comments.push(comment);
    node = { __typename: 'IssueComment', id: globalId('IssueComment', issueFound.repo.databaseId, issueFound.issue.number, comment.id), body };
  } else {
    const pullFound = resolvePullByGlobalId(ctx, subjectId);
    if (pullFound) {
      const comment = { id: ctx.store.nextId(), body, createdAt: FIXED_ISO };
      pullFound.pull.comments.push(comment);
      node = { __typename: 'IssueComment', id: globalId('IssueComment', pullFound.repo.databaseId, pullFound.pull.number, comment.id), body };
    }
  }
  const payload: GqlObject = {
    __typename: 'AddCommentPayload',
    commentEdge: node ? { __typename: 'IssueCommentEdge', node } : null,
  };
  return resolveSelections(ctx, field.selections, 'AddCommentPayload', payload, fragments, variables);
}

// ---------------------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------------------

export async function handleGraphQL(store: Store, ctx: ReqCtx): Promise<HandlerResult> {
  let body: unknown;
  try {
    body = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    return jsonResult(400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  const operations = Array.isArray(body) ? body : [body];
  const results: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object' || typeof (operation as Record<string, unknown>).query !== 'string') {
      results.push({ errors: [{ message: 'A GraphQL operation needs a query string' }], data: null });
      continue;
    }
    const op = operation as Record<string, unknown>;
    const query = op.query as string;
    const variables = (op.variables as Record<string, unknown> | undefined) ?? {};
    const operationName = typeof op.operationName === 'string' ? op.operationName : null;
    let doc: DocumentNode;
    try {
      doc = new Parser(lex(query)).parseDocument();
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : String(err) }], data: null });
      continue;
    }
    let selected = doc.operations[0];
    if (operationName) {
      const named = doc.operations.find((o) => o.name === operationName);
      if (named) selected = named;
    }
    if (!selected) {
      results.push({ errors: [{ message: 'No operation to run' }], data: null });
      continue;
    }
    // Variable defaults.
    const vars: Record<string, unknown> = { ...variables };
    for (const def of selected.varDefs) {
      if (vars[def.name] === undefined && def.defaultValue) vars[def.name] = resolveValue(def.defaultValue, vars);
    }
    try {
      results.push(executeOperation({ store }, selected, doc.fragments, vars));
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : String(err) }], data: null });
    }
  }
  if (Array.isArray(body)) return jsonResult(200, results);
  return jsonResult(200, results[0]);
}
