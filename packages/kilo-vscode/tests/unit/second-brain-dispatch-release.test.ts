import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { release } from "../../src/second-brain/control/catalog-v2"
import { setup } from "../../src/second-brain/setup-v2"

test("current dispatch release binds actual eleven source images and refuses either missing helper", async () => {
  const rows = await Promise.all(
    Object.entries(release).map(async ([name, sha]) => {
      const raw = await readFile(resolve(import.meta.dir, "../../script/memory/service", name))
      expect(createHash("sha256").update(raw).digest("hex")).toBe(sha)
      return [name, sha] as const
    }),
  )
  expect(rows).toHaveLength(11)
  const pins = Object.fromEntries(rows)
  const value = { protocol: "raya.memory.operation.v1", root: "C:\\Synthetic\\Notes", source_sha256: pins }
  expect(setup(value, "http://127.0.0.1:8874").source_sha256).toEqual(pins)
  for (const name of ["historical.py", "dispatch.py"]) {
    const partial = Object.fromEntries(rows.filter(([key]) => key !== name))
    expect(() => setup({ ...value, source_sha256: partial }, "http://127.0.0.1:8874")).toThrow()
  }
  const prior = Object.fromEntries(rows.filter(([name]) => !["historical.py", "dispatch.py"].includes(name)))
  expect(() => setup({ ...value, source_sha256: prior }, "http://127.0.0.1:8874")).toThrow()
})
