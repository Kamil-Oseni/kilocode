import { expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { PtyArchive } from "@/kilocode/pty/archive"
import { locationServiceMapLayer } from "@/kilocode/pty/location-map"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Pty } from "@opencode-ai/core/pty"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { InteractiveTerminal } from "@/kilocode/interactive-terminal"
import { admit, assert } from "@/kilocode/interactive-terminal/lifecycle"
import { BackgroundProcessRunner } from "@/kilocode/background-process/runner"
import { guardian } from "@/kilocode/background-process/windows-job"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { capture } from "@/kilocode/instance"
import { Shell } from "@opencode-ai/core/shell"
import { sample } from "@/kilocode/background-process/windows-tree"
import { Global } from "@opencode-ai/core/global"
import { PowerShell } from "@/kilocode/shell/shell"
import { randomUUID } from "node:crypto"
import { mkdir, realpath, stat, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Storage.node,
      Database.node,
      WorkspaceOccupancy.node,
      PtyArchive.node,
    ]),
  ),
)

it.instance(
  "terminal publication collision preserves existing metadata and releases its unlaunched actor",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const owner = yield* sessions.create({ title: "Unlaunched terminal owner" })
      const ctx = capture()
      if (!ctx) throw new Error("Missing terminal fixture context")
      const token = randomUUID()
      const directory = path.join(Global.Path.state, "interactive-terminal")
      const file = path.join(directory, `${token}.json`)
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeFile(file, "retained conflicting receipt", { flag: "wx" }))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      let opened = false
      const result = yield* Effect.tryPromise(() =>
        admit(ctx, owner.id, test.directory, token, async () => {
          opened = true
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(opened).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("retained conflicting receipt")
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
    }),
  60000,
)

async function wait(file: string) {
  const deadline = performance.now() + 70000
  while (performance.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(50)
  }
  throw new Error("Archived terminal fixture did not start")
}

it.instance(
  "organization archive drains only the central terminal's immutable creation owner and denies restart",
  () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const test = yield* TestInstance
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const archive = yield* PtyArchive.Service
      const maps = yield* LocationServiceMap.Service
      const runner = RayaTaskRunner.make({ database, storage, sessions, pty: archive, halt: () => Effect.void })
      const worker = yield* runner.tasks.create({
        name: "Central terminal worker",
        objective: "Keep a terminal",
        dir: test.directory,
        schedule: { kind: "manual" },
      })
      const teams = RayaTaskOrganization.make(database, { ...runner.tasks, stop: runner.stopMembers }, storage)
      const team = yield* teams.create({
        name: "Central terminal team",
        members: [{ agentID: worker.id, role: "Worker" }],
      })
      const owner = yield* sessions.create({
        title: "Central terminal owner",
        metadata: { rayaRoutine: { agentID: worker.id, organizationID: team.id } },
      })
      const foreign = yield* sessions.create({ title: "Unrelated central terminal" })
      yield* runner.tasks.record({
        id: randomUUID(),
        agentID: worker.id,
        sessionID: owner.id,
        at: Date.now(),
        status: "complete",
      })
      const location = maps.get(Location.Ref.make({ directory: AbsolutePath.make(test.directory) }))
      yield* Effect.gen(function* () {
        const pty = yield* Pty.Service
        const receipt = path.join(test.directory, "central-owner.pid")
        const outside = path.join(test.directory, "central-outside.pid")
        const restarted = path.join(test.directory, "central-restarted.pid")
        const create = (sessionID: typeof owner.id, file: string) =>
          pty.create({
            ownerSessionID: sessionID,
            command: process.execPath,
            args: ["-e", `await Bun.write(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`],
            cwd: test.directory,
            title: "Archive fixture",
          })
        const owned = yield* create(owner.id, receipt)
        yield* Effect.addFinalizer(() =>
          pty.remove(owned.id).pipe(Effect.catchTag("Pty.NotFoundError", () => Effect.void)),
        )
        const other = yield* create(foreign.id, outside)
        yield* Effect.addFinalizer(() =>
          pty.remove(other.id).pipe(Effect.catchTag("Pty.NotFoundError", () => Effect.void)),
        )
        yield* Effect.promise(() => Promise.all([wait(receipt), wait(outside)]))
        const pid = Number(yield* Effect.promise(() => Bun.file(receipt).text()))
        // Display attribution cannot change the immutable terminal creation owner.
        yield* pty.update(owned.id, { sessionID: foreign.id })
        expect((yield* teams.archive(team.id, { expectedRevision: team.revision })).archived).toBe(true)
        expect(Exit.isFailure(yield* pty.get(owned.id).pipe(Effect.exit))).toBe(true)
        expect((yield* pty.get(other.id)).status).toBe("running")
        expect((yield* Effect.promise(() => sample(pid))).status).toBe("gone")
        expect(Exit.isFailure(yield* create(owner.id, restarted).pipe(Effect.exit))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(restarted).exists())).toBe(false)
        expect(Exit.isFailure(yield* runner.fire(worker.id).pipe(Effect.exit))).toBe(true)
      }).pipe(Effect.provide(location))
    }).pipe(Effect.provide(locationServiceMapLayer)),
  150000,
)

it.instance(
  "terminal cleanup retries a locked manifest after confirmed occupancy release and rechecks its owner",
  () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const owner = yield* sessions.create({ title: "Terminal cleanup retry owner" })
      const ctx = capture()
      if (!ctx) throw new Error("Missing terminal fixture context")
      const token = randomUUID()
      const release = yield* Effect.promise(() =>
        admit(ctx, owner.id, test.directory, token, async (release) => release),
      )
      const file = path.join(Global.Path.state, "interactive-terminal", `${token}.json`)
      const content = yield* Effect.promise(() => Bun.file(file).text())
      const ready = path.join(test.directory, "manifest-lock.ready")
      const stop = path.join(test.directory, "manifest-lock.stop")
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
      const script = `$ErrorActionPreference='Stop'; $file=[IO.File]::Open(${quote(file)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { [IO.File]::WriteAllText(${quote(ready)}, 'ready'); while (!(Test-Path -LiteralPath ${quote(stop)})) { Start-Sleep -Milliseconds 50 } } finally { $file.Dispose() }`
      const child = Bun.spawn(
        [
          PowerShell.pwsh() ?? "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { stdout: "ignore", stderr: "ignore", windowsHide: true },
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await writeFile(stop, "stop")
          await child.exited
          if (await Bun.file(file).exists()) {
            await writeFile(file, content)
            await release()
          }
        }),
      )
      yield* Effect.promise(() => wait(ready))
      expect(Exit.isFailure(yield* Effect.tryPromise(release).pipe(Effect.exit))).toBe(true)
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(content)
      yield* Effect.promise(() => writeFile(file, content.replace(owner.id, "ses_replaced_owner")))
      expect(Exit.isFailure(yield* Effect.tryPromise(release).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("ses_replaced_owner")
      yield* Effect.promise(() => writeFile(file, content))
      yield* Effect.promise(() => writeFile(stop, "stop"))
      expect(yield* Effect.promise(() => child.exited)).toBe(0)
      yield* Effect.promise(release)
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
    }),
  90000,
)

it.instance(
  "organization archive drains a completed worker's terminal and denies its restart",
  () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const test = yield* TestInstance
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const runner = RayaTaskRunner.make({
        pty: yield* PtyArchive.Service,
        database,
        storage,
        sessions,
        halt: () => Effect.die("Completed work must not require active run cancellation"),
      })
      const worker = yield* runner.tasks.create({
        name: "Completed terminal owner",
        objective: "Keep a terminal",
        dir: test.directory,
        schedule: { kind: "once", at: Date.now() + 60000 },
      })
      const organizations = RayaTaskOrganization.make(database, { ...runner.tasks, stop: runner.stopMembers }, storage)
      const team = yield* organizations.create({
        name: "Completed terminal team",
        members: [{ agentID: worker.id, role: "Worker" }],
      })
      const owner = yield* sessions.create({
        title: "Completed worker session",
        metadata: { rayaRoutine: { agentID: worker.id, organizationID: team.id } },
      })
      yield* runner.tasks.record({
        id: randomUUID(),
        agentID: worker.id,
        sessionID: owner.id,
        at: Date.now(),
        status: "complete",
      })
      const file = path.join(test.directory, "terminal-worker.mjs")
      const receipt = path.join(test.directory, "terminal-worker.pid")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          `await Bun.write(${JSON.stringify(receipt)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ),
      )
      const quote = (value: string) => `"${value.replaceAll("\\", "/").replaceAll('"', '""')}"`
      const command = `${Shell.ps(Shell.acceptable()) ? "& " : ""}${quote(process.execPath)} ${quote(file)}`
      const pending = InteractiveTerminal.run({
        sessionID: owner.id,
        shell: Shell.acceptable(),
        command,
        cwd: test.directory,
        env: { ...process.env },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => InteractiveTerminal.stopSession(owner.id)))
      yield* Effect.promise(() => wait(receipt))
      const pid = Number(yield* Effect.promise(() => Bun.file(receipt).text()))
      expect((yield* Effect.promise(() => sample(pid))).status).toBe("owned")
      expect((yield* runner.tasks.runsFor(worker.id))[0]?.status).toBe("complete")
      expect((yield* organizations.archive(team.id, { expectedRevision: team.revision })).archived).toBe(true)
      expect((yield* Effect.promise(() => pending)).closedBy).toBe("abort")
      expect((yield* Effect.promise(() => sample(pid))).status).toBe("gone")
      expect(yield* Effect.promise(() => InteractiveTerminal.list({ sessionID: owner.id }))).toEqual([])
      expect(
        Exit.isFailure(
          yield* Effect.tryPromise(() =>
            InteractiveTerminal.run({
              sessionID: owner.id,
              shell: Shell.acceptable(),
              command,
              cwd: test.directory,
              env: { ...process.env },
            }),
          ).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* runner.fire(worker.id).pipe(Effect.exit))).toBe(true)
    }),
  150000,
)

it.instance(
  "organization archive retains an unknown historical terminal receipt and refuses completion",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const runner = RayaTaskRunner.make({
        pty: yield* PtyArchive.Service,
        database,
        storage,
        sessions,
        halt: () => Effect.die("Completed work has no running handle"),
      })
      const worker = yield* runner.tasks.create({
        name: "Historical terminal owner",
        objective: "Preserve unknown ownership",
        dir: test.directory,
        schedule: { kind: "manual" },
      })
      const organizations = RayaTaskOrganization.make(database, { ...runner.tasks, stop: runner.stopMembers }, storage)
      const team = yield* organizations.create({
        name: "Unknown terminal team",
        members: [{ agentID: worker.id, role: "Worker" }],
      })
      const owner = yield* sessions.create({
        title: "Historical worker session",
        metadata: { rayaRoutine: { agentID: worker.id, organizationID: team.id } },
      })
      yield* runner.tasks.record({
        id: randomUUID(),
        agentID: worker.id,
        sessionID: owner.id,
        at: Date.now(),
        status: "complete",
      })
      const token = randomUUID()
      const directory = path.join(Global.Path.state, "interactive-terminal")
      const file = path.join(directory, `${token}.json`)
      const real = yield* Effect.promise(() => realpath(test.directory))
      const node = yield* Effect.promise(() => stat(real, { bigint: true }))
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      const content = JSON.stringify({
        version: 1,
        token,
        sessionID: owner.id,
        control: path.join(directory, `${token}.control`),
        real,
        dev: node.dev.toString(),
        ino: node.ino.toString(),
      })
      yield* Effect.promise(() => writeFile(file, content, { flag: "wx", mode: 0o600 }))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      expect(
        Exit.isFailure(yield* organizations.archive(team.id, { expectedRevision: team.revision }).pipe(Effect.exit)),
      ).toBe(true)
      expect((yield* organizations.get(team.id)).archived).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(content)
      expect(Exit.isFailure(yield* runner.fire(worker.id).pipe(Effect.exit))).toBe(true)
    }),
  60000,
)

it.instance(
  "historical v2 terminal reconciles exact native drainage and a durable release receipt without replay",
  () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const owner = yield* sessions.create({ title: "Native terminal reconciliation owner" })
      const ctx = capture()
      if (!ctx) throw new Error("Missing terminal fixture context")
      const token = randomUUID()
      const manifest = path.join(Global.Path.state, "interactive-terminal", `${token}.json`)
      const control = path.join(Global.Path.state, "interactive-terminal", `${token}.control`)
      const effect = path.join(test.directory, "reconcile-effects")
      const code = `while (!await Bun.file(${JSON.stringify(control + ".go")}).exists()) await Bun.sleep(10); await Bun.write(${JSON.stringify(effect)}, "once")`
      const child = yield* Effect.promise(() =>
        admit(ctx, owner.id, test.directory, token, async () =>
          Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore", windowsHide: true }),
        ),
      )
      const identities = yield* Effect.promise(() => Promise.all([sample(child.pid), sample(process.pid)]))
      if (!identities[0].birth || !identities[1].birth) throw new Error("Missing exact native fixture identity")
      const guard = yield* Effect.promise(() =>
        guardian({
          pid: child.pid,
          birth: identities[0].birth!,
          controller: process.pid,
          parentBirth: identities[1].birth!,
          control,
          token,
        }),
      )
      guard.stderr?.resume()
      const closed = new Promise<number | null>((resolve, reject) => {
        guard.once("error", reject)
        guard.once("exit", resolve)
      })
      yield* Effect.promise(() => wait(BackgroundProcessRunner.sidecars(control).job))
      expect(yield* Effect.promise(() => BackgroundProcessRunner.contained(control, token))).toBe(true)
      yield* Effect.promise(() => writeFile(control + ".go", "go"))
      expect(yield* Effect.promise(() => child.exited)).toBe(0)
      expect(yield* Effect.promise(() => closed)).toBe(0)
      expect(yield* Effect.promise(() => BackgroundProcessRunner.drained(control, token))).toBe(true)
      const raw: unknown = JSON.parse(yield* Effect.promise(() => Bun.file(manifest).text()))
      if (!raw || typeof raw !== "object" || !("version" in raw) || !("reservation" in raw))
        throw new Error("Invalid fixture manifest")
      expect(raw.version).toBe(2)
      const reservation = Schema.decodeUnknownSync(WorkspaceOccupancy.Reservation)(raw.reservation)
      expect(reservation.sessionID).toBe(owner.id)
      expect(reservation.version).toBe(2)
      if (reservation.version !== 2) throw new Error("Terminal reservation is not token-bound")
      expect(reservation.terminal).toBe(token)
      const native = BackgroundProcessRunner.sidecars(control).drained
      const proof = yield* Effect.promise(() => Bun.file(native).text())
      yield* Effect.promise(() => writeFile(native, proof.replace(token, randomUUID())))
      expect(Exit.isFailure(yield* Effect.tryPromise(() => assert(ctx, owner.id, [])).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(manifest).exists())).toBe(true)
      yield* Effect.promise(() => writeFile(native, proof))
      const content = yield* Effect.promise(() => Bun.file(manifest).text())
      const foreign = yield* occupancy.reserve(ctx, owner.id, randomUUID())
      yield* Effect.promise(() => writeFile(manifest, JSON.stringify({ ...raw, reservation: foreign.identity })))
      expect(Exit.isFailure(yield* Effect.tryPromise(() => assert(ctx, owner.id, [])).pipe(Effect.exit))).toBe(true)
      expect(
        yield* Effect.promise(() =>
          Bun.file(path.join(Global.Path.state, "workspace-occupancy-v1", `${foreign.identity.token}.json`)).exists(),
        ),
      ).toBe(true)
      yield* foreign.release
      yield* Effect.promise(() => writeFile(manifest, JSON.stringify({ ...raw, extra: true })))
      expect(Exit.isFailure(yield* Effect.tryPromise(() => assert(ctx, owner.id, [])).pipe(Effect.exit))).toBe(true)
      yield* Effect.promise(() => writeFile(manifest, JSON.stringify({ ...raw, ino: "replaced" })))
      expect(Exit.isFailure(yield* Effect.tryPromise(() => assert(ctx, owner.id, [])).pipe(Effect.exit))).toBe(true)
      yield* Effect.promise(() => writeFile(manifest, content))
      // Actual persisted boundary: exact release is confirmed, terminal metadata remains after backend loss.
      yield* occupancy.retire(reservation)
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
      yield* Effect.promise(() => assert(ctx, owner.id, []))
      expect(yield* Effect.promise(() => Bun.file(manifest).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(effect).text())).toBe("once")
      expect(yield* Effect.promise(() => Bun.file(control).exists())).toBe(false)
      yield* Effect.promise(() =>
        Promise.all(Object.values(BackgroundProcessRunner.sidecars(control)).map((file) => rm(file, { force: true }))),
      )
    }),
  120000,
)
