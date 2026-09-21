import { expect, test } from "bun:test"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")

test("one-worker organization offers its worker chat", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/routine-assignment-view.mjs"], {
    cwd: root,
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
})

test("organization assignment dialog has left and bottom inset", async () => {
  const css = await Bun.file(new URL("../../webview-ui/src/styles/routines.css", import.meta.url)).text()
  const start = css.indexOf(".routines-assignment {")
  const end = css.indexOf("}", start)
  const rule = css.slice(start, end)
  expect(rule).toContain("box-sizing: border-box")
  expect(rule).toContain("padding: 0 var(--raya-space-20) var(--raya-space-16)")
})
