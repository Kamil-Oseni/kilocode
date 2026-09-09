import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("snapshots exclude nested runtime stores and protect them from legacy restoration", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../..")
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      `--preload=${Bun.resolveSync("@opentui/solid/preload", root)}`,
      path.join(import.meta.dir, "fixtures/snapshot-internal.ts"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        KILO_TEST_HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, "[data] store"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        KILO_CONFIG_CONTENT: JSON.stringify({
          enabled_providers: [],
          formatter: false,
          lsp: false,
          indexing: { enabled: false },
        }),
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, out + err).toBe(0)
  } finally {
    proc.kill()
    await proc.exited
  }
}, 60_000)
