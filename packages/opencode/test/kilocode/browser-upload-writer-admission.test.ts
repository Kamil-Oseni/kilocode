import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { UploadStage } from "@/kilocode/browser/upload-stage"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import { tmpdir } from "../fixture/fixture"

const id = "profile.cache.browser-uploads"

test("browser uploads pin one cache generation and preserve staged bytes while closed", async () => {
  await using tmp = await tmpdir()
  const original = Global.Path.cache
  const active = path.join(tmp.path, "active")
  const other = path.join(tmp.path, "other")
  const outside = path.join(tmp.path, "outside")
  const source = path.join(tmp.path, "source.txt")
  await Promise.all([fs.mkdir(active), fs.mkdir(other), fs.mkdir(outside), Bun.write(source, "authorized bytes")])
  const registry = ProfileWriterRegistry.make([id])
  await Effect.runPromise(registry.register(id))
  const base = ProfileWriterLive.from(registry, id)
  const seen: ProfileWriterRegistry.Snapshot[] = []
  let selected = active
  const admission: ProfileWriterLive.Admission = {
    run: (body) =>
      base.run(
        Effect.sync(() => {
          Global.Path.cache = selected
        }).pipe(
          Effect.andThen(registry.snapshot),
          Effect.tap((snapshot) => Effect.sync(() => seen.push(snapshot))),
          Effect.andThen(body),
        ),
      ),
  }
  const uploads = new UploadStage(undefined, admission)
  const owner = { sessionID: "session", directory: tmp.path, uploadID: randomUUID() }
  const stage = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = yield* KiloReadObject.file(source)
        return yield* KiloReadObject.use(file, (bound) =>
          Effect.promise(() => uploads.stage(owner, bound, AbortSignal.any([]))),
        )
      }),
    )
  const bytes = (root: string, ref: string) => path.join(root, "browser-uploads", ref, "bytes")

  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Global.Path.cache = outside
      }),
      () =>
        Effect.promise(async () => {
          const info = await stage()
          Global.Path.cache = outside
          expect(Buffer.from((await uploads.chunk(owner, info.id, 0)).data, "base64").toString()).toBe(
            "authorized bytes",
          )
          expect(seen).toHaveLength(2)
          expect(seen.every((snapshot) => snapshot.active.find((item) => item.id === id)?.count === 1)).toBe(true)
          expect(await Bun.file(bytes(active, info.id)).exists()).toBe(true)
          await expect(fs.access(path.join(outside, "browser-uploads"))).rejects.toThrow()

          const before = await Bun.file(bytes(active, info.id)).arrayBuffer()
          await Effect.runPromise(
            registry.quiesce(
              Effect.promise(async () => {
                Global.Path.cache = outside
                await expect(uploads.chunk(owner, info.id, 0)).rejects.toThrow()
                await expect(uploads.release(owner, info.id)).rejects.toThrow()
                await expect(uploads.prune()).rejects.toThrow()
                await expect(stage()).rejects.toThrow()
              }),
            ),
          )
          expect(Buffer.from(await Bun.file(bytes(active, info.id)).arrayBuffer())).toEqual(Buffer.from(before))

          Global.Path.cache = outside
          await uploads.release(owner, info.id)
          expect(await Bun.file(bytes(active, info.id)).exists()).toBe(false)

          selected = active
          Global.Path.cache = outside
          const first = await stage()
          selected = other
          Global.Path.cache = outside
          const second = await stage()
          expect(await Bun.file(bytes(active, first.id)).exists()).toBe(true)
          expect(await Bun.file(bytes(other, second.id)).exists()).toBe(true)
          selected = active
          Global.Path.cache = outside
          await uploads.release(owner, first.id)
          selected = other
          Global.Path.cache = outside
          await uploads.release(owner, second.id)

          selected = active
          const orphan = path.join(active, "browser-uploads", randomUUID())
          await fs.mkdir(orphan, { recursive: true })
          await Bun.write(path.join(orphan, "bytes"), "interrupted")
          const old = new Date(Date.now() - 7_200_000)
          await fs.utimes(orphan, old, old)
          Global.Path.cache = outside
          await uploads.prune()
          expect(await Bun.file(path.join(orphan, "bytes")).exists()).toBe(false)
          expect(await Effect.runPromise(registry.snapshot)).toMatchObject({ phase: "open", active: [] })
        }),
      () =>
        Effect.sync(() => {
          Global.Path.cache = original
        }),
    ),
  )
})
