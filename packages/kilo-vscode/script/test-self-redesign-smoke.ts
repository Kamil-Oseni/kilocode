// raya_change - compile the named self-redesign smoke run for Node/Playwright on Windows
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outdir = join(root, "tmp", "self-redesign-smoke")
await rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
await mkdir(outdir, { recursive: true })

const build = await Bun.build({
  entrypoints: [join(root, "tests", "integration", "raya-selfredesign-v1.ts")],
  outdir,
  target: "node",
  format: "cjs",
  external: ["playwright-core"],
})
if (!build.success) {
  for (const log of build.logs) console.error(log)
  process.exit(1)
}

const file = build.outputs[0]?.path
if (!file) throw new Error("Self-redesign smoke suite did not produce a Node bundle")
const child = Bun.spawn(["node", file], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  windowsHide: true,
})
const code = await child.exited
await rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.exit(code)
