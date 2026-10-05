import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["publication", "corrupt"]) {
  test.skipIf(process.platform !== "win32")(
    `production ripgrep installation: ${mode}`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-ripgrep-installation-"))
      const env = { ...process.env }
      delete env.PSExecutionPolicyPreference
      const child = Bun.spawn([process.execPath, "run", "./test/kilocode/fixture/ripgrep-retirement.ts", mode], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...env,
          HOME: root,
          USERPROFILE: root,
          KILO_TEST_HOME: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          RAYA_RIPGREP_FIXTURE: root,
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_PURE: "1",
        },
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const code = await child.exited
      const logs = await output
      expect(code, logs.join("\n")).toBe(0)
      const receipt = JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"))
      expect(receipt.passed).toBe(true)
      expect(receipt.archiveChildCode).toBe(0)
    },
    30_000,
  )
}
