import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const mode of [
  "files",
  "maintenance",
  "shutdown",
  "rebind",
  "errors",
  "outside",
  "competing",
  "reparse",
  "limit",
  "patch",
  "rollback",
  "rollback-failure",
  "recover",
  "sidecar",
  "stale",
  "schema",
  "sidecar-failure",
]) {
  test(`actual plan publication ${mode}`, async () => {
    await using tmp = await tmpdir()
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(SystemRoot|WINDIR|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|PSModulePath)$/i.test(name),
      ),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/plan-publication.ts"),
        tmp.path,
        mode,
      ],
      {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, err).toBe(0)
    const value = JSON.parse(out)
    expect(value.mode).toBe(mode)
    expect(value.joined).toBe(true)
    expect(value.profile).toBe(mode !== "errors")
    expect(value.uncertainty).toBe(mode === "errors")
  }, 30000)
}
