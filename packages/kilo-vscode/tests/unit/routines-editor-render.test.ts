import { expect, test } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import path from "node:path"
import { transformAsync } from "@babel/core"

test("renders the actual schedule controls and reacts to native input events", async () => {
  const root = path.resolve(import.meta.dir, "../..")
  const id = crypto.randomUUID()
  const component = path.join(root, `.routine-editor-component-${id}.mjs`)
  const file = path.join(root, `.routine-editor-${id}.mjs`)
  try {
    for (const [source, target] of [
      ["webview-ui/src/components/routines/ScheduleEditor.tsx", component],
      ["tests/fixtures/routine-editor.tsx", file],
    ]) {
      const input = await Bun.file(path.join(root, source)).text()
      const result = await transformAsync(input, {
        filename: source,
        configFile: false,
        babelrc: false,
        presets: [
          [require.resolve("babel-preset-solid"), { generate: "dom" }],
          require.resolve("@babel/preset-typescript"),
        ],
      })
      if (!result?.code) throw new Error("The component compiler returned no code")
      await Bun.write(
        target,
        result.code
          .replace("../../webview-ui/src/components/routines/ScheduleEditor", `./${path.basename(component)}`)
          .replace("../../src/shared/routine-schedule", "./src/shared/routine-schedule.ts"),
      )
    }
    const child = Bun.spawnSync(["bun", "--conditions=browser", file], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
  } finally {
    for (const target of [file, component]) if (existsSync(target)) unlinkSync(target)
  }
}, 30_000)
