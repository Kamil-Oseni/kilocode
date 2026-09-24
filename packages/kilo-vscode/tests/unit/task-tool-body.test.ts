import { afterAll, describe, expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { build, stop } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const root = path.resolve(import.meta.dir, "../..")
const webview = path.join(root, "webview-ui")
const fixture = path.join(root, "tests/fixtures/task-tool-body.tsx")

afterAll(() => stop())

describe("Task tool body", () => {
  it("keeps a completed report ahead of 20 folded actions and shows running actions", async () => {
    const solid = path.dirname(Bun.resolveSync("solid-js/package.json", webview))
    const aliases: Record<string, string> = {
      "solid-js": path.join(solid, "dist/solid.js"),
      "solid-js/web": path.join(solid, "web/dist/web.js"),
      "solid-js/store": path.join(solid, "store/dist/store.js"),
    }
    const dedupe = {
      name: "solid-dedupe",
      setup(ctx: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
      },
    }
    const result = await build({
      absWorkingDir: root,
      entryPoints: [fixture],
      bundle: true,
      conditions: ["browser"],
      external: ["happy-dom"],
      format: "esm",
      logLevel: "silent",
      platform: "node",
      plugins: [dedupe, solidPlugin()],
      target: "es2022",
      write: false,
    })
    const file = path.join(root, `.task-tool-body-${crypto.randomUUID()}.mjs`)
    await Bun.write(file, result.outputFiles[0]!.contents)
    const child = Bun.spawnSync(["bun", file], { cwd: webview, stdout: "pipe", stderr: "pipe", windowsHide: true })
    unlinkSync(file)
    const output = child.stdout.toString() + child.stderr.toString()
    expect(child.exitCode, output).toBe(0)
  })
})
