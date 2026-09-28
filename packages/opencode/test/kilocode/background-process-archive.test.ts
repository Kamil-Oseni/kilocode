import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { BackgroundProcess } from "@/kilocode/background-process"
import { allowed } from "@/kilocode/background-process/lifecycle"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Filesystem } from "@/util/filesystem"
import { Shell } from "@opencode-ai/core/shell"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import path from "node:path"
import { rm } from "node:fs/promises"

const it = testEffectShared(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node])))

function quote(value: string) {
  const text = value.replaceAll("\\", "/")
  return process.platform === "win32" ? `"${text.replaceAll('"', '""')}"` : `'${text.replaceAll("'", "'\\''")}'`
}

async function command(directory: string) {
  const file = path.join(directory, "archive-process.mjs")
  await Bun.write(file, 'console.log("ready"); setInterval(() => {}, 1000)')
  return `${Shell.ps(Shell.acceptable()) ? "& " : ""}${quote(process.execPath)} ${quote(file)}`
}

async function family(directory: string) {
  const child = path.join(directory, "surviving-child.mjs")
  const parent = path.join(directory, "completed-leader.mjs")
  await Bun.write(child, "setInterval(() => {}, 1000)")
  await Bun.write(
    parent,
    `import { spawn } from "node:child_process"; const child = spawn(process.execPath, [${JSON.stringify(child)}], { detached: true, stdio: "ignore" }); child.unref(); console.log("descendant=" + child.pid); setTimeout(() => process.exit(0), 1500)`,
  )
  return `${Shell.ps(Shell.acceptable()) ? "& " : ""}${quote(process.execPath)} ${quote(parent)}`
}

function manifest(directory: string, id: BackgroundProcess.ID) {
  const scope = `scope-${Hash.fast(`global\0${Filesystem.resolve(directory)}`)}`
  return path.join(Global.Path.state, "background-process", scope, `${id}.json`)
}

describe("organization detached process archive", () => {
  it.instance(
    "drains an ordinary process descendant after its command leader has exited",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Outside organization parent" })
        const owner = yield* sessions.create({ title: "Completed ordinary leader", parentID: parent.id })
        const cmd = yield* Effect.promise(() => family(test.directory))
        const info = yield* Effect.promise(() =>
          BackgroundProcess.start({
            sessionID: owner.id,
            command: cmd,
            lifetime: "parent",
            parentID: parent.id,
            ready: { pattern: "descendant=", timeout: 15_000 },
          }),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => BackgroundProcess.archive("ordinary-team", [owner.id])))
        expect(info.ready, info.output).toBe(true)
        yield* Effect.promise(() => BackgroundProcess.stopSession(owner.id))
        expect((yield* Effect.promise(() => BackgroundProcess.get(info.id)))?.sessionID).toBe(parent.id)
        const pid = Number(info.output.match(/descendant=(\d+)/)?.[1])
        expect(pid).toBeGreaterThan(0)
        yield* Effect.promise(() => Bun.sleep(3_000))
        expect(() => process.kill(pid, 0)).not.toThrow()
        expect((yield* Effect.promise(() => BackgroundProcess.occupancy([owner.id])))[0]?.ownership).toBe("owned")
        yield* Effect.promise(() => BackgroundProcess.archive("ordinary-team", [owner.id]))
        expect(() => process.kill(pid, 0)).toThrow()
        expect(yield* Effect.promise(() => Bun.file(manifest(test.directory, info.id)).exists())).toBe(false)
      }),
    90_000,
  )
  it.instance(
    "retains an interrupted ordinary dispatch without replay or a public command projection",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const owner = yield* sessions.create({ title: "Interrupted ordinary owner" })
        const id = BackgroundProcess.ID.ascending()
        const file = manifest(test.directory, id)
        const control = path.join(path.dirname(file), `${id}.stop`)
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all([file, `${control}.drained`, `${control}.job`].map((path) => rm(path, { force: true })))
          }),
        )
        const now = Date.now()
        const record = {
          version: 1,
          origin: owner.id,
          dispatch: "starting",
          scope: `scope:${Hash.fast(`global\0${Filesystem.resolve(test.directory)}`)}`,
          token: "private-dispatch-token",
          start: { sessionID: owner.id, command: "private-command", lifetime: "session" },
          info: {
            id,
            sessionID: owner.id,
            command: "private-command",
            cwd: test.directory,
            ports: [],
            status: "starting",
            lifetime: "session",
            ready: false,
            output: "",
            time: { started: now, updated: now },
          },
        }
        yield* Effect.promise(() => Filesystem.writeJson(file, record, 0o600))
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() => BackgroundProcess.archive("interrupted-team", [owner.id])).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
        const outside = yield* sessions.create({ title: "Promoted outside owner" })
        const promoted = {
          ...record,
          version: 2,
          dispatch: "registered",
          origin: owner.id,
          info: { ...record.info, sessionID: outside.id, pid: process.pid, lifetime: "persistent" },
          start: { ...record.start, sessionID: outside.id, lifetime: "persistent" },
        }
        yield* Effect.promise(() => Filesystem.writeJson(file, promoted, 0o600))
        const refusal = yield* Effect.promise(() =>
          BackgroundProcess.restart(id).then(
            () => "unexpected restart admission",
            (err: unknown) => String(err),
          ),
        )
        expect(refusal).toContain("stopping or archived organization")
        expect(yield* Effect.promise(() => Bun.file(file).json())).toEqual(promoted)
        const rows = yield* Effect.promise(() => BackgroundProcess.occupancy([owner.id]))
        expect(rows[0]?.ownership).toBe("unknown")
        expect(JSON.stringify(rows)).not.toContain("private-")
        expect(yield* Effect.promise(() => BackgroundProcess.list())).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
        const fresh = yield* sessions.create({ title: "Legacy uncontained owner" })
        yield* Effect.promise(() =>
          Filesystem.writeJson(
            file,
            {
              ...promoted,
              version: 1,
              origin: fresh.id,
              info: { ...promoted.info, sessionID: fresh.id },
              start: { ...promoted.start, sessionID: fresh.id },
            },
            0o600,
          ),
        )
        yield* Effect.promise(() =>
          Filesystem.writeJson(`${control}.drained`, { version: 1, token: record.token, empty: true }, 0o600),
        )
        yield* Effect.promise(() =>
          Filesystem.writeJson(`${control}.job`, { version: 1, token: record.token, assigned: true }, 0o600),
        )
        expect(
          yield* Effect.promise(() =>
            BackgroundProcess.restart(id).then(
              () => "unexpected",
              (err: unknown) => String(err),
            ),
          ),
        ).toContain("containment is unverified")
        expect(yield* Effect.promise(() => Bun.file(control).exists())).toBe(false)
        expect(yield* Effect.promise(() => BackgroundProcess.list())).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
        yield* Effect.promise(() => Filesystem.writeJson(file, { ...record, origin: undefined }, 0o600))
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() => BackgroundProcess.archive("interrupted-team", [owner.id])).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(yield* Effect.tryPromise(() => BackgroundProcess.occupancy([owner.id])).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
      }),
    15_000,
  )
  it.instance(
    "rejects a saved descendant after a durable archive fence",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Fenced root" })
        const child = yield* sessions.create({ title: "Fenced child", parentID: parent.id })
        yield* Effect.promise(() => BackgroundProcess.archive("fence-team", [parent.id]))
        expect(
          yield* Effect.promise(() =>
            allowed(child.id).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true)
      }),
    15_000,
  )
  it.instance(
    "stops persisted descendants and blocks restart while preserving unrelated processes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Completed routine" })
        const child = yield* sessions.create({ title: "Routine child", parentID: parent.id })
        const unrelated = yield* sessions.create({ title: "Unrelated" })
        const cmd = yield* Effect.promise(() => command(test.directory))
        const owned = yield* Effect.promise(() =>
          BackgroundProcess.start({
            sessionID: child.id,
            command: cmd,
            lifetime: "persistent",
            ready: { pattern: "ready", timeout: 15_000 },
          }),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => BackgroundProcess.archive("test-team", [parent.id])))
        if (!owned.ready) console.warn("Disposable archive fixture did not become ready:", owned.output)
        expect(owned.ready, owned.output).toBe(true)
        const other = yield* Effect.promise(() =>
          BackgroundProcess.start({
            sessionID: unrelated.id,
            command: cmd,
            lifetime: "persistent",
            ready: { pattern: "ready", timeout: 15_000 },
          }),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => BackgroundProcess.stop(other.id)))
        yield* Effect.promise(() => BackgroundProcess.archive("test-team", [parent.id]))
        expect(yield* Effect.promise(() => Bun.file(manifest(test.directory, owned.id)).exists())).toBe(false)
        expect(yield* Effect.promise(() => BackgroundProcess.get(owned.id))).toBeUndefined()
        expect(["starting", "running", "ready"]).toContain(
          (yield* Effect.promise(() => BackgroundProcess.get(other.id)))?.status ?? "unavailable",
        )
        expect(
          yield* Effect.promise(() =>
            allowed(child.id).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() =>
              BackgroundProcess.start({
                sessionID: child.id,
                command: cmd,
                lifetime: "persistent",
              }),
            ).pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* Effect.promise(() => BackgroundProcess.shutdown())
        expect((yield* Effect.promise(() => BackgroundProcess.list())).map((item) => item.id)).not.toContain(owned.id)
        expect(yield* Effect.promise(() => BackgroundProcess.restart(owned.id))).toBeUndefined()
      }),
    120_000,
  )

  it.instance(
    "retains uncertain live manifests and refuses archive without killing an unrelated identity",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const owner = yield* sessions.create({ title: "Unknown process owner" })
        const cmd = yield* Effect.promise(() => command(test.directory))
        const info = yield* Effect.promise(() =>
          BackgroundProcess.start({
            sessionID: owner.id,
            command: cmd,
            lifetime: "persistent",
            ready: { pattern: "ready", timeout: 15_000 },
          }),
        )
        const file = manifest(test.directory, info.id)
        yield* Effect.promise(() => BackgroundProcess.shutdown())
        const original = yield* Effect.promise(() => Bun.file(file).json())
        const control = path.join(path.dirname(file), `${info.id}.stop`)
        const job = `${control}.job`
        const assignment = yield* Effect.promise(() => Bun.file(job).text())
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Bun.write(file, JSON.stringify(original))
            await Bun.write(job, assignment)
            await BackgroundProcess.archive("uncertain-team", [owner.id])
          }),
        )
        yield* Effect.promise(() => rm(job))
        expect(yield* Effect.promise(() => BackgroundProcess.list())).toEqual([])
        expect(yield* Effect.promise(() => BackgroundProcess.stop(info.id))).toBeUndefined()
        expect(
          yield* Effect.promise(() =>
            BackgroundProcess.restart(info.id).then(
              () => "unexpected",
              (err: unknown) => String(err),
            ),
          ),
        ).toContain("containment is unverified")
        expect(yield* Effect.promise(() => Bun.file(control).exists())).toBe(false)
        expect(() => process.kill(info.pid!, 0)).not.toThrow()
        yield* Effect.promise(() => Bun.write(job, assignment))
        yield* Effect.promise(() => Bun.write(file, JSON.stringify({ ...original, token: "wrong-native-identity" })))
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() => BackgroundProcess.archive("uncertain-team", [owner.id])).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
        expect(yield* Effect.promise(() => BackgroundProcess.list())).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
      }),
    120_000,
  )
})
