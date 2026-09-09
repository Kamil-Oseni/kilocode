import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright-core"

const binary = process.env.RAYA_TEST_BROWSER ?? chromium.executablePath()
const browser = existsSync(binary) ? test : test.skip

browser(
  "real browser semantic actions and smoke assertions reject ambiguity and preserve exact matching",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "raya-target-test-"))
    try {
      const output = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures/browser-target.ts")],
        target: "node",
        format: "esm",
        external: ["playwright-core"],
      })
      expect(output.success).toBe(true)
      const file = join(dir, "fixture.mjs")
      const module = pathToFileURL(Bun.resolveSync("playwright-core", import.meta.dir)).href
      await writeFile(file, (await output.outputs[0].text()).replaceAll('"playwright-core"', JSON.stringify(module)))
      const child = Bun.spawn(["node", file], {
        env: { ...globalThis.process.env, RAYA_TEST_BROWSER: binary },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Browser fixture exited ${code}: ${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)
