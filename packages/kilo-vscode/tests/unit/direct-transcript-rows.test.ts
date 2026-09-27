import { afterAll, describe, expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { build, stop } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const root = path.resolve(import.meta.dir, "../..")
const webview = path.join(root, "webview-ui")
const fixture = "tests/fixtures/direct-transcript-rows.tsx"

afterAll(() => stop())

describe("direct transcript rows", () => {
  it("reveals a final acknowledgement under the same assistant key without remounting", async () => {
    const solid = path.dirname(Bun.resolveSync("solid-js/package.json", webview))
    const aliases: Record<string, string> = {
      "solid-js": path.join(solid, "dist/solid.js"),
      "solid-js/web": path.join(solid, "web/dist/web.js"),
      "solid-js/store": path.join(solid, "store/dist/store.js"),
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
      plugins: [
        {
          name: "solid-dedupe",
          setup(ctx) {
            ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
          },
        },
        solidPlugin(),
      ],
      target: "es2022",
      write: false,
    })
    const file = path.join(root, `.direct-transcript-rows-${crypto.randomUUID()}.mjs`)
    await Bun.write(file, result.outputFiles[0]!.contents)
    const child = Bun.spawnSync(["bun", file], { cwd: webview, stdout: "pipe", stderr: "pipe", windowsHide: true })
    unlinkSync(file)

    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
  }, 30_000)
})
