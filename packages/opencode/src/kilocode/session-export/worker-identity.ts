import { sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { workerScopes } from "../cli/worker-scopes"
import path from "node:path"
import { Schema } from "effect"
import { fingerprint } from "../cli/profile-retirement"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const Identity = Schema.Struct({
  version: Schema.Literal(1),
  runID: Schema.String,
  generation: Schema.String,
  role: Schema.Literal("session-export-worker"),
})
const Request = Schema.Struct({ ...Identity.fields, requestID: Schema.String })
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
  kind: Schema.Literal("shutdown_done"),
  status: Schema.Literal("confirmed"),
  receipt: Receipt,
  scopes: Schema.optional(Schema.Unknown),
})

export function identity(input: unknown) {
  const value = Schema.decodeUnknownSync(Identity)(input)
  if (!UUID.test(value.runID) || !UUID.test(value.generation))
    throw new Error("Session export worker identity is invalid")
  return Object.freeze(value)
}

export function spawn(runID: string) {
  return identity({ version: 1, runID, generation: crypto.randomUUID(), role: "session-export-worker" })
}

export function request(owner: ReturnType<typeof identity>): ReturnType<typeof accept> {
  return Object.freeze({ ...owner, requestID: crypto.randomUUID() })
}

export function accept(input: unknown, owner: ReturnType<typeof identity>) {
  const value = Schema.decodeUnknownSync(Request)(input)
  identity(value)
  if (
    !UUID.test(value.requestID) ||
    value.runID !== owner.runID ||
    value.generation !== owner.generation ||
    value.role !== owner.role
  )
    throw new Error("Session export shutdown identity does not match")
  return Object.freeze(value)
}

export function acknowledge(input: ReturnType<typeof request>, receipt: unknown) {
  return validate({ ...input, kind: "shutdown_done", status: "confirmed", receipt, scopes: sourceScopes() }, input)
}

export function validate(input: unknown, expected: ReturnType<typeof request>) {
  const value = Schema.decodeUnknownSync(Reply)(input)
  const selected = accept(value, expected)
  if (selected.requestID !== expected.requestID)
    throw new Error("Session export shutdown acknowledgment identity does not match")
  const receipt = value.receipt
  const normalize = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
  const keys: string[] = []
  for (const root of receipt.roots) {
    if (!path.isAbsolute(root.path) || path.normalize(root.path) !== root.path)
      throw new Error("Session export shutdown root is not canonical absolute metadata")
    const key = `raya.profile.${root.kind}:${normalize(root.path)}`
    if (keys.includes(key) || (keys.length && keys[keys.length - 1] > key))
      throw new Error("Session export shutdown roots are duplicated or unordered")
    keys.push(key)
  }
  if (
    (receipt.roots.length === 0) !== (receipt.observation === "no-participating-roots") ||
    receipt.inventory !== fingerprint(receipt.roots)
  )
    throw new Error("Session export root receipt SHA or observation identity does not match")
  if (
    !input ||
    typeof input !== "object" ||
    !("receipt" in input) ||
    !input.receipt ||
    typeof input.receipt !== "object" ||
    "nativeOwners" in input.receipt ||
    "operations" in input.receipt ||
    "scope" in input.receipt
  )
    throw new Error("Session export local observation cannot claim global zero owners")
  return Object.freeze({
    ...value,
    scopes: workerScopes(value.scopes, receipt.roots),
    receipt: Object.freeze({
      ...receipt,
      roots: Object.freeze(receipt.roots.map((root) => Object.freeze({ ...root }))),
    }),
  })
}
