import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Exit, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ReviewGate } from "@/kilocode/session/review-gate"
import { transaction } from "@/kilocode/session/review-transaction"
import { recovery } from "@/kilocode/session/review-receipt"
import { revision } from "@/kilocode/session/review-revision"
import * as Project from "@/project/project"
import { InstanceState } from "@/effect/instance-state"
import { provideInstance, seedProject, testInstanceStoreLayer } from "../../../fixture/fixture"

const [mode, dir, control] = process.argv.slice(2)
if (!mode || !dir || !control) throw new Error("Expected mode, directory and control")
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
    SessionSummary.node,
    SessionRunState.node,
    Snapshot.node,
    Storage.node,
    CrossSpawnSpawner.node,
    Database.node,
    Project.node,
    ReviewGate.node,
    EventV2Bridge.node,
  ]),
)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const program = Effect.gen(function* () {
  yield* seedProject
  const sessions = yield* Session.Service
  const snap = yield* Snapshot.Service
  const storage = yield* Storage.Service
  const summary = yield* SessionSummary.Service
  const state = yield* SessionRunState.Service
  const gate = yield* ReviewGate.Service
  const events = yield* EventV2Bridge.Service
  const project = yield* Project.Service
  const files = ["alpha", "beta"].map((name) => path.join(dir, name, "notes.txt"))
  const bytes = () => Effect.promise(() => Promise.all(files.map((file) => fs.readFile(file, "utf8"))))
  const pause = Effect.gen(function* () {
    const input = Schema.decodeUnknownSync(Input)(yield* Effect.promise(() => Bun.file(control).json()))
    const raw = yield* storage.read<unknown[]>(["session_diff", input.sessionID])
    const ledger = yield* storage
      .read<{ files: Record<string, string[]> }>(["session_undo", input.sessionID])
      .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed({ files: {} })))
    const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    process.stdout.write(
      `RECOVERY_READY ${JSON.stringify({ pid: process.pid, bytes: yield* bytes(), raw: raw.length, ledger: Object.values(ledger.files).flat().length, revert: session.revert?.diff ?? null })}\n`,
    )
    yield* Effect.never
  }).pipe(Effect.orDie)
  let calls = 0
  // These are real delegates: fault injection changes scheduling, never native results.
  const driver: Snapshot.Interface = {
    ...snap,
    revert: (patches, expected) =>
      Effect.gen(function* () {
        calls++
        yield* snap.revert(patches, expected)
        if (mode === "first" && calls === 1) yield* pause
        if (mode === "partial" && calls === 2) {
          yield* Effect.promise(() => fs.writeFile(files[0], "manual during failure\r\n"))
          yield* Effect.die(new Error("Interrupted second owner after its native restore"))
        }
      }),
  }
  const disk: Storage.Interface = {
    ...storage,
    create: (key, value) =>
      Effect.gen(function* () {
        const created = yield* storage.create(key, value)
        if (created && mode === "claim" && key[0] === "review_receipt") yield* pause
        return created
      }),
    write: (key, value) =>
      Effect.gen(function* () {
        if (mode === "all" && key[0] === "session_diff" && calls === 2) yield* pause
        yield* storage.write(key, value)
        if (calls === 2 && mode === "cleanup" && key[0] === "session_diff") yield* pause
        if (calls === 2 && mode === "ledger" && key[0] === "session_undo") yield* pause
      }),
  }
  const gather = Effect.fn("RecoveryFixture.gather")(function* (id: SessionID) {
    return yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie)
  })
  const receipts = recovery({
    sessions,
    snap: driver,
    storage: disk,
    summary,
    state,
    gather,
    publish: (sessionID, diff) => events.publish(Session.Event.Diff, { sessionID, diff }),
  })
  const reviews = transaction({
    sessions,
    snap: driver,
    storage: disk,
    summary,
    state,
    gate,
    events,
    project,
    reconcile: (id, proof) => receipts.reconcile(id, proof).pipe(Effect.provideService(Project.Service, project)),
  })
  const save = Effect.fn("RecoveryFixture.save")(function* (
    session: Session.Info,
    file: string,
    before: string,
    after: string,
  ) {
    const ctx = yield* InstanceState.context
    yield* Effect.promise(() => fs.writeFile(file, before))
    const start = yield* snap.track({ snapshotInitialization: "wait" })
    yield* Effect.promise(() => fs.writeFile(file, after))
    const finish = yield* snap.track({ snapshotInitialization: "wait" })
    if (!start || !finish) throw new Error("Missing real worker checkpoint")
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      agent: "default",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      parentID: user.id,
      role: "assistant",
      agent: "default",
      mode: "default",
      path: { cwd: ctx.directory, root: ctx.worktree },
      cost: 0,
      tokens,
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "end_turn",
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: message.id,
      type: "step-start",
      snapshot: start,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: message.id,
      type: "step-finish",
      snapshot: finish,
      reason: "stop",
      cost: 0,
      tokens,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: message.id,
      type: "patch",
      ...(yield* snap.patch(start, finish)),
    })
    yield* storage.write(["session_diff", session.id], yield* snap.diffFull(start, finish))
    return message
  })
  if (["first", "all", "claim", "cleanup", "ledger", "partial"].includes(mode)) {
    const parent = yield* sessions.create({})
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: parent.id,
      role: "user",
      agent: "default",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    for (const name of ["alpha", "beta"]) {
      const branch = path.join(dir, name)
      yield* Effect.promise(async () => {
        const proc = Bun.spawn(["git", "worktree", "add", "--detach", branch], {
          cwd: dir,
          stdout: "ignore",
          stderr: "pipe",
          windowsHide: true,
        })
        const err = await new Response(proc.stderr).text()
        if ((await proc.exited) !== 0) throw new Error(err)
      })
      yield* Effect.gen(function* () {
        const child = yield* sessions.create({ parentID: parent.id })
        yield* save(child, path.join(branch, "notes.txt"), `${name} original\r\n`, `${name} edited\r\n`)
      }).pipe(provideInstance(branch))
    }
    yield* sessions.setRevert({
      sessionID: parent.id,
      revert: { messageID: user.id, diff: "original", workspace: "unavailable" },
      summary: undefined,
    })
    const diffs = yield* summary.diff({ sessionID: parent.id })
    yield* storage.write(["session_diff", parent.id], diffs)
    const input = {
      sessionID: parent.id,
      files,
      expected: Object.fromEntries(diffs.map((diff) => [diff.file!, revision(diff)])),
      requestID: "real-two-owner-recovery",
    }
    yield* Effect.promise(() => fs.writeFile(control, JSON.stringify(input)))
    if (mode === "partial") {
      const outcome = yield* reviews.undo(input, Effect.die(new Error("Unexpected local-only route"))).pipe(Effect.exit)
      if (Exit.isSuccess(outcome)) throw new Error("Expected actual interrupted owner failure")
      yield* pause
    }
    yield* reviews.undo(input, Effect.die(new Error("Unexpected local-only route")))
    throw new Error("Missing native fault milestone")
  }
  const input = Schema.decodeUnknownSync(Input)(yield* Effect.promise(() => Bun.file(control).json()))
  const key = ["review_receipt", input.sessionID, createHash("sha256").update(input.requestID).digest("hex")]
  const original = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
  const stored = yield* storage
    .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
    .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([] as Snapshot.FileDiff[])))
  let inserted: { sessionID: SessionID; messageID: MessageID } | undefined
  if (mode === "replaced")
    yield* sessions.setRevert({
      sessionID: input.sessionID,
      revert: { ...original.revert!, diff: "newer revert" },
      summary: original.summary,
    })
  if (mode === "raw")
    yield* storage.write(
      ["session_diff", input.sessionID],
      stored.map((diff) => ({ ...diff, after: "newer stored detail" })),
    )
  if (mode === "generation" || mode === "report" || mode === "unrelated") {
    const children = yield* sessions.children(input.sessionID)
    const child = children.find((child) => path.basename(child.directory) === "alpha")
    if (!child) throw new Error("Missing alpha worker")
    const messages = yield* sessions.messages({ sessionID: child.id }).pipe(Effect.orDie)
    const old = messages.find((message) => message.info.role === "assistant")
    if (!old || old.info.role !== "assistant") throw new Error("Missing worker history")
    if (mode === "report") {
      const message = yield* sessions.updateMessage({ ...old.info, id: MessageID.ascending() })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: child.id,
        messageID: message.id,
        type: "text",
        text: "Read-only report arrived after interruption.",
      })
    }
    if (mode === "generation") {
      // A real persisted fresh generation claims identical target bytes; recovery must refuse it.
      const fresh = yield* save(child, files[0], "alpha edited\r\n", "alpha original\r\n").pipe(
        provideInstance(child.directory),
      )
      inserted = { sessionID: child.id, messageID: fresh.id }
    }
    if (mode === "unrelated")
      yield* Effect.gen(function* () {
        yield* save(child, path.join(child.directory, "other.txt"), "other before", "other after")
      }).pipe(provideInstance(child.directory))
  }
  const outcome = yield* reviews.undo(input, Effect.die(new Error("Unexpected local-only retry"))).pipe(Effect.exit)
  const saved = yield* storage.read<{ complete: boolean }>(key)
  const raw = yield* storage
    .read<unknown[]>(["session_diff", input.sessionID])
    .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([])))
  const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
  const ledger = yield* storage
    .read<{ files: Record<string, string[]> }>(["session_undo", input.sessionID])
    .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed({ files: {} })))
  process.stdout.write(
    `RECOVERY_RESULT ${JSON.stringify({ pid: process.pid, refused: Exit.isFailure(outcome), calls, bytes: yield* bytes(), complete: saved.complete, raw: raw.length, ledger: Object.values(ledger.files).flat().length, revert: current.revert?.diff ?? null })}\n`,
  )
  if (mode === "replaced")
    yield* sessions.setRevert({ sessionID: input.sessionID, revert: original.revert, summary: original.summary })
  if (inserted && mode === "generation") yield* sessions.removeMessage(inserted)
  if (mode === "raw") yield* storage.write(["session_diff", input.sessionID], stored)
})
await Effect.runPromise(
  program.pipe(provideInstance(dir), Effect.provide(testInstanceStoreLayer), Effect.provide(layer)),
)
