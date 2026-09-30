import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingQuery } from "@/server/routes/instance/httpapi/middleware/workspace-routing"

const strict = { parseOptions: { onExcessProperty: "error" as const } }
const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Comment = Schema.Union([
  Schema.Struct({
    origin: Schema.Literal("pr"),
    id: short,
    author: short,
    body: Schema.String.check(Schema.isMaxLength(100_000)),
    file: Schema.optional(short),
    line: Schema.optional(line),
    diffHunk: Schema.optional(Schema.String.check(Schema.isMaxLength(200_000))),
    outdated: Schema.optional(Schema.Boolean),
    replies: Schema.optional(
      Schema.Array(
        Schema.Struct({ author: short, body: Schema.String.check(Schema.isMaxLength(100_000)) }).annotate(strict),
      ).check(Schema.isMaxLength(20)),
    ),
  }).annotate(strict),
  Schema.Struct({
    id: short,
    file: short,
    side: Schema.Literals(["additions", "deletions"]),
    line,
    comment: Schema.String.check(Schema.isMaxLength(100_000)),
    selectedText: Schema.String.check(Schema.isMaxLength(200_000)),
  }).annotate(strict),
])
export const Scope = Schema.Struct({ workspace: short, projectID: Schema.optional(short), box: short }).annotate(strict)
export const Identity = Schema.Struct({
  key: short,
  ...Scope.fields,
  sessionID: Schema.optional(short),
  pendingID: Schema.optional(short),
}).annotate(strict)
export const Content = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
  comments: Schema.Array(Comment).check(Schema.isMaxLength(100)),
  images: Schema.Array(
    Schema.Struct({
      id: short,
      filename: short,
      mime: Schema.String.check(
        Schema.isMaxLength(255),
        Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/),
      ),
      dataUrl: Schema.String.check(Schema.isMaxLength(12_000_000)),
    }).annotate(strict),
  ).check(Schema.isMaxLength(16)),
  scroll: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  model: Schema.optional(Schema.Struct({ providerID: short, modelID: short }).annotate(strict)),
  agent: Schema.optional(short),
  variant: Schema.optional(short),
  selection: Schema.optional(
    Schema.Struct({
      start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }).annotate(strict),
  ),
}).annotate(strict)
export const Token = Schema.Struct({
  generation: Schema.String.check(Schema.isUUID()),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
}).annotate(strict)
export const Entry = Schema.Struct({
  identity: Identity,
  token: Token,
  content: Schema.NullOr(Content),
  mutation: short,
  digest,
  receipt: Schema.optional(Schema.Struct({ request: digest }).annotate(strict)),
}).annotate(strict)
export const List = Schema.Struct({ scope: Scope }).annotate(strict)
export const Load = Schema.Struct({ identity: Identity }).annotate(strict)
export const Save = Schema.Struct({
  identity: Identity,
  expected: Schema.optional(Token),
  content: Content,
  mutation: short,
}).annotate(strict)
export const Clear = Schema.Struct({ identity: Identity, expected: Token, mutation: short }).annotate(strict)
export const Promote = Schema.Struct({
  from: Identity,
  to: Identity,
  source: Token,
  target: Schema.optional(Token),
  mutation: short,
}).annotate(strict)

export class ComposerDraftError extends Schema.TaggedErrorClass<ComposerDraftError>()(
  "ComposerDraftError",
  {
    code: Schema.Literals([
      "invalid",
      "scope",
      "corrupt",
      "missing",
      "conflict",
      "capacity",
      "admission",
      "unavailable",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const root = "/kilocode/composer-drafts"
export const endpoints = [
  HttpApiEndpoint.post("composerDraftList", `${root}/list`, {
    query: WorkspaceRoutingQuery,
    payload: List,
    success: Schema.Struct({ entries: Schema.Array(Entry) }),
    error: ComposerDraftError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "kilocode.composerDraft.list", summary: "List scoped composer drafts" }),
  ),
  HttpApiEndpoint.post("composerDraftLoad", `${root}/load`, {
    query: WorkspaceRoutingQuery,
    payload: Load,
    success: Schema.Struct({ entry: Schema.NullOr(Entry) }),
    error: ComposerDraftError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "kilocode.composerDraft.load", summary: "Load a scoped composer draft" }),
  ),
  HttpApiEndpoint.post("composerDraftSave", `${root}/save`, {
    query: WorkspaceRoutingQuery,
    payload: Save,
    success: Schema.Struct({ entry: Entry }),
    error: ComposerDraftError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "kilocode.composerDraft.save", summary: "Commit a composer draft revision" }),
  ),
  HttpApiEndpoint.post("composerDraftClear", `${root}/clear`, {
    query: WorkspaceRoutingQuery,
    payload: Clear,
    success: Schema.Struct({ entry: Entry }),
    error: ComposerDraftError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "kilocode.composerDraft.clear",
      summary: "Clear an exact composer draft revision",
    }),
  ),
  HttpApiEndpoint.post("composerDraftPromote", `${root}/promote`, {
    query: WorkspaceRoutingQuery,
    payload: Promote,
    success: Schema.Struct({ source: Entry, target: Entry }),
    error: ComposerDraftError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "kilocode.composerDraft.promote",
      summary: "Promote a pending composer draft atomically",
    }),
  ),
] as const
