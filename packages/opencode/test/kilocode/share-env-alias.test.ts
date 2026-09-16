import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

type Output = {
  result: { id: string; url: string; secret: string }
  errors: string[]
  effectCalls: number
  before: number
  calls: string[]
  ingest?: { id: string; ingestPath: string }
  conflicts: string[]
}

const worker = path.join(import.meta.dir, "fixtures/share-env-alias-worker.ts")

async function run(input: { raya?: string; kilo?: string; ingest?: boolean }) {
  await using tmp = await tmpdir()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: path.join(tmp.path, "data"),
    XDG_CONFIG_HOME: path.join(tmp.path, "config"),
    XDG_STATE_HOME: path.join(tmp.path, "state"),
    XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    KILO_API_KEY: "private-ingest-token",
    RAYA_DISABLE_MODELS_FETCH: "1",
    RAYA_SHARE_TEST_INGEST: input.ingest ? "1" : "0",
  }
  delete env.RAYA_DISABLE_SHARE
  delete env.KILO_DISABLE_SHARE
  if (input.raya !== undefined) env.RAYA_DISABLE_SHARE = input.raya
  if (input.kilo !== undefined) env.KILO_DISABLE_SHARE = input.kilo

  const child = Bun.spawn([process.execPath, "--conditions=browser", worker], {
    cwd: path.join(import.meta.dir, "../.."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await child.exited
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(code, stderr).toBe(0)
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Output
}

function expectDisabled(output: Output) {
  expect(output.result).toEqual({ id: "", url: "", secret: "" })
  expect(output.errors).toEqual([
    "Sharing is disabled (RAYA_DISABLE_SHARE=1; legacy KILO_DISABLE_SHARE=1)",
    "Unshare is disabled (RAYA_DISABLE_SHARE=1; legacy KILO_DISABLE_SHARE=1)",
  ])
  expect(output.effectCalls).toBe(0)
  expect(output.before).toBe(0)
}

describe("share disable environment aliases", () => {
  test("Raya-only disable blocks public sharing without disabling private ingest", async () => {
    const output = await run({ raya: "true", ingest: true })
    expectDisabled(output)
    expect(output.ingest).toEqual({ id: "private-session", ingestPath: "/api/ingest/private-session" })
    expect(output.calls).toEqual(["https://api.kilo.ai/api/user", "https://ingest.kilosessions.ai/api/session"])
    expect(output.conflicts).toEqual([])
  }, 30_000)

  test("legacy-only disable blocks sharing with no network side effects", async () => {
    const output = await run({ kilo: "1" })
    expectDisabled(output)
    expect(output.calls).toEqual([])
    expect(output.conflicts).toEqual([])
  }, 30_000)

  test("truthy Raya alias wins safety-monotonically over a false legacy alias", async () => {
    const output = await run({ raya: "1", kilo: "false" })
    expectDisabled(output)
    expect(output.calls).toEqual([])
    expect(output.conflicts).toEqual(["RAYA_DISABLE_SHARE/KILO_DISABLE_SHARE"])
  }, 30_000)

  test("truthy legacy alias wins safety-monotonically over a false Raya alias", async () => {
    const output = await run({ raya: "false", kilo: "true" })
    expectDisabled(output)
    expect(output.calls).toEqual([])
    expect(output.conflicts).toEqual(["RAYA_DISABLE_SHARE/KILO_DISABLE_SHARE"])
  }, 30_000)
})
