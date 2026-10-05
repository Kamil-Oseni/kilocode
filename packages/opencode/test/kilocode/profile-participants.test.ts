import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { withTimeout } from "../../src/util/timeout"

test("actual TUI and production export observations survive local retirement and join the held root union", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-participant-union-"))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/profile-participants.ts"), dir], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      KILO_TEST_HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      XDG_STATE_HOME: path.join(dir, "state"),
      RAYA_DB: path.join(dir, "unused.db"),
      XDG_DATA_HOME: path.join(dir, "data"),
      KILO_SESSION_EXPORT_ALLOW_CUSTOM_INGEST: "1",
      KILO_SESSION_EXPORT_AUTH_TOKEN: "",
    },
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    expect(await withTimeout(child.exited, 30_000, `Retained participant union: ${dir}`), await stderr).toBe(0)
    const receipt = JSON.parse(await stdout)
    expect(receipt).toMatchObject({ passed: true, participants: 2, fixtureRoots: 5, portable: false })
    expect(receipt.roots).toBe(receipt.baseline + 5)
    expect(await Bun.file(path.join(dir, "unused.db")).exists()).toBe(false)
    expect(() => process.kill(child.pid, 0)).toThrow()
    await fs.rm(dir, { recursive: true, force: true })
  } catch (err) {
    await fs.writeFile(path.join(dir, "failure.txt"), String(err))
    console.error(`Retained participant union: ${dir}`)
    throw err
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 40_000)
