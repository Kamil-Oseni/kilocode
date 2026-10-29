import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { write } from "../../script/kilocode/write"

test("publish replaces an exactly eight-byte-shorter generated SSE signature without a stale tail", async () => {
  const base = path.resolve(tmpdir())
  const dir = await mkdtemp(path.join(base, "raya-sdk-write-"))
  if (path.dirname(dir) !== base) throw new Error("SDK test directory escaped its temporary parent")
  try {
    const file = path.join(dir, "types.gen.ts")
    const original = "// UTF-8 café 😀\nexport type SseFn = () => Promise<ServerSentEventsResult<TData, TError>>\n"
    const source = original.replace(
      "=> Promise<ServerSentEventsResult<TData, TError>>",
      "=> Promise<ServerSentEventsResult<TData>>",
    )
    expect(Buffer.byteLength(original) - Buffer.byteLength(source)).toBe(8)
    await writeFile(file, original)
    await write(file, source)
    expect(await readFile(file)).toEqual(Buffer.from(source))
    expect(await readdir(dir)).toEqual(["types.gen.ts"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
