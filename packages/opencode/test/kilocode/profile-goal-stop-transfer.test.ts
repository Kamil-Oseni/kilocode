import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform !== "win32" || !process.env.RAYA_GOAL_STOP_TRANSFER_PIN)(
  "actual HTTP Goal Stop retains typed history through encrypted Source transfer",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-goal-stop-transfer-"))
    const pin = path.resolve(process.env.RAYA_GOAL_STOP_TRANSFER_PIN!)
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-goal-stop-transfer.ts"),
        root,
        pin,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          KILO_TEST_HOME: root,
          LOCALAPPDATA: path.join(root, "local"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
          RAYA_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
        },
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(root, "stdout.log"), out)
    await Bun.write(path.join(root, "stderr.log"), err)
    expect(code, `Retained private fixture ${root}`).toBe(0)
    expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
      passed: true,
      actualHTTP: true,
      encryptedSource: true,
      inactive: true,
      executionAuthority: false,
      portable: false,
    })
  },
  120_000,
)
