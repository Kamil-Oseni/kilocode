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
const Receipt = Schema.Struct({
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

export function artifacts(storage: Pick<Storage.Interface, "read" | "create">, root?: string) {
  const completion = completions(storage, repairs(storage))
  const checks = verification(storage, root)
  const key = (session: string, message: string, call: string) => [
    "raya",
    "self-heal",
    "artifact",
    hash(JSON.stringify([session, message, call])),
  ]
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
  return { run, status }
}
