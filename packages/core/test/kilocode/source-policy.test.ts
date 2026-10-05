import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { covers, validatePolicy } from "../../src/kilocode/source-policy"

test("producer policy validates physical boundaries and excludes sibling prefixes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-policy-"))
  const directory = path.join(root, "approved")
  const file = path.join(root, "exact.json")
  await mkdir(directory)
  await writeFile(file, "{}")
  const policy = await validatePolicy({ version: 1, directories: [directory], files: [file] })
  expect(Object.isFrozen(policy)).toBe(true)
  expect(covers(policy, path.join(directory, "future", "file.json"))).toBe(true)
  expect(covers(policy, `${directory}-outside\\file.json`)).toBe(false)
  expect(covers(policy, file)).toBe(true)
  expect(covers(policy, `${file}.other`)).toBe(false)
})
test("producer policy refuses redundant, relative, duplicate and volume-wide boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-policy-refuse-"))
  for (const policy of [
    { version: 1, directories: [root, root], files: [] },
    { version: 1, directories: [root, path.join(root, "child")], files: [] },
    { version: 1, directories: [root], files: [path.join(root, "config.json")] },
    { version: 1, directories: ["relative"], files: [] },
    { version: 1, directories: [path.parse(root).root], files: [] },
  ])
    await assert.rejects(validatePolicy(policy))
})
test.skipIf(process.platform !== "win32")(
  "producer policy refuses junction aliases and multiply linked exact files",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-policy-links-"))
    const directory = path.join(root, "physical")
    const alias = path.join(root, "alias")
    await mkdir(directory)
    await symlink(directory, alias, "junction")
    await assert.rejects(validatePolicy({ version: 1, directories: [alias], files: [] }))
    const file = path.join(root, "config.json")
    await writeFile(file, "{}")
    await link(file, path.join(root, "other.json"))
    await assert.rejects(validatePolicy({ version: 1, directories: [], files: [file] }))
  },
)
