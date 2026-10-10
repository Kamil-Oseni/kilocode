import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("pure model listing naturally closes a fresh profile without creating a Routine roster or cleanup cursor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-models-shutdown-"))
  const pkg = path.resolve(import.meta.dir, "../..")
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(OTEL_|RAYA_|KILO_)/.test(key) || /(API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    KILO_TEST_HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    RAYA_DB: path.join(root, "profile.sqlite"),
    KILO_DB: path.join(root, "profile.sqlite"),
    KILO_MODELS_PATH: path.join(pkg, "test/tool/fixtures/models-api.json"),
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    RAYA_DISABLE_PROJECT_CONFIG: "1",
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
      enabled_providers: ["anthropic"],
      experimental: { openTelemetry: false },
    }),
    KILO_AUTH_CONTENT: "{}",
    ANTHROPIC_API_KEY: "dummy",
    RAYA_NO_DAEMON: "1",
    KILO_NO_DAEMON: "1",
  })
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      `--preload=${Bun.resolveSync("@opentui/solid/preload", pkg)}`,
      path.join(pkg, "src/kilocode/cli/entry.ts"),
      "--pure",
      "models",
      "anthropic",
    ],
    {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await Promise.all([
    writeFile(path.join(root, "stdout.log"), stdout),
    writeFile(path.join(root, "stderr.log"), stderr),
  ])
  const files = await Array.fromAsync(
    new Bun.Glob("**/raya/{agent,agent-initialized,queue-cleanup-cursor}.json").scan({ cwd: root, onlyFiles: true }),
  )
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify({ code, pid: child.pid, stdoutEOF: true, stderrEOF: true, signal: child.signalCode, files }),
  )
  expect(code, `Retained original process evidence: ${root}\n${stderr}`).toBe(0)
  expect(child.signalCode).toBeNull()
  expect(stdout.split(/\r?\n/).some((line) => line.startsWith("anthropic/"))).toBe(true)
  expect(stderr).not.toContain("Scheduler work could not be confirmed settled")
  expect(stderr).not.toContain("Restore the worker list from a backup")
  expect(files).toEqual([])
}, 60_000)
