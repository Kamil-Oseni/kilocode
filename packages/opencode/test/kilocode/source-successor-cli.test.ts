import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withTimeout } from "../../src/util/timeout"

test("private source successor CLI refuses missing authority and joins normal retirement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-successor-cli-"))
  const home = path.join(root, "private")
  await mkdir(home)
  const marker = path.join(root, "source-marker.json")
  await writeFile(marker, '{"unchanged":true}')
  const secret = randomBytes(32).toString("hex")
  const file = path.join(home, "unused.db")
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:OTEL_|KILO_|RAYA_)|(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    KILO_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    RAYA_DB: file,
    KILO_DB: file,
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_PURE: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_NO_DAEMON: "1",
    RAYA_NO_DAEMON: "1",
    RAYA_SOURCE_HANDOFF_CHANNEL: secret,
    KILO_CONFIG_CONTENT: '{"formatter":false,"lsp":false,"enabled_providers":[]}',
  })
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.join(import.meta.dir, "../../src/index.ts"),
      "__profile-source-successor",
    ],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const output = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  const pid = child.pid
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Source successor test process has no native PID")
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, ...output]),
      20_000,
      "Source successor CLI did not retire",
    )
    await Bun.write(path.join(root, "stdout.log"), stdout)
    await Bun.write(path.join(root, "stderr.log"), stderr)
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("Raya source handoff failed.")
    expect(stderr).not.toContain("Raya shutdown failed:")
    expect(stderr).not.toContain(secret)
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await readFile(marker, "utf8")).toBe('{"unchanged":true}')
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await withTimeout(child.exited, 10_000, "Source successor test process remains live")
    await Promise.all(output)
  }
}, 35_000)
