import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

// kilocode_change start
test.each([
  ["1", undefined],
  [undefined, "1"],
  ["1", "0"],
  ["0", "1"],
  ["", "1"],
] as const)("skips external tui plugins when either pure alias enables safety", async (raya, kilo) => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "called.txt")
      const meta = path.join(dir, "plugin-meta.json")

      await Bun.write(
        file,
        `export default {
  id: "demo.pure",
  tui: async (_api, options) => {
    if (!options?.marker) return
    await Bun.write(options.marker, "called")
  },
}
`,
      )

      return { spec, marker, meta }
    },
  })

  const current = { raya: process.env.RAYA_PURE, kilo: process.env.KILO_PURE }
  const meta = process.env.KILO_PLUGIN_META_FILE
  if (raya === undefined) delete process.env.RAYA_PURE
  else process.env.RAYA_PURE = raya
  if (kilo === undefined) delete process.env.KILO_PURE
  else process.env.KILO_PURE = kilo
  process.env.KILO_PLUGIN_META_FILE = tmp.extra.meta

  const config = createTuiResolvedConfig({
    plugin: [[tmp.extra.spec, { marker: tmp.extra.marker }]],
    plugin_origins: [
      {
        spec: [tmp.extra.spec, { marker: tmp.extra.marker }],
        scope: "local",
        source: path.join(tmp.path, "tui.json"),
      },
    ],
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)

  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
    await expect(fs.readFile(tmp.extra.marker, "utf8")).rejects.toThrow()
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    if (current.raya === undefined) delete process.env.RAYA_PURE
    else process.env.RAYA_PURE = current.raya
    if (current.kilo === undefined) delete process.env.KILO_PURE
    else process.env.KILO_PURE = current.kilo
    if (meta === undefined) {
      delete process.env.KILO_PLUGIN_META_FILE
    } else {
      process.env.KILO_PLUGIN_META_FILE = meta
    }
  }
})
// kilocode_change end
