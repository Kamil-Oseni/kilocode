import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { InteractiveTerminal } from "@/kilocode/interactive-terminal"
import { admit } from "@/kilocode/interactive-terminal/lifecycle"
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
    LayerNode.group([Session.node, SessionProjector.node, Storage.node, Database.node, WorkspaceOccupancy.node]),
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
