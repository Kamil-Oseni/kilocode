import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { withTimeout } from "../../src/util/timeout"

test("public import entry restores actual encrypted SQL and disabled workers without original Global bootstrap or secret output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-import-cli-"))
  const env = { ...process.env }
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = path.join(root, "interpreter-cache")
  for (const name of Object.keys(env))
    if (/^(?:OTEL_|RAYA_|KILO_|OPENCODE_|GIT_)|(?:API_KEY|TOKEN|SECRET)$/.test(name)) delete env[name]
  const original = path.join(root, "original-no-bootstrap")
  const home = (directory: string) => ({
    HOME: directory,
    USERPROFILE: directory,
    KILO_TEST_HOME: directory,
    LOCALAPPDATA: path.join(directory, "local"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    RAYA_DB: path.join(directory, "unused.db"),
    KILO_DB: path.join(directory, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_PURE: "1",
  })
  const run = async (name: string, args: string[], overrides: NodeJS.ProcessEnv, stdin = "") => {
    const child = Bun.spawn([process.execPath, "run", "--conditions=browser", ...args], {
      env: { ...env, ...overrides },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    await child.stdin.write(stdin)
    await child.stdin.end()
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, output, errors]),
        45000,
        `Import retained at ${root}`,
      )
      await writeFile(path.join(root, `${name}.log`), stderr)
      expect(stdout + stderr).not.toContain("IMPORT_PRIVATE_é_日本語_PASSWORD")
      expect(stdout + stderr).not.toContain("é".repeat(6))
      expect(() => process.kill(child.pid, 0)).toThrow()
      return { code, stdout, stderr }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await writeFile(path.join(root, `${name}.log`), await errors)
      await output
    }
  }
  const prepared = await run(
    "bundle",
    [path.join(import.meta.dir, "fixtures/profile-import-bundle.ts"), root],
    home(path.join(root, "producer")),
  )
  assert.equal(prepared.code, 0, prepared.stderr)
  const archive = path.join(root, "profile.raya")
  const bytes = await readFile(archive)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const workspace = path.join(root, "destination-workspace")
  await mkdir(workspace)
  const mapping = path.join(root, "mapping.json")
  await writeFile(mapping, JSON.stringify({ workspaces: { [path.join(root, "source-workspace")]: workspace } }))
  const entry = path.join(import.meta.dir, "../../src/kilocode/cli/entry.ts")
  const input = (target: string, hash = digest, map = mapping) => [
    entry,
    "profile-import",
    archive,
    target,
    "--mapping",
    map,
    "--sha256",
    hash,
  ]
  const password = JSON.stringify({ password: "é".repeat(6) })
  const target = path.join(root, "destination")
  const accepted = await run("accepted", input(target), home(original), password)
  assert.equal(accepted.code, 0, accepted.stderr)
  const result: unknown = JSON.parse(accepted.stdout.trim())
  assert.ok(
    result && typeof result === "object" && "path" in result && typeof result.path === "string" && "env" in result,
  )
  assert.ok(result.env && typeof result.env === "object" && "LOCALAPPDATA" in result.env)
  expect(result.env.LOCALAPPDATA).toBe(path.join(target, "local"))
  const db = new Database(path.join(result.path, "raya.db"), { readonly: true })
  try {
    expect(db.query<{ title: string; directory: string }, []>("SELECT title,directory FROM session").get()?.title).toBe(
      "Imported actual chat",
    )
    expect(db.query<{ data: string }, []>("SELECT data FROM part").get()?.data).toContain("IMPORT_CAFÉ_日本語_😀")
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM session_input").get()?.count).toBe(0)
  } finally {
    db.close()
  }
  const agents = JSON.parse(await readFile(path.join(result.path, "storage/raya/agent.json"), "utf8"))
  expect(agents[0].enabled).toBe(false)
  expect(JSON.parse(await readFile(path.join(result.path, "storage/raya/restore-hold.json"), "utf8")).state).toBe(
    "held",
  )
  expect(accepted.stdout).toContain('"reconnectCredentials":true')
  expect(accepted.stdout).toContain('"portableCaptureAuthorized":false')
  for (const [name, args, secret] of [
    [
      "wrong-password",
      input(path.join(root, "wrong-password")),
      JSON.stringify({ password: "wrong_private_password" }),
    ],
    ["wrong-digest", input(path.join(root, "wrong-digest"), "0".repeat(64)), password],
    ["too-long-stdin", input(path.join(root, "too-long-stdin")), "x".repeat(4097)],
    ["short-utf8", input(path.join(root, "short-utf8")), JSON.stringify({ password: "ééééé" })],
    [
      "unknown-secret",
      [...input(path.join(root, "unknown-secret")), "--password", "IMPORT_PRIVATE_é_日本語_PASSWORD"],
      password,
    ],
    ["occupied", input(target), password],
  ] as const) {
    const refused = await run(name, [...args], home(original), secret)
    expect(refused.code).toBe(1)
    expect(refused.stdout).toBe("")
  }
  const missing = path.join(root, "missing-mapping.json")
  await writeFile(missing, JSON.stringify({ workspaces: {} }))
  const unmapped = await run("unmapped", input(path.join(root, "unmapped"), digest, missing), home(original), password)
  expect(unmapped.code).toBe(1)
  expect(unmapped.stdout).toBe("")
  const oversized = path.join(root, "oversized.raya")
  const handle = await open(oversized, "wx")
  try {
    await handle.truncate(180 * 1024 * 1024 + 1)
  } finally {
    await handle.close()
  }
  const large = input(path.join(root, "too-large"))
  large[2] = oversized
  const refused = await run("oversized", large, home(original), password)
  expect(refused.code).toBe(1)
  expect(refused.stdout).toBe("")
  for (const name of ["CONFIG", "MODELS_PATH"]) {
    const directory = path.join(root, `custom-${name}`)
    await mkdir(directory)
    const file = path.join(directory, "active.json")
    await writeFile(file, '{"untouched":true}')
    const rejected = await run(
      name,
      input(path.join(directory, "new-container")),
      { ...home(original), [`RAYA_${name}`]: file },
      password,
    )
    expect(rejected.code).toBe(1)
    expect(rejected.stdout).toBe("")
    expect(await readFile(file, "utf8")).toBe('{"untouched":true}')
  }
  expect(
    await lstat(original).then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return false
        throw err
      },
    ),
  ).toBe(false)
  expect(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
  ).toBe(digest)
}, 180000)
