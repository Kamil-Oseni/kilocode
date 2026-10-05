import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { mockTuiRuntime } from "../../fixture/tui-runtime"
import { plugin } from "../../kilocode/tui-plugin-child" // kilocode_change

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

test("runs onDispose callbacks with aborted signal and is idempotent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "marker.txt")

      await Bun.write(
        file,
        `export default {
  id: "demo.lifecycle",
  tui: async (api, options) => {
    api.event.on("event.test", () => {})
    api.route.register([{ name: "lifecycle.route", render: () => null }])
    api.lifecycle.onDispose(async () => {
      const prev = await Bun.file(options.marker).text().catch(() => "")
      await Bun.write(options.marker, prev + "custom\\n")
    })
    api.lifecycle.onDispose(async () => {
      const prev = await Bun.file(options.marker).text().catch(() => "")
      await Bun.write(options.marker, prev + "aborted:" + String(api.lifecycle.signal.aborted) + "\\n")
    })
  },
}
`,
      )

      return { spec, marker }
    },
  })

  const { config, restore } = mockTuiRuntime(tmp.path, [[tmp.extra.spec, { marker: tmp.extra.marker }]])

  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
    await TuiPluginRuntime.dispose()

    const marker = await fs.readFile(tmp.extra.marker, "utf8")
    expect(marker).toContain("custom")
    expect(marker).toContain("aborted:true")

    // second dispose is a no-op
    await TuiPluginRuntime.dispose()
    const after = await fs.readFile(tmp.extra.marker, "utf8")
    expect(after).toBe(marker)
  } finally {
    await TuiPluginRuntime.dispose()
    restore()
  }
})

test(
  "rolls back failed plugin, loads the next, and retains initializer refusal",
  () => plugin("initial-failure"),
  25000,
) // kilocode_change

test("assigns sequential slot ids scoped to plugin", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "slot-plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "slot-setup.txt")

      await Bun.write(
        file,
        `import fs from "fs"

const mark = (label) => {
  fs.appendFileSync(${JSON.stringify(marker)}, label + "\\n")
}

export default {
  id: "demo.slot",
  tui: async (api) => {
    const one = api.slots.register({
      id: 1,
      setup: () => { mark("one") },
      slots: { home_logo() { return null } },
    })
    const two = api.slots.register({
      id: 2,
      setup: () => { mark("two") },
      slots: { home_bottom() { return null } },
    })
    mark("id:" + one)
    mark("id:" + two)
  },
}
`,
      )

      return { spec, marker }
    },
  })

  const { config, restore } = mockTuiRuntime(tmp.path, [tmp.extra.spec])
  const err = spyOn(console, "error").mockImplementation(() => {})

  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })

    const marker = await fs.readFile(tmp.extra.marker, "utf8")
    expect(marker).toContain("one")
    expect(marker).toContain("two")
    expect(marker).toContain("id:demo.slot")
    expect(marker).toContain("id:demo.slot:1")

    // no initialization failures
    const hit = err.mock.calls.find(
      (item) => typeof item[0] === "string" && item[0].includes("failed to initialize tui plugin"),
    )
    expect(hit).toBeUndefined()
  } finally {
    await TuiPluginRuntime.dispose()
    err.mockRestore()
    restore()
  }
})

test("joins timed-out cleanup before retaining refusal", () => plugin("held"), 25000) // kilocode_change
