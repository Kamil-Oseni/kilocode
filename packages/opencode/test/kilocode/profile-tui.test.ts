import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform !== "win32")(
  "actual Global state scopes and queued KV survive held image and encrypted inactive restore without consent activation",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-tui-scope-")))
    const base = { ...process.env }
    for (const name of Object.keys(base))
      if (/^(?:OTEL_|RAYA_|KILO_|OPENCODE_|GIT_)|(?:API_KEY|TOKEN|SECRET)$/.test(name)) delete base[name]
    for (const mode of ["source", "read"]) {
      const home = path.join(root, mode === "source" ? "producer" : "reader")
      await mkdir(home)
      const env = {
        ...base,
        HOME: home,
        USERPROFILE: home,
        KILO_TEST_HOME: home,
        LOCALAPPDATA: path.join(home, "local"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        RAYA_DB: path.join(home, "unused.db"),
        KILO_DB: path.join(home, "unused.db"),
        RAYA_AUTH_CONTENT: "{}",
        KILO_AUTH_CONTENT: "{}",
        KILO_DISABLE_MODELS_FETCH: "1",
        RAYA_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_PURE: "1",
      }
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "fixtures/profile-tui.ts"),
          root,
          mode,
        ],
        { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
      )
      const timer = setTimeout(() => child.kill(), 50000)
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await Bun.write(path.join(root, mode + "-stdout.log"), output)
        await Bun.write(path.join(root, mode + "-stderr.log"), error)
        expect(code, `Retained private ${root}: ${error}`).toBe(0)
        expect(output).toContain(mode === "source" ? "PROFILE_IMPORT_BUNDLE_READY" : "TUI_SCOPE_IMAGE_RESTORE_OK")
        expect(() => process.kill(child.pid, 0)).toThrow()
      } finally {
        clearTimeout(timer)
      }
    }
  },
  105000,
)
