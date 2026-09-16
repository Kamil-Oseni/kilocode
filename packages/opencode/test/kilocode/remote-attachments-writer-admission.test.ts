import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { RemoteAttachments } from "@/kilocode/remote-attachments"
import { SessionID } from "@/session/schema"
import { tmpdir } from "../fixture/fixture"

const id = "profile.tmp.attachments"
const log = { warn: () => {}, error: () => {} }
const part = {
  type: "file" as const,
  mime: "application/octet-stream",
  filename: "artifact.bin",
  url: "https://acct.r2.cloudflarestorage.com/artifact.bin",
}

test("remote attachments drain materialization and select temporary storage after admission", async () => {
  await using tmp = await tmpdir()
  const original = Global.Path.tmp
  const active = path.join(tmp.path, "active")
  const outside = path.join(tmp.path, "outside")
  await Promise.all([fs.mkdir(active), fs.mkdir(outside)])
  const registry = ProfileWriterRegistry.make([id])
  await Effect.runPromise(registry.register(id))
  const base = ProfileWriterLive.from(registry, id)
  const seen: ProfileWriterRegistry.Snapshot[] = []
  const admission: ProfileWriterLive.Admission = {
    run: (body) =>
      base.run(
        Effect.sync(() => {
          Global.Path.tmp = active
        }).pipe(
          Effect.andThen(registry.snapshot),
          Effect.tap((snapshot) => Effect.sync(() => seen.push(snapshot))),
          Effect.andThen(body),
        ),
      ),
  }
  const session = SessionID.make(`ses_attachment_admission_${crypto.randomUUID()}`)
  const scratch = (root: string) =>
    path.join(root, RemoteAttachments.SCRATCH_DIRNAME, Buffer.from(session).toString("base64url"))
  const fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]))

  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Global.Path.tmp = outside
      }),
      () =>
        Effect.promise(async () => {
          const result = RemoteAttachments.create({ sessionID: session, fetch, log, admission })
          const out = await result.materialize([part])
          expect(out[0]?.type).toBe("text")
          expect(seen).toHaveLength(1)
          expect(seen[0]?.active).toEqual([{ id, count: 1 }])
          const files = await fs.readdir(scratch(active))
          expect(files).toHaveLength(1)
          expect(await fs.readFile(path.join(scratch(active), files[0]!))).toEqual(Buffer.from([1, 2, 3, 4]))
          await expect(fs.access(scratch(outside))).rejects.toThrow()

          let release!: (response: Response) => void
          let started!: () => void
          const entered = new Promise<void>((resolve) => {
            started = resolve
          })
          const gate = new Promise<Response>((resolve) => {
            release = resolve
          })
          const delayed = RemoteAttachments.create({
            sessionID: SessionID.make(`${session}_delayed`),
            fetch: async () => {
              started()
              return gate
            },
            log,
            admission,
          })
          Global.Path.tmp = outside
          const job = delayed.materialize([part])
          await entered
          let drained = false
          const quiescence = Effect.runPromise(
            registry.quiesce(
              Effect.sync(() => {
                drained = true
              }),
            ),
          )
          await Bun.sleep(25)
          expect(drained).toBe(false)
          expect((await Effect.runPromise(registry.snapshot)).phase).toBe("draining")
          Global.Path.tmp = outside
          const closed = RemoteAttachments.create({
            sessionID: SessionID.make(`${session}_closed`),
            fetch,
            log,
            admission,
          })
          await expect(closed.materialize([part])).rejects.toThrow()
          await closed.dispose()
          release(new Response(new Uint8Array([5, 6, 7, 8])))
          await job
          await quiescence
          expect(drained).toBe(true)
          await expect(fs.access(scratch(outside))).rejects.toThrow()

          Global.Path.tmp = outside
          const resumed = RemoteAttachments.create({
            sessionID: SessionID.make(`${session}_resumed`),
            fetch,
            log,
            admission,
          })
          await resumed.materialize([part])
          await resumed.dispose()
          await expect(
            fs.access(
              path.join(
                active,
                RemoteAttachments.SCRATCH_DIRNAME,
                Buffer.from(`${session}_resumed`).toString("base64url"),
              ),
            ),
          ).rejects.toThrow()
          expect(await Effect.runPromise(registry.snapshot)).toMatchObject({ phase: "open", active: [] })

          await result.dispose()
          await delayed.dispose()
        }),
      () =>
        Effect.sync(() => {
          Global.Path.tmp = original
        }),
    ),
  )
})
