import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")
const entry = path.join(root, "src/index.ts")

async function run(dir: string, input: NodeJS.ProcessEnv) {
  const env = { ...process.env }
  delete env.RAYA_PERMISSION
  delete env.KILO_PERMISSION
  Object.assign(env, {
    XDG_DATA_HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_CACHE_HOME: dir,
    XDG_STATE_HOME: dir,
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    ...input,
  })
  const proc = Bun.spawn(
    [process.execPath, "--conditions=browser", entry, "--print-logs", "--log-level", "INFO", "debug", "paths"],
    { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, text: `${stdout}\n${stderr}` }
}

async function files(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory() ? files(file) : Promise.resolve([file])
    }),
  )
  return paths.flat().sort()
}

async function state(dir: string) {
  return (await files(dir)).filter((file) => !path.relative(dir, file).startsWith(`bun${path.sep}`))
}

describe("permission authority CLI preflight", () => {
  test.each([
    ["Raya", { RAYA_PERMISSION: '{"bash":"deny"}' }],
    ["Kilo", { KILO_PERMISSION: '{"bash":"deny"}' }],
  ] as const)(
    "accepts a valid %s-only overlay",
    async (_name, env) => {
      await using tmp = await tmpdir()
      const result = await run(tmp.path, env)
      expect(result.code).toBe(0)
    },
    20_000,
  )

  test.each([
    ["malformed", { RAYA_PERMISSION: "{cli-secret" }],
    [
      "conflicting",
      {
        RAYA_PERMISSION: '{"raya-cli-secret":"allow"}',
        KILO_PERMISSION: '{"legacy-cli-secret":"deny"}',
      },
    ],
  ] as const)(
    "refuses %s authority before startup side effects",
    async (_name, env) => {
      await using tmp = await tmpdir()
      const before = await state(tmp.path)
      const result = await run(tmp.path, env)
      expect(result.code).not.toBe(0)
      expect(result.text).toContain("RAYA_PERMISSION")
      expect(result.text).not.toContain("cli-secret")
      expect(await state(tmp.path)).toEqual(before)
    },
    20_000,
  )
})
