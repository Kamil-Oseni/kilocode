import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "./computer-use-installed-probe"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(pkg: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "raya-installed-probe-"))
  dirs.push(dir)
  await mkdir(join(dir, "bin"))
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg))
  await writeFile(join(dir, "bin", "raya-desktop-capture.exe"), "capture fixture")
  await writeFile(join(dir, "bin", "raya-desktop-input.exe"), "input fixture")
  return dir
}

describe("installed native capture provenance", () => {
  test("binds a snapshot version to bytes from the extracted extension", async () => {
    const dir = await fixture({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+abc.test.1" })
    const sha256 = createHash("sha256").update("capture fixture").digest("hex")
    expect(await inspect(dir, sha256)).toMatchObject({ version: "7.4.23-snapshot+abc.test.1", sha256 })
  })

  test("rejects an incorrect digest", async () => {
    const dir = await fixture({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+abc.test.1" })
    expect(inspect(dir, "0".repeat(64))).rejects.toThrow("SHA-256 does not match")
  })

  test("rejects a source package and a different extension", async () => {
    const dir = await fixture({ publisher: "eden", name: "raya", version: "7.4.23" })
    expect(inspect(dir)).rejects.toThrow("Expected an extracted")
    const other = await fixture({ publisher: "other", name: "raya", version: "7.4.23-snapshot+abc.test.1" })
    expect(inspect(other)).rejects.toThrow("Expected an extracted")
  })

  test("requires both installed native helpers", async () => {
    const dir = await fixture({ publisher: "eden", name: "raya", version: "7.4.23-snapshot+abc.test.1" })
    await rm(join(dir, "bin", "raya-desktop-input.exe"))
    expect(inspect(dir)).rejects.toThrow()
  })
})
