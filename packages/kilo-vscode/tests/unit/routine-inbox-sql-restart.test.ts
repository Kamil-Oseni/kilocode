import { expect, test } from "bun:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("mounted Routine Inbox saves exact SQL drafts and attachments across worker switch and process restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-routine-sql-mounted-"))
  const temp = path.resolve(os.tmpdir())
  expect(path.dirname(root)).toBe(temp)
  expect(path.basename(root)).toMatch(/^raya-routine-sql-mounted-/)
  const receipts: { phase: string; pid: number; exit: number; absent: boolean }[] = []
  const run = async (phase: "write" | "read") => {
    const env = Object.fromEntries(
      ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "NO_COLOR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    )
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"])
      env[key] = path.join(root, key.toLowerCase())
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", "tests/fixtures/routine-inbox-sql-restart.mjs", phase, root],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env,
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timer = setTimeout(() => child.kill(), 40_000)
    try {
      const code = await child.exited
      const [stdout, stderr] = await output
      const absent = (() => {
        try {
          process.kill(child.pid, 0)
          return false
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH"
        }
      })()
      receipts.push({ phase, pid: child.pid, exit: code, absent })
      expect(code, stdout + stderr).toBe(0)
      expect(absent, stdout + stderr).toBe(true)
      if (phase === "read") expect(stdout).toContain('"attachmentBytes":14')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await output
    }
  }
  try {
    await run("write")
    await run("read")
  } finally {
    await rm(root, { recursive: true, force: true })
    const profileRemoved = await access(root).then(
      () => false,
      () => true,
    )
    await writeFile(
      path.resolve(import.meta.dir, "../../../../.tmp/routine-inbox-sql-restart.json"),
      JSON.stringify({ receipts, profileRemoved }, null, 2),
    )
    expect(profileRemoved).toBe(true)
  }
}, 100_000)
