import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { capture, repair } from "@/kilocode/session/review-recovery"
import { canonical } from "@/kilocode/session/review-boundaries"
import { provideTmpdirProject, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const local = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, Storage.node, Database.node, CrossSpawnSpawner.node]),
  ),
)
local.live(
  "refuses changed inherited Undo generations while preserving identical target bytes",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const ancestor = yield* sessions.create({})
        const parent = yield* sessions.create({ parentID: ancestor.id })
        const file = path.join(dir, "notes.txt")
        yield* Effect.promise(() => fs.writeFile(file, "same bytes\r\n"))
        const services = { sessions, storage }
        const witness = yield* capture(services, parent.id, [file], [])
        expect(yield* repair(services, parent.id, [file], [], witness)).toBeDefined()
        yield* storage.write(["session_undo", ancestor.id], {
          version: 1,
          files: { [canonical(file)]: ["later-ancestor-generation"] },
        })
        expect(yield* repair(services, parent.id, [file], [], witness)).toBeUndefined()
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("same bytes\r\n")
      }),
    { git: true },
  ),
  60_000,
)
const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    pid: Schema.Number,
    bytes: Schema.Array(Schema.String),
    refused: Schema.optional(Schema.Boolean),
    calls: Schema.optional(Schema.Number),
    complete: Schema.optional(Schema.Boolean),
    raw: Schema.optional(Schema.Number),
    revert: Schema.optional(Schema.NullOr(Schema.String)),
  }),
)
for (const milestone of ["first", "all"]) {
  it.live(
    `recovers cross-owner metadata after a real process dies at the ${milestone} restore boundary without replay`,
    () =>
      Effect.gen(function* () {
        const profile = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({ git: true })
        const control = path.join(profile, "control.json")
        const fixture = fileURLToPath(new URL("./fixtures/review-recovery.ts", import.meta.url))
        const launch = (mode: string) =>
          Bun.spawn([process.execPath, fixture, mode, dir, control], {
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
            env: {
              ...process.env,
              XDG_DATA_HOME: path.join(profile, "data"),
              XDG_STATE_HOME: path.join(profile, "state"),
              XDG_CACHE_HOME: path.join(profile, "cache"),
              XDG_CONFIG_HOME: path.join(profile, "config"),
              KILO_TEST_HOME: path.join(profile, "home"),
              KILO_DB: path.join(profile, "review.sqlite"),
            },
          })
        const stopped = yield* Effect.promise(async () => {
          const proc = launch(milestone)
          const reader = proc.stdout.getReader()
          const timeout = setTimeout(() => proc.kill(), 120_000)
          try {
            const chunks: string[] = []
            while (!/RECOVERY_READY [^\n]*\n/.test(chunks.join(""))) {
              const next = await reader.read()
              if (next.done) throw new Error(await new Response(proc.stderr).text())
              chunks.push(new TextDecoder().decode(next.value))
            }
            const line = chunks
              .join("")
              .split("\n")
              .find((line) => line.startsWith("RECOVERY_READY "))
            if (!line) throw new Error("Missing actual restore milestone")
            return decode(JSON.parse(line.slice("RECOVERY_READY ".length)))
          } finally {
            clearTimeout(timeout)
            proc.kill()
            await proc.exited
            reader.releaseLock()
          }
        })
        const run = (mode: string) =>
          Effect.promise(async () => {
            const proc = launch(mode)
            const timeout = setTimeout(() => proc.kill(), 90_000)
            try {
              const [output, failure, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ])
              if (code !== 0) throw new Error(failure)
              const line = output.split("\n").find((line) => line.startsWith("RECOVERY_RESULT "))
              if (!line) throw new Error(`Missing recovery result: ${output}`)
              return decode(JSON.parse(line.slice("RECOVERY_RESULT ".length)))
            } finally {
              clearTimeout(timeout)
              if (proc.exitCode === null) proc.kill()
              await proc.exited
            }
          })
        if (milestone === "first") {
          expect(stopped.bytes).toEqual(["alpha original\r\n", "beta edited\r\n"])
          const resumed = yield* run("resume")
          expect(resumed.pid).not.toBe(stopped.pid)
          expect(resumed).toMatchObject({
            refused: true,
            calls: 0,
            complete: false,
            revert: "original",
            bytes: stopped.bytes,
          })
          return
        }
        expect(stopped.bytes).toEqual(["alpha original\r\n", "beta original\r\n"])
        const file = path.join(dir, "alpha", "notes.txt")
        yield* Effect.promise(() => fs.writeFile(file, "manual newer\r\n"))
        const manual = yield* run("resume")
        expect(manual).toMatchObject({
          refused: true,
          calls: 0,
          complete: false,
          revert: "original",
          bytes: ["manual newer\r\n", "beta original\r\n"],
        })
        yield* Effect.promise(() => fs.writeFile(file, "alpha original\r\n"))
        const replaced = yield* run("replaced")
        expect(replaced).toMatchObject({
          refused: true,
          calls: 0,
          complete: false,
          revert: "newer revert",
          bytes: stopped.bytes,
        })
        const changed = yield* run("raw")
        expect(changed).toMatchObject({ refused: true, calls: 0, complete: false, raw: 2, bytes: stopped.bytes })
        const generation = yield* run("generation")
        expect(generation).toMatchObject({ refused: true, calls: 0, complete: false, bytes: stopped.bytes })
        const resumed = yield* run("report")
        expect(resumed.pid).not.toBe(stopped.pid)
        expect(resumed).toMatchObject({
          refused: false,
          calls: 0,
          complete: true,
          raw: 0,
          revert: null,
          bytes: stopped.bytes,
        })
        const duplicate = yield* run("resume")
        expect(duplicate).toMatchObject({ refused: false, calls: 0, complete: true, bytes: stopped.bytes })
      }),
    300_000,
  )
}
