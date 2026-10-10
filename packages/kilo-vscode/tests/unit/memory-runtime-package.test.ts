import { expect, test } from "bun:test"
import path from "node:path"
import { listFiles, PackageManager } from "@vscode/vsce"
import { release, bridge } from "../../src/second-brain/control/catalog-capture"
import { current } from "../../src/second-brain/managed/catalog"
import { images } from "../../src/second-brain/managed/reuse-catalog"
import { sha } from "../../src/second-brain/control/frames"

test("the real package allowlist includes exact reviewed Memory runtimes and excludes fixture producers", async () => {
  const root = path.resolve(import.meta.dir, "../..")
  const files = await listFiles({ cwd: root, packageManager: PackageManager.None })
  const required = [
    "script/memory/capture_recovery.py",
    "script/memory/capture_revision.py",
    "script/memory/control.py",
    "script/memory/supervise.py",
    ...Object.keys(release).map((name) => "script/memory/service/" + name),
    ...Object.keys(images).map((name) => "script/memory/" + name),
  ]
  for (const file of required) expect(files).toContain(file)
  expect(sha(new Uint8Array(await Bun.file(path.join(root, "script/memory/supervise.py")).arrayBuffer()))).toBe(current)
  expect(sha(new Uint8Array(await Bun.file(path.join(root, "script/memory/control.py")).arrayBuffer()))).toBe(bridge)
  for (const [name, digest] of Object.entries(release))
    expect(sha(new Uint8Array(await Bun.file(path.join(root, "script/memory/service", name)).arrayBuffer()))).toBe(
      digest,
    )
  expect(files.filter((file) => /^script\/memory\/.*(_test|_fixture)\.py$/.test(file))).toEqual([])
  expect(files.filter((file) => file.startsWith("script/memory/") && /(__pycache__|\.pyc$)/.test(file))).toEqual([])
})
