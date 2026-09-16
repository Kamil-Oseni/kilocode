import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { PureEnv } from "../../../src/kilocode/cli/pure"

test("pure environment writer synchronizes both aliases", () => {
  const env = { RAYA_PURE: "0", KILO_PURE: "false", KEEP: "value" }
  PureEnv.enable(env)
  expect(env).toEqual({ RAYA_PURE: "1", KILO_PURE: "1", KEEP: "value" })
})

test("--pure writes both Raya and Kilo environment aliases", async () => {
  await using tmp = await tmpdir()
  const output = path.join(tmp.path, "pure.json")
  const preload = path.join(tmp.path, "preload.ts")
  await Bun.write(
    preload,
    `import { writeFileSync } from "node:fs"
process.on("exit", () => writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  raya: process.env.RAYA_PURE,
  kilo: process.env.KILO_PURE,
})))
`,
  )

  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      "--conditions=browser",
      path.join(process.cwd(), "src/index.ts"),
      "--pure",
      "debug",
      "paths",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        RAYA_PURE: "0",
        KILO_PURE: "0",
        RAYA_NO_DAEMON: "1",
        KILO_NO_DAEMON: "1",
        RAYA_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        RAYA_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        RAYA_CONFIG_CONTENT: '{"experimental":{"openTelemetry":false}}',
        KILO_CONFIG_CONTENT: '{"experimental":{"openTelemetry":false}}',
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

  expect(code).toBe(0)
  expect(await Bun.file(output).json()).toEqual({ raya: "1", kilo: "1" })
}, 30_000)
