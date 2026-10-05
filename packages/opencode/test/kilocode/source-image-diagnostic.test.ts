import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decode, refused } from "../../src/kilocode/daemon/image-diagnostic"
import { failure } from "../../src/kilocode/migration/source-failure"
import { staged } from "../../src/kilocode/migration/source-stage"

test("actual image frame parser rejects malformed bounded frames and fixed substeps preserve only classifications", () => {
  expect(decode('["123","C:\\\\private.exe"]')).toEqual(["123", "C:\\private.exe"])
  for (const text of ["PRIVATE_SECRET", "[]", '["not-birth","PRIVATE_PATH"]', '["123",false]', " ".repeat(65537)])
    expect(() => decode(text)).toThrow()
  const cause = new Error("PRIVATE_PATH_PASSWORD_STACK")
  for (const phase of ["probe", "frame", "path", "bytes", "current-birth"]) {
    const error = refused(cause, phase)
    expect(error.cause).toBe(cause)
    const report = failure(staged(error, "source-image"))
    expect(report.errors[0].code).toBe("RAYA_SOURCE_IMAGE_REFUSED")
    expect(report.errors[1].code).toBe(`RAYA_SOURCE_IMAGE_${phase.replace("-", "_").toUpperCase()}_REFUSED`)
    expect(JSON.stringify(report)).not.toContain("PRIVATE")
  }
  expect(failure(refused(cause, "PRIVATE_PHASE")).errors[0].code).toBe("RAYA_SOURCE_IMAGE_STAGE_INVALID")
  expect(
    JSON.stringify(
      failure(
        refused(cause, {
          get code() {
            throw cause
          },
        }),
      ),
    ),
  ).not.toContain("PRIVATE")
})

test.skipIf(process.platform !== "win32")(
  "real current image and naturally exited process retain the exact image diagnostic boundary",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-image-diagnostic-"))
    await mkdir(path.join(root, "local"))
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", "test/kilocode/fixtures/source-image-diagnostic.ts"],
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
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          KILO_DB: path.join(root, "private.db"),
          RAYA_DB: path.join(root, "private.db"),
          KILO_AUTH_CONTENT: "{}",
          RAYA_AUTH_CONTENT: "{}",
          KILO_DISABLE_MODELS_FETCH: "1",
          RAYA_DISABLE_MODELS_FETCH: "1",
        },
      },
    )
    const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, ...output])
      await Promise.all([
        writeFile(path.join(root, "stdout.log"), stdout),
        writeFile(path.join(root, "stderr.log"), stderr),
      ])
      expect(code, `Retained private image fixture ${root}`).toBe(0)
      expect(JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"))).toMatchObject({
        passed: true,
        current: true,
        probe: true,
        code: 0,
        forced: false,
      })
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  },
  50000,
)
