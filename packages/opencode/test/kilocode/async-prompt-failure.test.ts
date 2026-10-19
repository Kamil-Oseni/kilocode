import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withTimeout } from "../../src/util/timeout"

test("actual HTTP pre-intake failure retains the exact original submission identity after204", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-async-prompt-failure-"))
  const child = Bun.spawn(
    [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/async-prompt-failure.ts"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        KILO_TEST_HOME: root,
        RAYA_ASYNC_PROFILE: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        RAYA_DB: join(root, "raya.db"),
        KILO_NO_DAEMON: "1",
        RAYA_NO_DAEMON: "1",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_CONFIG_CONTENT: '{"formatter":false,"lsp":false,"permission":"deny","enabled_providers":[]}',
        RAYA_CONFIG_CONTENT: "",
        KILO_CONFIG: "",
        RAYA_CONFIG: "",
        KILO_CONFIG_DIR: "",
        RAYA_CONFIG_DIR: "",
        KILO_AUTH_CONTENT: "{}",
        RAYA_AUTH_CONTENT: "{}",
        KILO_SERVER_PASSWORD: "",
        RAYA_SERVER_PASSWORD: "",
      },
    },
  )
  const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  try {
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, ...streams]),
      45_000,
      `Retained pre-intake failure fixture: ${root}`,
    )
    await Bun.write(join(root, "stdout.log"), stdout)
    await Bun.write(join(root, "stderr.log"), stderr)
    expect(code, `Retained profile ${root}; ${stderr}`).toBe(0)
    expect(await Bun.file(join(root, "failure.json")).json()).toMatchObject({
      passed: true,
      active: 0,
      inputAccepted: false,
      inferenceAllowed: false,
    })
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await withTimeout(Promise.all([child.exited, ...streams]), 10_000, `Failure fixture remains live: ${root}`)
  }
}, 60000)
