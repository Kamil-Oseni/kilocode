import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prune } from "../../script/snapshot-retention"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("snapshot retention", () => {
  test("removes staged packages and stale installs while preserving current, recent and active snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-snapshot-retention-"))
    roots.push(root)
    const stage = join(root, "stage")
    const extensions = join(root, "extensions")
    await mkdir(stage)
    await mkdir(extensions)
    await Promise.all([
      writeFile(join(stage, "raya-vscode-snapshot-old.vsix"), "old"),
      writeFile(join(stage, "unrelated.vsix"), "keep"),
    ])
    const names = [
      "eden.raya-7.4.23-snapshot+old",
      "eden.raya-7.4.23-snapshot+active",
      "eden.raya-7.4.23-snapshot+recent",
      "eden.raya-7.4.23-snapshot+current",
      "eden.raya-7.4.23",
      "another.extension-1.0.0",
    ]
    for (const name of names) {
      await mkdir(join(extensions, name))
      await Bun.sleep(5)
    }

    const result = await prune({
      stage,
      extensions,
      version: "7.4.23-snapshot+current",
      active: [join(extensions, "eden.raya-7.4.23-snapshot+active")],
      retained: 2,
    })

    expect(result).toEqual({ packages: 1, extensions: 1 })
    expect(await readdir(stage)).toEqual(["unrelated.vsix"])
    expect(await readdir(extensions)).toEqual([
      "another.extension-1.0.0",
      "eden.raya-7.4.23",
      "eden.raya-7.4.23-snapshot+active",
      "eden.raya-7.4.23-snapshot+current",
      "eden.raya-7.4.23-snapshot+recent",
    ])
  })

  test("tolerates missing staging and extension directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-snapshot-retention-"))
    roots.push(root)
    expect(
      await prune({
        stage: join(root, "missing-stage"),
        extensions: join(root, "missing-extensions"),
        version: "7.4.23-snapshot+current",
      }),
    ).toEqual({ packages: 0, extensions: 0 })
  })
})
