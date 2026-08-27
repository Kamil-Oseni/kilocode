// raya_change - Milestone G compile-and-run live browser suite under Node on Windows
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outdir = join(root, "tmp", "browser-smoke-live")
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const build = await Bun.build({
  entrypoints: [join(root, "tests", "integration", "browser-smoke-live.ts")],
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
if (!file) throw new Error("Live smoke suite did not produce a Node bundle")
const child = Bun.spawn(["node", file], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  windowsHide: true,
})
const code = await child.exited
await rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.exit(code)
