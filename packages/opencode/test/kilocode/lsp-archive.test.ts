import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extract } from "../../src/kilocode/lsp/install"
import { command } from "../../src/kilocode/lsp/process"
import { spawn } from "../../src/lsp/launch"

test("actual native tar listing, size validation and extraction under a disposable path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "raya-lsp-tar-"))
  const source = path.join(root, "source")
  const target = path.join(root, "target")
  const archive = path.join(root, "fixture.tar.gz")
  await fs.mkdir(source)
  await fs.mkdir(target)
  await fs.writeFile(path.join(source, "content.txt"), "finite native tar fixture")
  await command(spawn("tar", ["-czf", archive, "-C", source, "content.txt"]))
  await extract(archive, target, false)
  expect(await fs.readFile(path.join(target, "content.txt"), "utf8")).toBe("finite native tar fixture")
}, 15_000)
