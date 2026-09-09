import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { UploadStage } from "@/kilocode/browser/upload-stage"
import { KiloReadObject } from "@/kilocode/tool/read-object"

test("authorized upload bytes stream by owned reference, expire, and reject changed sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-upload-stage-"))
  try {
    const source = join(dir, "report.csv")
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 71, 42)
    await writeFile(source, bytes)
    const stage = new UploadStage(join(dir, "stage"))
    const owner = { sessionID: "task", directory: dir, uploadID: randomUUID() }
    const info = await Effect.runPromise(
      Effect.gen(function* () {
        const file = yield* KiloReadObject.file(source)
        return yield* KiloReadObject.use(file, (bound) =>
          Effect.promise(() => stage.stage(owner, bound, AbortSignal.any([]))),
        )
      }),
    )
    expect(info.name).toBe("report.csv")
    expect(info.bytes).toBe(bytes.length)
    expect(info.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    const hash = createHash("sha256")
    let offset = 0
    while (offset < info.bytes) {
      const chunk = await stage.chunk(owner, info.id, offset)
      expect(chunk.offset).toBe(offset)
      const data = Buffer.from(chunk.data, "base64")
      expect(data.length).toBeLessThanOrEqual(1024 * 1024)
      hash.update(data)
      offset = chunk.next
    }
    expect(hash.digest("hex")).toBe(info.sha256)
    for (const changed of [
      { ...owner, sessionID: "other" },
      { ...owner, directory: join(dir, "other") },
      { ...owner, uploadID: randomUUID() },
    ]) {
      await expect(stage.chunk(changed, info.id, 0)).rejects.toThrow("another task")
      await expect(stage.release(changed, info.id)).rejects.toThrow("another task")
    }
    await expect(stage.chunk(owner, "../report.csv", 0)).rejects.toThrow("Invalid upload")
    await expect(stage.chunk(owner, info.id, -1)).rejects.toThrow("offset")
    await expect(stage.chunk(owner, info.id, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow("offset")
    await expect(stage.chunk(owner, info.id, info.bytes + 1)).rejects.toThrow("offset")
    const receipt = join(dir, "stage", info.id, "receipt.json")
    const value = JSON.parse(await readFile(receipt, "utf8"))
    await writeFile(receipt, JSON.stringify({ ...value, expires: 1 }))
    await expect(stage.chunk(owner, info.id, 0)).rejects.toThrow("expired")
    await stage.release(owner, info.id)
    await stage.release(owner, info.id)
    expect(await Bun.file(join(dir, "stage", info.id, "bytes")).exists()).toBe(false)

    const file = await Effect.runPromise(KiloReadObject.file(source))
    await writeFile(source, Buffer.alloc(bytes.length, 43))
    await expect(
      Effect.runPromise(
        KiloReadObject.use(file, (bound) => Effect.promise(() => stage.stage(owner, bound, AbortSignal.any([])))),
      ),
    ).rejects.toThrow()

    const orphan = join(dir, "stage", randomUUID())
    await Bun.write(join(orphan, "bytes"), "interrupted before receipt")
    const old = new Date(Date.now() - 7200000)
    await utimes(orphan, old, old)
    await stage.prune()
    expect(await Bun.file(join(orphan, "bytes")).exists()).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
