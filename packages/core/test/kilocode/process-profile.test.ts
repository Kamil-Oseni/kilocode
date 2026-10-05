import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("actual managed Global graph roots remain owned until terminal native profile retirement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-process-profile-"))
  const child = Bun.spawn([process.execPath, "test/kilocode/fixture/process-profile.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      KILO_TEST_HOME: root,
      RAYA_PROCESS_PROFILE_ROOT: root,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      RAYA_DB: path.join(root, "unused.db"),
      KILO_DB: path.join(root, "unused.db"),
      KILO_CONFIG_DIR: "",
      RAYA_CONFIG_DIR: "",
    },
  })
  const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code, `Retained ${root}: ${stderr}`).toBe(0)
    expect(await Bun.file(path.join(root, "receipt.json")).json()).toMatchObject({
      passed: true,
      active: 0,
      lateRefused: true,
      portableCaptureAuthorized: false,
    })
    expect(await Bun.file(path.join(root, "unused.db")).exists()).toBe(false)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    expect(() => process.kill(child.pid, 0)).toThrow()
  }
}, 30000)
