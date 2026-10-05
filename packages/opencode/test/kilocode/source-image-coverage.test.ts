import assert from "node:assert/strict"
import { test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { select } from "../../src/kilocode/migration/profile-selection"
import { assertCoverage } from "../../src/kilocode/migration/source-image-coverage"

test.skipIf(process.platform !== "win32")(
  "acknowledged roots require live native held coverage",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-source-image-coverage-")))
    const data = path.join(root, "data/kilo")
    const storage = path.join(data, "storage")
    const nested = path.join(data, "nested")
    const external = path.join(root, "external")
    const similar = path.join(root, "data/kilo-other")
    await Promise.all(
      [storage, nested, external, similar, path.join(root, "db")].map((dir) => mkdir(dir, { recursive: true })),
    )
    const database = path.join(root, "db/raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('real held reader')")
    db.close()
    const file = path.join(nested, "present.json")
    await writeFile(file, '{"present":true}')
    await writeFile(path.join(external, "unselected.json"), '{"external":true}')
    await writeFile(path.join(similar, "unselected.json"), '{"sibling":true}')
    const auxiliary = path.join(nested, "auxiliary.db")
    const aux = new Database(auxiliary)
    aux.exec("CREATE TABLE evidence(value TEXT)")
    aux.close()
    const policy = { version: 1 as const, directories: [root], files: [] }
    const selected = await select({ database, storage, data }, policy)
    const configured = process.env.RAYA_TEST_DIRECTORY_HELPER
    const expected = process.env.RAYA_TEST_DIRECTORY_HELPER_SHA
    if (expected) assert(configured, "Explicit helper digest requires an explicit helper")
    const source = await realpath(configured ?? (await NativeProcess.source()))
    const bytes = await readFile(source)
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (expected) assert.equal(digest, expected)
    const executable = path.join(root, "raya-process-host.exe")
    await copyFile(source, executable)
    assert.equal(
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
      digest,
    )
    let token: Working | undefined
    await withImage(
      { roots: selected.roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
      (image) =>
        withWorking(image, selected, async (working) => {
          token = working
          assertCoverage(working, selected.roots)
          assertCoverage(working, [
            { kind: "json", path: file },
            { kind: "json", path: nested },
            { kind: "json", path: path.join(data, "auth.json") },
            { kind: "json", path: path.join(nested, "missing.json") },
            { kind: "json", path: path.join(data, "missing/deep/file.json") },
          ])
          if (process.platform === "win32") assertCoverage(working, [{ kind: "json", path: file.toUpperCase() }])
          const refused = (kind: "json" | "sqlite", file: string) =>
            assert.throws(
              () => assertCoverage(working, [{ kind, path: file }]),
              (err: unknown) =>
                err instanceof Error && "code" in err && err.code === "RAYA_SOURCE_STATE_SCOPE_UNCOVERED",
            )
          refused("json", external)
          refused("json", similar)
          refused("sqlite", auxiliary)
          refused("json", path.join(file, "impossible-descendant"))
          assert.throws(() => assertCoverage(Object.freeze({}) as Working, selected.roots), /unavailable/)
        }),
    )
    const retired = token
    assert(retired)
    assert.throws(() => assertCoverage(retired, selected.roots), /expired/)
    assert.equal(await readFile(file, "utf8"), '{"present":true}')
    await writeFile(path.join(data, "after.txt"), "native source permissions restored")
  },
  30000,
)
