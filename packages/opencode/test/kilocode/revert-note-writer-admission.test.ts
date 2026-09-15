import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { RayaRevertNote } from "@/kilocode/session/revert-note"
import { tmpdir } from "../fixture/fixture"

const id = "profile.data.revert-note"

test("revert notes pin one profile generation and preserve bytes while closed", async () => {
  await using tmp = await tmpdir()
  const original = Global.Path.data
  const active = path.join(tmp.path, "active")
  const other = path.join(tmp.path, "other")
  const outside = path.join(tmp.path, "outside")
  await Promise.all([fs.mkdir(active), fs.mkdir(other), fs.mkdir(outside)])
  const registry = ProfileWriterRegistry.make([id])
  await Effect.runPromise(registry.register(id))
  const base = ProfileWriterLive.from(registry, id)
  const seen: ProfileWriterRegistry.Snapshot[] = []
  let selected = active
  const admission: ProfileWriterLive.Admission = {
    run: (body) =>
      base.run(
        Effect.sync(() => {
          Global.Path.data = selected
        }).pipe(
          Effect.andThen(registry.snapshot),
          Effect.tap((snapshot) => Effect.sync(() => seen.push(snapshot))),
          Effect.andThen(body),
        ),
      ),
  }
  const session = `ses_revert_admission_${crypto.randomUUID()}`
  const file = (root: string) => path.join(root, "raya", "revert-note", `${session}.json`)

  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Global.Path.data = outside
      }),
      () =>
        Effect.promise(async () => {
          await RayaRevertNote.record(session, [], admission)
          expect(seen).toHaveLength(0)
          await RayaRevertNote.record(session, ["C:/tmp/a.txt"], admission)
          Global.Path.data = outside
          expect(await RayaRevertNote.take(session, admission)).toEqual(["C:/tmp/a.txt"])
          expect(seen).toHaveLength(2)
          expect(seen.every((snapshot) => snapshot.active.find((item) => item.id === id)?.count === 1)).toBe(true)
          await expect(fs.access(file(outside))).rejects.toThrow()

          Global.Path.data = outside
          await RayaRevertNote.record(session, ["C:/tmp/a.txt"], admission)
          const before = await Bun.file(file(active)).text()
          await Effect.runPromise(
            registry.quiesce(
              Effect.promise(async () => {
                Global.Path.data = outside
                await expect(RayaRevertNote.record(session, ["C:/tmp/b.txt"], admission)).rejects.toThrow()
                await expect(RayaRevertNote.take(session, admission)).rejects.toThrow()
              }),
            ),
          )
          expect(await Bun.file(file(active)).text()).toBe(before)

          Global.Path.data = outside
          await RayaRevertNote.record(session, ["C:/tmp/b.txt"], admission)
          Global.Path.data = outside
          expect(await RayaRevertNote.take(session, admission)).toEqual(["C:/tmp/a.txt", "C:/tmp/b.txt"])

          selected = active
          Global.Path.data = outside
          await RayaRevertNote.record(session, ["C:/tmp/active.txt"], admission)
          selected = other
          Global.Path.data = outside
          await RayaRevertNote.record(session, ["C:/tmp/other.txt"], admission)
          selected = active
          Global.Path.data = outside
          expect(await RayaRevertNote.take(session, admission)).toEqual(["C:/tmp/active.txt"])
          selected = other
          Global.Path.data = outside
          expect(await RayaRevertNote.take(session, admission)).toEqual(["C:/tmp/other.txt"])
          expect(await Effect.runPromise(registry.snapshot)).toMatchObject({ phase: "open", active: [] })
        }),
      () =>
        Effect.sync(() => {
          RayaRevertNote.dropCache()
          Global.Path.data = original
        }),
    ),
  )
})
