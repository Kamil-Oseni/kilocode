import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { KiloPtyLifecycle } from "@opencode-ai/core/kilocode/pty/lifecycle"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { exited, read } from "@opencode-ai/core/kilocode/pty/receipts"
import * as Project from "@/project/project"
import { SessionID } from "@/session/schema"
import { PtyOwners } from "@/kilocode/pty/lifecycle"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import * as cleanup from "@/kilocode/pty/cleanup"

const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      workspace: Schema.String,
      report: Schema.String,
      session: Schema.String,
      token: Schema.optional(Schema.String),
      mode: Schema.Literals(["seed", "recover", "unrelated"]),
      boundary: Schema.Literals(["released", "published", "prepared", "partial", "actor", "forgotten"]),
      outcome: Schema.Literals(["confirmed", "cancelled", "unknown"]),
    }),
  ),
  { onExcessProperty: "error" },
)(process.argv[2])
if (!process.env.KILO_DB || process.env.KILO_DB === ":memory:" || !path.isAbsolute(process.env.KILO_DB))
  throw new Error("Cleanup recovery requires its private SQLite database")
const wait = async (file: string) => {
  const until = performance.now() + 60_000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() >= until) throw new Error("Cleanup native receipt was not published")
    await Bun.sleep(10)
  }
}
const session = SessionID.make(input.session)
const layer = LayerNode.compile(
  LayerNode.group([PtyOwners.node, Database.node, Project.node, WorkspaceOccupancy.node, Global.node]),
)
const output = await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const project = yield* Project.Service
    const global = yield* Global.Service
    const occupancy = yield* WorkspaceOccupancy.Service
    const owners = yield* PtyOwners.Service
    const lifecycle = yield* KiloPtyLifecycle.Service
    const found = yield* project.fromDirectory(input.workspace)
    const ctx = { directory: input.workspace, worktree: found.sandbox, project: found.project }
    const directory = path.join(global.state, "core-pty-cleanup-v1")
    if (input.mode === "unrelated") {
      const lease = yield* occupancy.reserve(ctx, session, randomUUID())
      return {
        ok: true,
        pid: process.pid,
        active: path.join(global.state, "workspace-occupancy-v1", `${lease.identity.token}.json`),
      }
    }
    if (input.mode === "recover") {
      const saved = input.token ? yield* Effect.promise(() => cleanup.read(directory, input.token!)) : undefined
      const result = yield* owners.assert(session, input.workspace).pipe(Effect.exit)
      return { ok: result._tag === "Success", pid: process.pid, outcome: saved?.journal.result.outcome }
    }
    yield* database.db
      .insert(SessionTable)
      .values({
        id: session,
        project_id: found.project.id,
        slug: "pty-cleanup-recovery",
        directory: input.workspace,
        title: "Persisted cleanup owner",
        version: "test",
      })
      .run()
    const effects = path.join(input.workspace, "effects.txt")
    const state: { step: string; control?: string; identity?: KiloPtyLifecycle.Identity } = { step: "admission" }
    const code = `require('fs').appendFileSync(${JSON.stringify(effects)}, ${JSON.stringify(input.session + "\n")}); ${input.outcome === "cancelled" ? "setInterval(()=>{},1000)" : "process.exit(7)"}`
    const admission = yield* lifecycle
      .admission(
        {
          version: 1,
          id: PtyID.make("pty_cleanup"),
          location: Location.Ref.make({ directory: AbsolutePath.make(input.workspace) }),
          cwd: input.workspace,
          ownerSessionID: session,
        },
        (lease) =>
          Effect.gen(function* () {
            state.control = lease.control
            state.step = "prepare"
            const controller = yield* Effect.promise(() => NativeProcess.inspect(process.pid))
            if (
              !controller ||
              typeof controller !== "object" ||
              !("birth" in controller) ||
              typeof controller.birth !== "string"
            )
              throw new Error("Cleanup controller identity is unavailable")
            const birth = controller.birth
            const spec = yield* Effect.promise(() =>
              NativeProcess.prepare({
                command: process.execPath,
                args: ["-e", code],
                cwd: input.workspace,
                env: Object.fromEntries(
                  Object.entries(process.env).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                ),
                controller: process.pid,
                birth,
                control: lease.control,
                token: lease.token,
              }),
            )
            state.step = "dispatch"
            yield* lease.dispatch()
            state.step = "spawn"
            const child = yield* Effect.sync(() =>
              spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "ignore", windowsHide: true }),
            )
            const closed = new Promise<void>((resolve, reject) => {
              child.once("close", () => resolve())
              child.once("error", reject)
            })
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                if (child.exitCode === null && child.signalCode === null) child.kill()
                await closed
              }),
            )
            yield* Effect.promise(() => wait(lease.control + ".launch"))
            const identity = yield* Effect.promise(() => NativeProcess.suspended(lease.control, lease.token))
            state.identity = identity
            state.step = "admit"
            yield* lease.admit(identity)
            state.step = "resume"
            yield* Effect.promise(() => NativeProcess.resume(lease.control, lease.token, identity))
            yield* Effect.promise(() => wait(effects))
            if (input.outcome === "cancelled")
              yield* Effect.promise(() => fs.writeFile(lease.control, "stop", { flag: "wx", mode: 0o600 }))
            yield* Effect.promise(() => closed)
            yield* Effect.promise(() => wait(lease.control + ".drained"))
            const result = yield* Effect.promise(() => read(lease.control + ".exited"))
            if (
              exited(result, lease.token, identity).outcome !==
              (input.outcome === "unknown" ? "confirmed" : input.outcome)
            )
              throw new Error("Cleanup fixture did not receive the actual native outcome")
            for (const pid of [identity.pid, identity.helper]) {
              const status = yield* Effect.promise(() => NativeProcess.inspect(pid))
              if (!status || typeof status !== "object" || !("status" in status) || status.status !== "gone")
                throw new Error("Cleanup native process has not exited")
            }
            if (input.outcome === "unknown") {
              const receipt = yield* Effect.promise(() => NativeProcess.receipt(lease.control + ".exited"))
              if (!receipt) throw new Error("Unknown-outcome fixture lacks its exit receipt")
              yield* Effect.promise(() => NativeProcess.remove(lease.control + ".exited", receipt))
            }
            return { token: lease.token, control: lease.control, identity }
          }).pipe(Effect.scoped),
      )
      .pipe(Effect.exit)
    if (admission._tag === "Failure") {
      yield* Effect.promise(async () => {
        const probe = state.control ? state.control.slice(0, -".control".length) + ".json" : undefined
        const sharing = probe
          ? await (async () => {
              const quote = `'${probe.replaceAll("'", "''")}'`
              const source = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CleanupShareProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static long[] Check(string path) {
    uint attributes=GetFileAttributesW(path);
    IntPtr handle=CreateFileW(path,0x10080,7,IntPtr.Zero,3,0x200000,IntPtr.Zero);
    int error=handle==new IntPtr(-1)?Marshal.GetLastWin32Error():0;
    if(handle!=new IntPtr(-1))CloseHandle(handle);
    return new long[]{error,attributes};
  }
}
'@; $result=[CleanupShareProbe]::Check(${quote}); @{ error=$result[0]; attributes=$result[1] } | ConvertTo-Json -Compress`
              const child = spawn(
                "powershell.exe",
                [
                  "-NoLogo",
                  "-NoProfile",
                  "-NonInteractive",
                  "-EncodedCommand",
                  Buffer.from(source, "utf16le").toString("base64"),
                ],
                { windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
              )
              const chunks: Buffer[] = []
              let size = 0
              child.stdout.on("data", (chunk: Buffer) => {
                size += chunk.length
                if (size <= 4096) chunks.push(Buffer.from(chunk))
              })
              const code = await new Promise<number | null>((resolve, reject) => {
                child.once("error", reject)
                child.once("close", resolve)
              })
              return code === 0 && size <= 4096
                ? Schema.decodeUnknownSync(Schema.Struct({ error: Schema.Number, attributes: Schema.Number }))(
                    JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  )
                : { unavailable: true }
            })()
          : undefined
        const root = path.join(global.state, "core-pty-v1")
        const names = await fs.readdir(root).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return []
          throw err
        })
        const files = []
        for (const name of names.slice(0, 32)) {
          const file = path.join(root, name)
          const stat = await fs.lstat(file, { bigint: true })
          const actor = name.endsWith(".json")
            ? Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.String }))(
                JSON.parse(await fs.readFile(file, "utf8")),
              )
            : undefined
          const receipt = await NativeProcess.receipt(file).then(
            (value) => (value ? { volume: value.volume, index: value.index, digest: value.digest } : null),
            () => ({ refused: true }),
          )
          files.push({
            name,
            phase: actor?.phase,
            mode: stat.mode.toString(),
            links: stat.nlink.toString(),
            ino: stat.ino.toString(),
            size: stat.size.toString(),
            receipt,
          })
        }
        const processes = []
        if (state.identity) {
          for (const pid of [state.identity.pid, state.identity.helper]) {
            const value = await NativeProcess.inspect(pid)
            const info = Schema.decodeUnknownSync(
              Schema.Struct({ status: Schema.String, birth: Schema.optional(Schema.String) }),
            )(value)
            processes.push({ pid, status: info.status, birth: info.birth })
          }
        }
        await fs.writeFile(
          input.report + ".diagnostic",
          JSON.stringify({ step: state.step, sharing, files, processes }),
        )
      })
      return yield* Effect.failCause(admission.cause)
    }
    const terminal = admission.value
    const manifest = path.join(global.state, "core-pty-v1", `${terminal.token}.json`)
    const actor: unknown = yield* Effect.promise(() => Bun.file(manifest).json())
    const reservation = Schema.decodeUnknownSync(Schema.Struct({ reservation: WorkspaceOccupancy.Reservation }))(
      actor,
    ).reservation
    const active = path.join(global.state, "workspace-occupancy-v1", `${reservation.token}.json`)
    const release = path.join(global.state, "workspace-occupancy-released-v1", `${reservation.token}.json`)
    const temp =
      input.boundary === "prepared" ? path.join(directory, `${terminal.token}.${randomUUID()}.tmp`) : undefined
    yield* occupancy.retire(reservation)
    if (input.boundary !== "released") {
      const saved = yield* Effect.promise(() =>
        cleanup.prepare({
          directory,
          token: terminal.token,
          control: terminal.control,
          actor,
          identity: terminal.identity,
          release,
          reservation,
        }),
      )
      if (saved.journal.result.outcome !== input.outcome) throw new Error("Cleanup journal altered the native outcome")
      if (temp) {
        const journal = path.join(directory, `${terminal.token}.json`)
        // Preserve the real fsynced, single-linked journal inode before publication.
        yield* Effect.promise(() => fs.rename(journal, temp))
      }
      if (input.boundary === "partial") {
        for (const suffix of [".go", ".job"]) {
          const receipt = saved.journal.files.find((entry) => entry.suffix === suffix)?.receipt
          if (!receipt) throw new Error("Partial cleanup fixture lacks its saved receipt")
          yield* Effect.promise(() => NativeProcess.remove(terminal.control + suffix, receipt))
        }
      }
      if (input.boundary === "actor" || input.boundary === "forgotten")
        yield* Effect.promise(() =>
          cleanup.remove({ directory, control: terminal.control, saved, occupancy: active, release }),
        )
      if (input.boundary === "forgotten") yield* occupancy.forget(reservation)
    }
    const checkpoint = {
      ok: true,
      pid: process.pid,
      database: Database.path(),
      ...terminal,
      manifest,
      journal: path.join(directory, `${terminal.token}.json`),
      effects,
      active,
      release,
      outcome: input.outcome,
      temp,
    }
    yield* Effect.promise(() => fs.writeFile(input.report, JSON.stringify(checkpoint)))
    // Bypass Effect/runtime finalizers at this persisted crash boundary.
    process.exit(0)
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
await fs.writeFile(input.report, JSON.stringify(output))
// Recovery helpers have no active native actions to replay.
process.exit(0)
