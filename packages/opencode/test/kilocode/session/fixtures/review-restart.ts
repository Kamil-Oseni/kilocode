import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { revision } from "@/kilocode/session/review-revision"
import { provideInstance, seedProject, testInstanceStoreLayer } from "../../../fixture/fixture"

const [mode, dir, control] = process.argv.slice(2)
if (!mode || !dir || !control) throw new Error("Expected mode, workspace and control file")
const Input = Schema.Struct({
  sessionID: SessionID,
  files: Schema.Array(Schema.String),
  expected: Schema.Record(Schema.String, Schema.String),
  requestID: Schema.String,
})
const layer = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionRevert.node,
    SessionSummary.node,
    Snapshot.node,
    Storage.node,
    CrossSpawnSpawner.node,
    Database.node,
  ]),
)
const run = Effect.gen(function* () {
  yield* seedProject
  const sessions = yield* Session.Service
  const revert = yield* SessionRevert.Service
  const summary = yield* SessionSummary.Service
  const snapshot = yield* Snapshot.Service
  const storage = yield* Storage.Service
  const file = path.join(dir, "notes.txt")
  if (mode === "seed") {
    const session = yield* sessions.create({})
    const providerID = ProviderV2.ID.make("test")
    const modelID = ModelV2.ID.make("test")
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const save = Effect.fn("ReviewRestart.save")(function* (start: string, finish: string) {
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "default",
        model: { providerID, modelID },
        time: { created: Date.now() },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: user.id,
        mode: "default",
        agent: "default",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens,
        modelID,
        providerID,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      const patch = yield* snapshot.patch(start, finish)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "step-start",
        snapshot: start,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "step-finish",
        reason: "stop",
        snapshot: finish,
        cost: 0,
        tokens,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "patch",
        hash: patch.hash,
        files: patch.files,
      })
    })
    yield* Effect.promise(() => fs.writeFile(file, "A"))
    const first = yield* snapshot.track({ snapshotInitialization: "wait" })
    if (!first) throw new Error("Missing first snapshot")
    yield* Effect.promise(() => fs.writeFile(file, "B"))
    const middle = yield* snapshot.track({ snapshotInitialization: "wait" })
    if (!middle) throw new Error("Missing middle snapshot")
    yield* save(first, middle)
    yield* Effect.promise(() => fs.writeFile(file, "C"))
    const last = yield* snapshot.track({ snapshotInitialization: "wait" })
    if (!last) throw new Error("Missing last snapshot")
    yield* save(middle, last)
    yield* storage.write(["session_diff", session.id], yield* snapshot.diffFull(first, last))
    const current = (yield* summary.diff({ sessionID: session.id })).find((diff) => diff.file === "notes.txt")
    if (!current) throw new Error("Missing current review")
    const input = {
      sessionID: session.id,
      files: [file],
      expected: { [file]: revision(current) },
      requestID: "restart-first-undo",
    }
    yield* revert.discardChanges(input)
    const [key] = yield* storage.list(["review_receipt", session.id])
    if (!key) throw new Error("Missing persisted receipt")
    const receipt = yield* storage.read<Record<string, unknown>>(key)
    yield* storage.replace(key, { ...receipt, complete: false })
    yield* storage.remove(["session_undo", session.id])
    yield* Effect.promise(() => fs.writeFile(control, JSON.stringify(input)))
    process.stdout.write(
      `REVIEW_READY ${JSON.stringify({ pid: process.pid, bytes: yield* Effect.promise(() => fs.readFile(file, "utf8")) })}\n`,
    )
    yield* Effect.never
    return
  }
  const input = Schema.decodeUnknownSync(Input)(yield* Effect.promise(() => Bun.file(control).json()))
  const result = yield* revert.discardChanges(input).pipe(Effect.exit)
  const bytes = yield* Effect.promise(() => fs.readFile(file, "utf8"))
  if (mode === "unknown") {
    process.stdout.write(
      `REVIEW_RESULT ${JSON.stringify({ pid: process.pid, refused: Exit.isFailure(result), bytes })}\n`,
    )
    return
  }
  if (mode !== "resume") throw new Error(`Unknown mode ${mode}`)
  if (Exit.isFailure(result)) yield* Effect.failCause(result.cause)
  const pending = (yield* summary.diff({ sessionID: input.sessionID })).find((diff) => diff.file === "notes.txt")
  if (!pending) throw new Error("Missing restarted intermediate review")
  const detail = yield* summary.diff({ sessionID: input.sessionID, file: "notes.txt", full: true })
  yield* revert.discardChanges({
    sessionID: input.sessionID,
    files: [file],
    expected: { [file]: revision(pending) },
    requestID: "restart-second-undo",
  })
  process.stdout.write(
    `REVIEW_RESULT ${JSON.stringify({ pid: process.pid, bytes, detail, final: yield* Effect.promise(() => fs.readFile(file, "utf8")), remaining: yield* summary.diff({ sessionID: input.sessionID }) })}\n`,
  )
})

await Effect.runPromise(run.pipe(provideInstance(dir), Effect.provide(testInstanceStoreLayer), Effect.provide(layer)))
