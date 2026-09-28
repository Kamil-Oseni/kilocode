import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Global } from "@opencode-ai/core/global"
import * as Project from "@/project/project"
import { SessionID } from "@/session/schema"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { admit, assert } from "@/kilocode/interactive-terminal/lifecycle"
import { mark } from "@/kilocode/background-process/lifecycle"
import { BackgroundProcessRunner } from "@/kilocode/background-process/runner"
import { guardian } from "@/kilocode/background-process/windows-job"
import { sample } from "@/kilocode/background-process/windows-tree"

const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      workspace: Schema.String,
      report: Schema.String,
      session: Schema.String,
      token: Schema.String,
      mode: Schema.Literals(["seed", "recover", "unrelated", "tombstone", "admit"]),
      boundary: Schema.Literals(["drained", "released"]),
    }),
  ),
  { onExcessProperty: "error" },
)(process.argv[2])
if (!process.env.KILO_DB || process.env.KILO_DB === ":memory:" || !path.isAbsolute(process.env.KILO_DB))
  throw new Error("Fresh-process fixture requires its private file-backed database")
const session = SessionID.make(input.session)
await fs.writeFile(input.report + ".stage", "imports")
const layer = LayerNode.compile(LayerNode.group([Database.node, Project.node, WorkspaceOccupancy.node]))
const output = await Effect.runPromise(
  Effect.gen(function* () {
    yield* Effect.promise(() => fs.writeFile(input.report + ".stage", "layer"))
    const database = yield* Database.Service
    const project = yield* Project.Service
    const occupancy = yield* WorkspaceOccupancy.Service
    const found = yield* project.fromDirectory(input.workspace)
    const ctx = { directory: input.workspace, worktree: found.sandbox, project: found.project }
    const terminal = path.join(Global.Path.state, "interactive-terminal")
    const manifest = path.join(terminal, `${input.token}.json`)
    const control = path.join(terminal, `${input.token}.control`)
    if (input.mode === "tombstone") {
      yield* Effect.promise(() => mark("archived-test-organization", [session]))
      return { ok: true, pid: process.pid }
    }
    if (input.mode === "unrelated") {
      const actor = yield* occupancy.reserve(ctx, session, randomUUID())
      return {
        ok: true,
        pid: process.pid,
        reservation: actor.identity,
        active: path.join(Global.Path.state, "workspace-occupancy-v1", `${actor.identity.token}.json`),
      }
    }
    if (input.mode === "recover" || input.mode === "admit") {
      let entered = false
      const result = yield* Effect.tryPromise(() =>
        input.mode === "recover"
          ? assert(ctx, session, [])
          : admit(ctx, session, input.workspace, randomUUID(), async () => {
              entered = true
              throw new Error("Admission reached command body")
            }),
      ).pipe(Effect.exit)
      return { ok: result._tag === "Success", pid: process.pid, entered }
    }
    yield* database.db
      .insert(SessionTable)
      .values({
        id: session,
        project_id: found.project.id,
        slug: "terminal-recovery",
        directory: input.workspace,
        title: "Persisted terminal owner",
        version: "test",
      })
      .run()
    const effects = path.join(input.workspace, "effects.txt")
    const code = `while (!await Bun.file(${JSON.stringify(control + ".go")}).exists()) await Bun.sleep(10); const fs=await import('node:fs/promises'); await fs.appendFile(${JSON.stringify(effects)}, ${JSON.stringify(input.token + "\n")});`
    const child = yield* Effect.promise(() =>
      admit(ctx, session, input.workspace, input.token, async () =>
        Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore", windowsHide: true }),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => { child.kill() }))
    yield* Effect.promise(() => fs.writeFile(input.report + ".child", String(child.pid)))
    const identities = yield* Effect.promise(() => Promise.all([sample(child.pid), sample(process.pid)]))
    if (!identities[0].birth || !identities[1].birth) throw new Error("Missing exact native process identity")
    const guard = yield* Effect.promise(() =>
      guardian({
        pid: child.pid,
        birth: identities[0].birth!,
        controller: process.pid,
        parentBirth: identities[1].birth!,
        control,
        token: input.token,
      }),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => { guard.kill() }))
    guard.stderr?.resume()
    const closed = new Promise<number | null>((resolve, reject) => {
      guard.once("error", reject)
      guard.once("exit", resolve)
    })
    const stop = performance.now() + 60000
    while (!(yield* Effect.promise(() => Bun.file(BackgroundProcessRunner.sidecars(control).job).exists()))) {
      if (performance.now() >= stop) throw new Error("Native Job containment deadline exceeded")
      yield* Effect.sleep(20)
    }
    if (!(yield* Effect.promise(() => BackgroundProcessRunner.contained(control, input.token))))
      throw new Error("Actual native containment proof is missing")
    yield* Effect.promise(() => fs.writeFile(control + ".go", "go"))
    if ((yield* Effect.promise(() => child.exited)) !== 0 || (yield* Effect.promise(() => closed)) !== 0)
      throw new Error("Native fixture did not finish cleanly")
    if (!(yield* Effect.promise(() => BackgroundProcessRunner.drained(control, input.token))))
      throw new Error("Actual native drainage proof is missing")
    const actor = JSON.parse(yield* Effect.promise(() => fs.readFile(manifest, "utf8"))) as { reservation: unknown }
    const reservation = Schema.decodeUnknownSync(WorkspaceOccupancy.Reservation)(actor.reservation)
    if (input.boundary === "released") yield* occupancy.retire(reservation)
    return {
      ok: true,
      pid: process.pid,
      database: Database.path(),
      manifest,
      control,
      effects,
      active: path.join(Global.Path.state, "workspace-occupancy-v1", `${reservation.token}.json`),
      released: path.join(Global.Path.state, "workspace-occupancy-released-v1", `${reservation.token}.json`),
      drained: BackgroundProcessRunner.sidecars(control).drained,
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
await fs.writeFile(input.report, JSON.stringify(output))
// Deliberately skip runtime shutdown at the selected persisted crash boundary.
process.exit(0)
