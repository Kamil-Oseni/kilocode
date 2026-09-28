import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { Global } from "@opencode-ai/core/global"
import { KiloPtyLifecycle } from "@opencode-ai/core/kilocode/pty/lifecycle"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { Session } from "@/session/session"
import { PtyOwners } from "@/kilocode/pty/lifecycle"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { mark } from "@/kilocode/background-process/lifecycle"
import { PowerShell } from "@/kilocode/shell/shell"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, PtyOwners.node, WorkspaceOccupancy.node, Global.node]),
  ),
)
const wait = async (file: string) => {
  const deadline = performance.now() + 60_000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() >= deadline) throw new Error("Native terminal fixture did not publish its receipt")
    await Bun.sleep(20)
  }
}

it.instance(
  "changed terminal cwd is refused before native dispatch",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lifecycle = yield* KiloPtyLifecycle.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const cwd = path.join(test.directory, "cwd")
      const previous = path.join(test.directory, "previous")
      yield* Effect.promise(() => fs.mkdir(cwd))
      const request = {
        version: 1 as const,
        id: PtyID.make("pty_changed"),
        cwd,
        location: Location.Ref.make({ directory: AbsolutePath.make(test.directory) }),
      }
      let launched = false
      const exit = yield* lifecycle
        .admission(request, (lease) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.rename(cwd, previous)
              await fs.mkdir(cwd)
            })
            yield* lease.dispatch()
            launched = true
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(launched).toBe(false)
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
    }),
  60_000,
)

it.instance(
  "manual terminal admission occupies its workspace and releases a proven unlaunched actor",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lifecycle = yield* KiloPtyLifecycle.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const global = yield* Global.Service
      const request = {
        version: 1 as const,
        id: PtyID.make("pty_manual"),
        cwd: test.directory,
        location: Location.Ref.make({ directory: AbsolutePath.make(test.directory) }),
      }
      const token = yield* lifecycle.admission(request, (lease) =>
        Effect.gen(function* () {
          const busy = yield* occupancy.review([test.directory])(Effect.void).pipe(Effect.exit)
          expect(Exit.isFailure(busy)).toBe(true)
          const actor = yield* Effect.promise(() =>
            Bun.file(path.join(global.state, "core-pty-v1", `${lease.token}.json`)).json(),
          )
          expect(actor.sessionID).toBe(null)
          expect(actor.reservation.terminal).toBe(lease.token)
          return lease.token
        }),
      )
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
      expect(
        yield* Effect.promise(() => Bun.file(path.join(global.state, "core-pty-v1", `${token}.json`)).exists()),
      ).toBe(false)
    }),
  60_000,
)

it.instance(
  "terminal admission requires the persisted session owner and honors archive tombstones",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lifecycle = yield* KiloPtyLifecycle.Service
      const sessions = yield* Session.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const global = yield* Global.Service
      const owner = yield* sessions.create({ title: "Immutable PTY owner" })
      const request = {
        version: 1 as const,
        id: PtyID.make("pty_owned"),
        cwd: test.directory,
        ownerSessionID: owner.id,
        location: Location.Ref.make({ directory: AbsolutePath.make(owner.directory), workspaceID: owner.workspaceID }),
      }
      expect(yield* lifecycle.admission(request, () => Effect.succeed(true))).toBe(true)
      const foreign = yield* Effect.promise(() => fs.mkdtemp(path.join(test.directory, "foreign-")))
      const rejected = yield* lifecycle
        .admission({ ...request, location: Location.Ref.make({ directory: AbsolutePath.make(foreign) }) }, () =>
          Effect.die("foreign work must not begin"),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      const marker = path.join(global.state, "background-process", "lifecycle", `${owner.id}.json`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(marker, { force: true })))
      yield* Effect.promise(() => mark("archived-pty-test", [owner.id]))
      let entered = false
      const archived = yield* lifecycle
        .admission(request, () =>
          Effect.sync(() => {
            entered = true
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(archived)).toBe(true)
      expect(entered).toBe(false)
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
    }),
  60_000,
)

it.instance(
  "exact native terminal drainage retires durable ownership without replaying Stop",
  () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const test = yield* TestInstance
      const lifecycle = yield* KiloPtyLifecycle.Service
      const owners = yield* PtyOwners.Service
      const sessions = yield* Session.Service
      const occupancy = yield* WorkspaceOccupancy.Service
      const global = yield* Global.Service
      const owner = yield* sessions.create({ title: "Native PTY admission owner" })
      const effect = path.join(test.directory, "native-effect")
      const request = {
        version: 1 as const,
        id: PtyID.make("pty_native"),
        cwd: test.directory,
        ownerSessionID: owner.id,
        location: Location.Ref.make({ directory: AbsolutePath.make(owner.directory), workspaceID: owner.workspaceID }),
      }
      const result = yield* lifecycle.admission(request, (lease) =>
        Effect.gen(function* () {
          const controller = yield* Effect.promise(() => NativeProcess.inspect(process.pid))
          if (
            !controller ||
            typeof controller !== "object" ||
            !("birth" in controller) ||
            typeof controller.birth !== "string"
          )
            throw new Error("Fixture controller identity unavailable")
          const birth = controller.birth
          const spec = yield* Effect.promise(() =>
            NativeProcess.prepare({
              command: process.execPath,
              args: ["-e", `require('fs').writeFileSync(${JSON.stringify(effect)},'once');setInterval(()=>{},1000)`],
              cwd: test.directory,
              env: Object.fromEntries(
                Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              ),
              controller: process.pid,
              birth,
              control: lease.control,
              token: lease.token,
            }),
          )
          yield* lease.dispatch()
          const proc = yield* Effect.sync(() =>
            spawn(spec.command, spec.args, { cwd: test.directory, env: spec.env, stdio: "ignore", windowsHide: true }),
          )
          const done = new Promise<void>((resolve, reject) => {
            proc.once("close", () => resolve())
            proc.once("error", reject)
          })
          yield* Effect.promise(() => wait(`${lease.control}.launch`))
          const identity = yield* Effect.promise(() => NativeProcess.suspended(lease.control, lease.token))
          yield* lease.admit(identity)
          yield* Effect.promise(() => NativeProcess.resume(lease.control, lease.token, identity))
          yield* Effect.promise(() => wait(`${lease.control}.running`))
          return { lease, done, identity }
        }),
      )
      const blocked = yield* occupancy.review([test.directory])(Effect.void).pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)
      const unknown = yield* owners.assert(owner.id, test.directory).pipe(Effect.exit)
      expect(Exit.isFailure(unknown)).toBe(true)
      const wrong = yield* result.lease
        .retire({ version: 2, token: "00000000-0000-0000-0000-000000000000", proof: "windows-job", empty: true })
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrong)).toBe(true)
      yield* Effect.promise(() => fs.writeFile(result.lease.control, "stop", { flag: "wx", mode: 0o600 }))
      yield* Effect.promise(() => result.done)
      yield* Effect.promise(() => wait(`${result.lease.control}.drained`))
      const proof = {
        version: 2 as const,
        token: result.lease.token,
        proof: "windows-job" as const,
        empty: true as const,
      }
      const manifest = path.join(global.state, "core-pty-v1", `${result.lease.token}.json`)
      const journal = path.join(global.state, "core-pty-cleanup-v1", `${result.lease.token}.json`)
      const actor = yield* Effect.promise(() => Bun.file(manifest).json())
      const job = yield* Effect.promise(() => fs.readFile(result.lease.control + ".job", "utf8"))
      const receipt = path.join(global.state, "workspace-occupancy-released-v1", `${actor.reservation.token}.json`)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(receipt), { recursive: true })
        // A distinct, exact receipt lets the native file-share lock affect only final forget.
        await fs.writeFile(receipt, JSON.stringify(actor.reservation), { flag: "wx", mode: 0o600 })
      })
      const ready = path.join(test.directory, "receipt-lock.ready")
      const stop = path.join(test.directory, "receipt-lock.stop")
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
      const script = `$ErrorActionPreference='Stop'; $file=[IO.File]::Open(${quote(receipt)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { [IO.File]::WriteAllText(${quote(ready)}, 'ready'); while (!(Test-Path -LiteralPath ${quote(stop)})) { Start-Sleep -Milliseconds 50 } } finally { $file.Dispose() }`
      const locker = yield* Effect.sync(() =>
        Bun.spawn(
          [
            PowerShell.pwsh() ?? "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { stdout: "ignore", stderr: "ignore", windowsHide: true },
        ),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await fs.writeFile(stop, "stop")
          await locker.exited
        }),
      )
      yield* Effect.promise(() => wait(ready))
      expect(Exit.isFailure(yield* result.lease.retire(proof).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(manifest).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(receipt).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(journal).exists())).toBe(true)
      for (const suffix of ["", ".go", ".job", ".launch", ".drained", ".running", ".exited"])
        expect(yield* Effect.promise(() => Bun.file(result.lease.control + suffix).exists())).toBe(false)
      const captured = yield* Effect.promise(() => fs.readFile(journal, "utf8"))
      expect(JSON.parse(captured).result.outcome).toBe("cancelled")
      yield* Effect.promise(() => fs.writeFile(result.lease.control + ".job", job, { flag: "wx" }))
      expect(Exit.isFailure(yield* result.lease.retire(proof).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(result.lease.control + ".job", "utf8"))).toBe(job)
      yield* Effect.promise(() => fs.unlink(result.lease.control + ".job"))
      yield* Effect.promise(() => fs.writeFile(result.lease.control + ".running.tmp", "new", { flag: "wx" }))
      expect(Exit.isFailure(yield* result.lease.retire(proof).pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(result.lease.control + ".running.tmp", "utf8"))).toBe("new")
      yield* Effect.promise(() => fs.unlink(result.lease.control + ".running.tmp"))
      yield* Effect.promise(() =>
        fs.writeFile(journal, captured.replace('"outcome":"cancelled"', '"outcome":"confirmed"')),
      )
      expect(Exit.isFailure(yield* result.lease.retire(proof).pipe(Effect.exit))).toBe(true)
      yield* Effect.promise(() => fs.writeFile(journal, captured))
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
      yield* Effect.promise(() => fs.writeFile(manifest, JSON.stringify(actor), { flag: "wx" }))
      expect(Exit.isFailure(yield* result.lease.retire(proof).pipe(Effect.exit))).toBe(true)
      yield* Effect.promise(() => fs.unlink(manifest))
      yield* Effect.promise(() => fs.writeFile(stop, "stop"))
      expect(yield* Effect.promise(() => locker.exited)).toBe(0)
      yield* result.lease.retire(proof)
      expect(yield* Effect.promise(() => Bun.file(receipt).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(journal).exists())).toBe(false)
      yield* result.lease.retire(proof)
      expect(yield* occupancy.review([test.directory])(Effect.succeed(true))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(result.lease.control).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(effect).text())).toBe("once")
      const status = yield* Effect.promise(() => NativeProcess.inspect(result.identity.pid))
      expect(status).toMatchObject({ status: "gone" })
      yield* owners.assert(owner.id, test.directory)
    }),
  90_000,
)
