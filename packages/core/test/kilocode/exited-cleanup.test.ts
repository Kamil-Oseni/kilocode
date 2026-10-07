import { expect, test } from "bun:test"
import path from "node:path"

for (const mode of ["kill", "scope"])
  test.skipIf(process.platform !== "win32")(
    `Windows ${mode} retains a short command's natural exit during cancellation`,
    async () => {
      const child = Bun.spawn([process.execPath, "test/kilocode/fixtures/natural-cleanup.ts", mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: { ...process.env, RAYA_SOURCE_MEMBER_DIAGNOSTICS: "1", RAYA_TEST_NODE: Bun.which("node")! },
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(0)
      expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({
        mode,
        code: 0,
        originalOutputDrained: true,
        taskkillCount: 0,
      })
    },
    20000,
  )

for (const mode of ["kill", "scope"])
  test.skipIf(process.platform !== "win32")(
    `Windows ${mode} waits for buffered pipes after the original child exits`,
    async () => {
      const child = Bun.spawn([process.execPath, "test/kilocode/fixtures/exited-cleanup.ts", mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: { ...process.env, RAYA_SOURCE_MEMBER_DIAGNOSTICS: "1", RAYA_TEST_NODE: Bun.which("node")! },
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({
        passed: true,
        mode,
        originalClose: true,
        code: 0,
        bufferedOutputDrained: true,
        taskkillCount: 0,
      })
    },
    20000,
  )

for (const mode of ["kill", "scope"])
  test.skipIf(process.platform !== "win32")(
    `Windows ${mode} observes an original native exit before sending cleanup`,
    async () => {
      const child = Bun.spawn([process.execPath, "test/kilocode/fixtures/pending-cleanup.ts", mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: { ...process.env, RAYA_SOURCE_MEMBER_DIAGNOSTICS: "1", RAYA_TEST_NODE: Bun.which("node")! },
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(0)
      expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({
        mode,
        originalNativeCode: 0,
        originalCloseCode: 0,
        originalOutputDrained: true,
        stopped: true,
        taskkillCount: 0,
        actualTaskkillCodes: [],
        pending: 0,
      })
    },
    20000,
  )
