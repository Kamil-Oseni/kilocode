import { sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { workerScopes } from "../../worker-scopes"
import path from "node:path"
import { Schema } from "effect"
import { fingerprint } from "../../profile-retirement"

export const GENERATION = "KILO_WORKER_GENERATION"
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const Request = Schema.Struct({
  version: Schema.Literal(1),
  runID: Schema.String,
  generation: Schema.String,
  requestID: Schema.String,
})
const decode = Schema.decodeUnknownSync(Request)
const Root = Schema.Struct({ kind: Schema.Literals(["sqlite", "json"]), path: Schema.String })
const flags = {
  version: Schema.Literal(1),
  roots: Schema.Array(Root),
  participantOnly: Schema.Literal(true),
  cooperativeOnly: Schema.Literal(true),
  completeProfileCoverage: Schema.Literal(false),
  portableCaptureAuthorized: Schema.Literal(false),
  portable: Schema.Literal(false),
}
const Receipt = Schema.Struct({
  ...flags,
  format: Schema.Literal("raya.profile-root-observation"),
  observation: Schema.Literals(["participating-roots", "no-participating-roots"]),
  processLocal: Schema.Literal(true),
  inventory: Schema.String,
})
const Reply = Schema.Struct({
  ...Request.fields,
  format: Schema.Literal("raya.tui-worker-shutdown"),
  role: Schema.Literal("worker"),
  status: Schema.Literal("confirmed"),
  receipt: Receipt,
  scopes: Schema.optional(Schema.Unknown),
})

export function identity(env: Record<string, string | undefined>) {
  const runID = env.KILO_RUN_ID
  const generation = env[GENERATION]
  if (!runID || !generation || !uuid.test(generation))
    throw new Error("TUI worker shutdown identity is missing or invalid")
  return Object.freeze({ runID, generation })
}

export function request(owner: ReturnType<typeof identity>) {
  const requestID: string = crypto.randomUUID()
  return Object.freeze({ version: 1 as const, ...owner, requestID })
}

export function accept(input: unknown, owner: ReturnType<typeof identity>) {
  const value = decode(input)
  if (value.runID !== owner.runID || value.generation !== owner.generation || !uuid.test(value.requestID))
    throw new Error("TUI worker shutdown request identity does not match")
  return value
}

export function bind(owner: ReturnType<typeof identity>) {
  let selected: ReturnType<typeof accept> | undefined
  return (input: unknown) => {
    const value = accept(input, owner)
    if (selected && selected.requestID !== value.requestID)
      throw new Error("TUI worker shutdown request changed after retirement began")
    return (selected ??= value)
  }
}

export function acknowledge(input: ReturnType<typeof request>, receipt: unknown) {
  return validate(
    {
      ...input,
      format: "raya.tui-worker-shutdown",
      role: "worker",
      status: "confirmed",
      receipt,
      scopes: sourceScopes(),
    },
    input,
  )
}

export function validate(input: unknown, expected: ReturnType<typeof request>) {
  if (input && typeof input === "object" && "receipt" in input) {
    const receipt = input.receipt
    if (
      receipt &&
      typeof receipt === "object" &&
      ("nativeOwners" in receipt || "operations" in receipt || "scope" in receipt)
    )
      throw new Error("TUI worker shutdown observation cannot claim global admission")
  }
  const value = (() => {
    try {
      return Schema.decodeUnknownSync(Reply)(input)
    } catch (err) {
      throw new Error("TUI worker shutdown acknowledgment schema is invalid", { cause: err })
    }
  })()
  if (
    value.runID !== expected.runID ||
    value.generation !== expected.generation ||
    value.requestID !== expected.requestID
  )
    throw new Error("TUI worker shutdown acknowledgment identity does not match")
  const receipt = value.receipt
  const keys = new Set<string>()
  const ordered: string[] = []
  for (const root of receipt.roots) {
    if (!path.isAbsolute(root.path) || path.normalize(root.path) !== root.path)
      throw new Error("TUI worker shutdown root is not canonical absolute metadata")
    const key = `${root.kind}:${process.platform === "win32" ? root.path.toLowerCase() : root.path}`
    if (keys.has(key)) throw new Error("TUI worker shutdown roots are duplicated")
    keys.add(key)
    ordered.push(`raya.profile.${key}`)
  }
  if ((receipt.observation === "no-participating-roots") !== (receipt.roots.length === 0))
    throw new Error("TUI worker shutdown observation metadata is inconsistent")
  const sorted = [...ordered].sort()
  if (receipt.inventory !== fingerprint(receipt.roots) || ordered.some((key, index) => key !== sorted[index]))
    throw new Error("TUI worker shutdown root inventory does not match its fingerprint")
  return Object.freeze({
    ...value,
    scopes: workerScopes(value.scopes, receipt.roots),
    receipt: Object.freeze({
      ...receipt,
      roots: Object.freeze(receipt.roots.map((root) => Object.freeze({ ...root }))),
    }),
  })
}
