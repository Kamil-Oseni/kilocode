import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID, MessageID } from "@/session/schema"
import { repairs, type Outcome } from "./repair"
import { completions } from "./completion"
import { verification } from "./verification"
import { materialize, unchanged } from "./snapshot"
import { Build, hash, identity } from "./build-input"
import { inspect } from "./artifact-inspect"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Bytes = Schema.Struct({ digest: Hash, size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  itemID: Schema.String,
  attemptID: Schema.String,
  sessionID: SessionID,
  messageID: MessageID,
  callID: Schema.String,
  completion: Hash,
  checks: Schema.Array(Schema.String),
  source: Hash,
  head: Schema.String,
  target: Build.fields.target,
  extension: Build.fields.extension,
  cli: Build.fields.cli,
  contract: Schema.String,
  status: Schema.Literal("ready-for-review"),
  output: Schema.String,
  artifact: Bytes,
  binary: Bytes,
  at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Raya.SelfHealArtifact" })

const Pointer = Schema.Struct({
  version: Schema.Literal(1),
  itemID: Schema.String,
  attemptID: Schema.String,
  sessionID: SessionID,
  messageID: MessageID,
  callID: Schema.String,
  completion: Hash,
  at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})

export const Review = Schema.Struct({
  artifactID: Schema.String,
  digest: Hash,
  extension: Build.fields.extension,
})

export const Approval = Schema.Struct({
  ...Pointer.fields,
  id: Schema.String,
  artifactID: Schema.String,
  source: Hash,
  head: Schema.String,
  extension: Build.fields.extension,
  artifact: Bytes,
  binary: Bytes,
  status: Schema.Literal("install-ready"),
  at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Raya.SelfHealArtifactApproval" })

export class ReviewConflict extends Schema.TaggedErrorClass<ReviewConflict>()("SelfHeal.ReviewConflict", {
  message: Schema.String,
}) {}

const Terminal = Schema.Struct({
  status: Schema.Literals(["failed", "interrupted"]),
  reason: Schema.String,
  at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})

export const Delivery = Schema.Struct({
  ...Pointer.fields,
  status: Schema.Literals([
    "preparing",
    "building",
    "ready-for-review",
    "install-ready",
    "artifact-unavailable",
    "failed",
    "interrupted",
  ]),
  artifact: Schema.optional(Receipt),
  approval: Schema.optional(Approval),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Raya.SelfHealDelivery" })

export function artifacts(storage: Pick<Storage.Interface, "list" | "read" | "create">, root?: string) {
  const completion = completions(storage, repairs(storage))
  const checks = verification(storage, root)
  const cache = { legacy: undefined as Map<string, Array<typeof Receipt.Type>> | undefined }
  const key = (session: string, message: string, call: string) => [
    "raya",
    "self-heal",
    "artifact",
    hash(JSON.stringify([session, message, call])),
  ]
  const itemkey = (id: string) => ["raya", "self-heal", "artifact-item", id]
  const approvalkey = (id: string) => ["raya", "self-heal", "artifact-approval", id]
  const read = (session: string, message: string, call: string, stage: string) =>
    storage.read<unknown>([...key(session, message, call), stage]).pipe(
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  const status = Effect.fn(function* (session: string, message: string, call: string) {
    const intent = yield* read(session, message, call, "intent")
    if (!intent) return undefined
    const build = yield* read(session, message, call, "build")
    const result = yield* read(session, message, call, "result")
    const observed =
      result && build
        ? yield* Effect.gen(function* () {
            const input = Schema.decodeUnknownSync(Build)(build)
            const completed = yield* completion.get(input.itemID)
            if (!completed || hash(JSON.stringify(completed)) !== input.completion)
              throw new Error("Retained artifact completion is missing or changed")
            const source = yield* checks.lineage(completed)
            if (
              completed.itemID !== input.itemID ||
              completed.attemptID !== input.attemptID ||
              hash(JSON.stringify(source.snapshot)) !== hash(JSON.stringify(input.snapshot)) ||
              JSON.stringify(source.checks) !== JSON.stringify(input.checks)
            )
              throw new Error("Retained build input no longer matches the completed check lineage")
            const retained = yield* Effect.promise(() => inspect(input))
            const published = Schema.decodeUnknownSync(Receipt)(result)
            if (
              published.sessionID !== session ||
              published.messageID !== message ||
              published.callID !== call ||
              Object.entries(identity(input)).some(
                ([key, value]) => JSON.stringify(Reflect.get(published, key)) !== JSON.stringify(value),
              )
            )
              throw new Error("Retained artifact invocation identity is inconsistent")
            if (
              retained.artifact.digest !== published.artifact?.digest ||
              retained.artifact.size !== published.artifact?.size ||
              retained.binary.digest !== published.binary?.digest ||
              retained.binary.size !== published.binary?.size ||
              published.output !== input.output
            )
              throw new Error("Artifact bytes no longer match the retained receipt")
            return { status: "matches-receipt" as const, at: Date.now() }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({ status: "unavailable-or-changed" as const, reason: Cause.pretty(cause) }),
            ),
          )
        : undefined
    return {
      intent,
      build,
      preparation: yield* read(session, message, call, "preparation"),
      dispatch: yield* read(session, message, call, "dispatch"),
      result,
      observed,
      terminal: yield* read(session, message, call, "terminal"),
      guidance:
        "A retained artifact is ready for review only. Publication and installation are separate. Missing terminal acknowledgement is unknown; inspection never repeats a build.",
    }
  })
  const legacy = Effect.fn(function* (id: string) {
    if (cache.legacy) return cache.legacy.get(id) ?? []
    const keys = yield* storage.list(["raya", "self-heal", "artifact"]).pipe(Effect.orDie)
    const rows = yield* Effect.forEach(
      keys.filter((key) => key.length === 5 && key.at(-1) === "result"),
      (key) => storage.read<unknown>(key).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)), Effect.orDie),
    )
    const grouped = new Map<string, Array<typeof Receipt.Type>>()
    for (const row of rows) grouped.set(row.itemID, [...(grouped.get(row.itemID) ?? []), row])
    cache.legacy = grouped
    return grouped.get(id) ?? []
  })
  const approved = Effect.fn(function* (id: string) {
    return yield* storage.read<unknown>(approvalkey(id)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Approval)),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  })
  const find = Effect.fn(function* (id: string) {
    const saved = yield* storage.read<unknown>(itemkey(id)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Pointer)),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
    const previous = saved ? undefined : yield* legacy(id)
    if (previous && previous.length > 1)
      throw new Error("Repair has multiple legacy artifact receipts; reconcile them before delivery")
    const prior = previous?.[0]
    const pointer = saved ?? (prior ? Schema.decodeUnknownSync(Pointer)(prior) : undefined)
    if (!pointer) return undefined
    if (pointer.itemID !== id) throw new Error("Retained artifact pointer belongs to another repair")
    const state = yield* status(pointer.sessionID, pointer.messageID, pointer.callID)
    if (!state) throw new Error("Retained artifact pointer has no invocation journal")
    if (state.result && state.observed?.status === "matches-receipt") {
      const artifact = Schema.decodeUnknownSync(Receipt)(state.result)
      const approval = yield* approved(id)
      if (approval) {
        if (
          approval.itemID !== artifact.itemID ||
          approval.attemptID !== artifact.attemptID ||
          approval.sessionID !== artifact.sessionID ||
          approval.messageID !== artifact.messageID ||
          approval.callID !== artifact.callID ||
          approval.completion !== artifact.completion ||
          approval.artifactID !== artifact.id ||
          approval.source !== artifact.source ||
          approval.head !== artifact.head ||
          approval.extension !== artifact.extension ||
          approval.artifact.digest !== artifact.artifact.digest ||
          approval.artifact.size !== artifact.artifact.size ||
          approval.binary.digest !== artifact.binary.digest ||
          approval.binary.size !== artifact.binary.size
        )
          return Schema.decodeUnknownSync(Delivery)({
            ...pointer,
            status: "artifact-unavailable",
            reason: "The retained release approval no longer matches the verified artifact receipt.",
          })
        return Schema.decodeUnknownSync(Delivery)({
          ...pointer,
          status: "install-ready",
          artifact,
          approval,
        })
      }
      return Schema.decodeUnknownSync(Delivery)({
        ...pointer,
        status: "ready-for-review",
        artifact,
      })
    }
    if (state.result)
      return Schema.decodeUnknownSync(Delivery)({
        ...pointer,
        status: "artifact-unavailable",
        reason:
          state.observed?.status === "unavailable-or-changed"
            ? state.observed.reason
            : "Artifact bytes could not be verified against the retained receipt",
      })
    if (state.terminal) {
      const terminal = Schema.decodeUnknownSync(Terminal)(state.terminal)
      return Schema.decodeUnknownSync(Delivery)({
        ...pointer,
        status: terminal.status,
        reason: terminal.reason,
        at: terminal.at,
      })
    }
    return Schema.decodeUnknownSync(Delivery)({
      ...pointer,
      status: state.dispatch ? "building" : "preparing",
    })
  })
  const approve = Effect.fn(function* (id: string, input: typeof Review.Type) {
    const delivery = yield* find(id)
    if (!delivery) return undefined
    if (delivery.status === "install-ready") {
      if (
        delivery.approval?.artifactID === input.artifactID &&
        delivery.approval.artifact.digest === input.digest &&
        delivery.approval.extension === input.extension
      )
        return delivery.approval
      return yield* new ReviewConflict({ message: "This repair already has a different retained release approval." })
    }
    if (delivery.status !== "ready-for-review" || !delivery.artifact)
      return yield* new ReviewConflict({ message: "This repair does not have a currently verified review artifact." })
    if (
      delivery.artifact.id !== input.artifactID ||
      delivery.artifact.artifact.digest !== input.digest ||
      delivery.artifact.extension !== input.extension
    )
      return yield* new ReviewConflict({
        message: "The reviewed artifact identity is stale or does not match the retained receipt.",
      })
    const value = Schema.decodeUnknownSync(Approval)({
      version: 1,
      id: randomUUID(),
      itemID: delivery.artifact.itemID,
      attemptID: delivery.artifact.attemptID,
      sessionID: delivery.artifact.sessionID,
      messageID: delivery.artifact.messageID,
      callID: delivery.artifact.callID,
      completion: delivery.artifact.completion,
      artifactID: delivery.artifact.id,
      source: delivery.artifact.source,
      head: delivery.artifact.head,
      extension: delivery.artifact.extension,
      artifact: delivery.artifact.artifact,
      binary: delivery.artifact.binary,
      status: "install-ready",
      at: Date.now(),
    })
    if (yield* storage.create(approvalkey(id), value).pipe(Effect.orDie)) return value
    const retained = yield* approved(id)
    if (
      retained?.artifactID === value.artifactID &&
      retained.artifact.digest === value.artifact.digest &&
      retained.extension === value.extension
    )
      return retained
    return yield* new ReviewConflict({ message: "Another release decision already owns this repair artifact." })
  })
  const run = Effect.fn(function* (input: {
    outcome: typeof Outcome.Type
    sessionID: SessionID
    messageID: MessageID
    callID: string
    setup: string
    current: () => Effect.Effect<void>
    execute: (command: string, directory: string) => Effect.Effect<{ output: string; metadata: { exit?: unknown } }>
  }) {
    const id = randomUUID()
    const stage = (name: string, value: unknown) =>
      storage.create([...key(input.sessionID, input.messageID, input.callID), name], value).pipe(Effect.orDie)
    if (
      !(yield* stage("intent", {
        id,
        itemID: input.outcome.itemID,
        attemptID: input.outcome.id,
        setup: input.setup,
        at: Date.now(),
      }))
    )
      throw new Error("This artifact invocation already has retained intent; inspect it instead of replaying")
    return yield* Effect.gen(function* () {
      yield* input.current()
      const receipt = yield* completion.get(input.outcome.itemID)
      if (!receipt || receipt.attemptID !== input.outcome.id || receipt.sessionID !== input.sessionID)
        throw new Error("Artifact preparation requires this session's authoritative completed repair")
      const source = yield* checks.lineage(receipt)
      const previous = yield* legacy(input.outcome.itemID)
      if (previous.length)
        throw new Error("This repair already has a retained artifact; inspect it instead of rebuilding")
      const pointer = Schema.decodeUnknownSync(Pointer)({
        version: 1,
        itemID: receipt.itemID,
        attemptID: receipt.attemptID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
        completion: hash(JSON.stringify(receipt)),
        at: Date.now(),
      })
      if (!(yield* storage.create(itemkey(receipt.itemID), pointer).pipe(Effect.orDie)))
        throw new Error("This repair already has retained artifact intent; inspect it instead of rebuilding")
      const directory = yield* Effect.promise(() => materialize(source.store, source.snapshot))
      const pkg = yield* Effect.promise(() =>
        Bun.file(path.join(directory, "packages/kilo-vscode/package.json")).json(),
      )
      if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version))
        throw new Error("Unsupported extension base version")
      const version = `${pkg.version}-repair+${id.replaceAll("-", "")}`
      const build = Schema.decodeUnknownSync(Build)({
        version: 1,
        id,
        itemID: receipt.itemID,
        attemptID: receipt.attemptID,
        completion: hash(JSON.stringify(receipt)),
        checks: source.checks,
        snapshot: source.snapshot,
        directory,
        output: path.join(directory, ".git", "raya-artifact.vsix"),
        target: `${process.platform}-${process.arch}`,
        extension: version,
        cli: version,
        at: Date.now(),
      })
      yield* stage("build", build)
      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, ".git", "raya-build-input.json"), JSON.stringify(build), { flag: "wx" }),
      )
      yield* stage("preparation", { command: input.setup, directory, at: Date.now() })
      const prepared = yield* input.execute(input.setup, directory)
      if (prepared.metadata.exit !== 0) throw new Error("Artifact dependency preparation did not exit successfully")
      yield* Effect.promise(() => unchanged(directory, source.snapshot))
      yield* input.current()
      yield* stage("dispatch", {
        at: Date.now(),
        command: "bun packages/kilo-vscode/script/dev-snapshot.ts repair .git/raya-build-input.json",
      })
      const result = yield* input.execute(
        "bun packages/kilo-vscode/script/dev-snapshot.ts repair .git/raya-build-input.json",
        directory,
      )
      if (result.metadata.exit !== 0) throw new Error("Repair artifact build did not exit successfully")
      yield* Effect.promise(() => unchanged(directory, source.snapshot))
      yield* input.current()
      const retained = yield* completion.get(input.outcome.itemID)
      if (hash(JSON.stringify(retained)) !== build.completion)
        throw new Error("Completion changed during artifact preparation")
      yield* checks.lineage(receipt)
      const evidence = yield* Effect.promise(() => inspect(build))
      yield* Effect.promise(() => unchanged(directory, source.snapshot))
      yield* input.current()
      const artifact = Schema.decodeUnknownSync(Receipt)({
        ...identity(build),
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
        status: "ready-for-review" as const,
        output: build.output,
        ...evidence,
        at: Date.now(),
      })
      if (!(yield* stage("result", artifact)))
        throw new Error("Artifact result already exists; inspect before recovery")
      return { output: JSON.stringify(artifact, null, 2), metadata: { artifact: id, status: artifact.status } }
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? stage("terminal", {
              status: Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
              reason: Cause.pretty(exit.cause).slice(0, 10_000),
              at: Date.now(),
            }).pipe(Effect.asVoid)
          : Effect.void,
      ),
    )
  })
  return { run, status, find, approve }
}
