import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { availability } from "../../src/kilo-provider/recovery"

test("availability observes both journals without reconciling, installing or mutating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-admin-recovery-"))
  const saved: { value: unknown } = { value: undefined }
  const input = {
    root,
    version: "1.2.3",
    target: `${process.platform}-${process.arch}`,
    binary: join(root, "unused-binary"),
    state: {
      get: () => saved.value,
      update: async () => {
        throw new Error("Read-only observation mutated state")
      },
    },
  }
  try {
    expect(await availability(input)).toEqual({ status: "absent", reason: "active-unavailable" })
    expect(await readdir(root)).toEqual([])
    saved.value = { version: "1.2.4", previous: "1.2.3", phase: "awaiting-reload" }
    expect(await availability(input)).toEqual({ status: "in-progress", reason: "installation-retained" })
    expect(saved.value).toEqual({ version: "1.2.4", previous: "1.2.3", phase: "awaiting-reload" })
    expect(await readdir(root)).toEqual([])
    await writeFile(join(root, "update-installation.json"), "malformed retained record")
    expect(await availability(input)).toEqual({ status: "invalid", reason: "verification-failed" })
    expect(await readFile(join(root, "update-installation.json"), "utf8")).toBe("malformed retained record")
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("raya-admin-recovery-"))
      throw new Error("Recovery fixture cleanup escaped its selected directory")
    await rm(root, { recursive: true, force: true })
  }
})
