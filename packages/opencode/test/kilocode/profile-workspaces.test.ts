import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { mapper, remap, references } from "../../src/kilocode/migration/profile-workspaces"
import { withTimeout } from "../../src/util/timeout"

test("only the shipped global project sentinel is excluded from filesystem workspace mappings", () => {
  const sentinel = [{ table: "project", columns: ["id", "worktree", "sandboxes"], rows: [["global", "/", "[]"]] }]
  expect(references(sentinel)).toEqual([])
  expect(remap(sentinel, new Map())).toEqual(sentinel)
  for (const table of [
    { table: "project", columns: ["id", "worktree"], rows: [["ordinary", "/"]] },
    { table: "project", columns: ["worktree"], rows: [["/"]] },
    { table: "session", columns: ["directory"], rows: [["/"]] },
  ]) {
    expect(references([table])).toEqual(["/"])
    expect(() => remap([table], new Map())).toThrow(/Unmapped/)
  }
})

test("global non-Git relative session paths use the destination directory volume root", () => {
  const target = path.join(os.tmpdir(), "mapped-global-workspace")
  const project = { table: "project", columns: ["id", "worktree", "sandboxes"], rows: [["global", "/", "[]"]] }
  const session = {
    table: "session",
    columns: ["project_id", "directory", "path"],
    rows: [["global", "/source/nested", "source/nested"]],
  }
  const map = new Map([["/source", target]])
  expect(remap([project, session], map)[1].rows[0]).toEqual([
    "global",
    path.join(target, "nested"),
    path.relative(path.resolve("/"), path.join(target, "nested")).replaceAll("\\", "/"),
  ])
  expect(() => remap([session], map)).toThrow(/declared project/)
  expect(() => remap([project, { ...session, rows: [["unrelated", "/source/nested", "source/nested"]] }], map)).toThrow(
    /declared project/,
  )
  expect(() => remap([project, session], new Map())).toThrow(/Unmapped/)
  const cross = remap([project, session], new Map([["/source", "D:/mapped-global"]]))[1].rows[0]
  expect(cross).toEqual(["global", path.join("D:/mapped-global", "nested"), "mapped-global/nested"])
  const absolute = { ...session, rows: [["global", "D:/source/nested", "D:/source/nested"]] }
  expect(remap([project, absolute], new Map([["D:/source", target]]))[1].rows[0]).toEqual([
    "global",
    path.join(target, "nested"),
    path.join(target, "nested"),
  ])
})

test("declared path mapping understands source separators and overlapping roots without touching prose", () => {
  const destination = path.join(os.tmpdir(), "mapped-root")
  const sandbox = path.join(os.tmpdir(), "mapped-sandbox")
  const translate = mapper(
    new Map([
      ["C:\\source", destination],
      ["c:/SOURCE/sandbox", sandbox],
    ]),
  )
  expect(translate("C:/SOURCE/sandbox/nested/file.ts")).toBe(path.join(sandbox, "nested", "file.ts"))
  expect(translate("c:\\source\\other\\file.ts")).toBe(path.join(destination, "other", "file.ts"))
  expect(() => translate("C:/source/../outside")).toThrow(/Unmapped/)
  expect(() => translate("C:/sourceish/file.ts")).toThrow(/Unmapped/)
  expect(mapper(new Map([["/source", destination]]))("/source/nested/file.ts")).toBe(
    path.join(destination, "nested", "file.ts"),
  )
  expect(() =>
    mapper(
      new Map([
        ["C:/source", destination],
        ["c:\\SOURCE", sandbox],
      ]),
    ),
  ).toThrow(/collide/)
  const prose = '{"directory":"C:/outside","text":"C:/source/sandbox"}'
  expect(
    remap([{ table: "part", columns: ["data"], rows: [[prose]] }], new Map()).flatMap((table) => table.rows),
  ).toEqual([[prose]])
})

test("only shipped nested directory arrays are interpreted; opaque adapter authority is inactive", () => {
  expect(() =>
    references([{ table: "project", columns: ["sandboxes"], rows: [['{"directory":"C:/source"}']] }]),
  ).toThrow()
  expect(() => references([{ table: "project", columns: ["sandboxes"], rows: [['["relative"]']] }])).toThrow(/absolute/)
  expect(() => references([{ table: "workspace", columns: ["directory"], rows: [["relative"]] }])).toThrow(/absolute/)
  const extra = '{"directory":"C:/unmapped","command":"do not execute"}'
  expect(remap([{ table: "workspace", columns: ["extra"], rows: [[extra]] }], new Map())[0].rows).toEqual([[null]])
})

test("native encrypted two-workspace restore and second restore preserve typed references and held startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-workspace-restores-"))
  const home = path.join(root, "private")
  await mkdir(home)
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:OTEL_|KILO_|RAYA_)|(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    KILO_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    RAYA_DB: path.join(home, "unused.db"),
    KILO_DB: path.join(home, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_PURE: "1",
  })
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures/profile-workspaces-restore.ts"), root],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  try {
    const [code, stdout, stderr] = await withTimeout(
      Promise.all([child.exited, output, errors]),
      60_000,
      `Workspace restore diagnostics retained at ${root}`,
    )
    await writeFile(path.join(root, "stderr.log"), stderr)
    assert.equal(code, 0, `${stderr}\nRetained private fixture ${root}`)
    const line = stdout.split(/\r?\n/).find((line) => line.startsWith("WORKSPACE_RESTORE_RECEIPT "))
    assert.ok(line)
    expect(JSON.parse(line.slice("WORKSPACE_RESTORE_RECEIPT ".length))).toEqual({
      passed: true,
      mapped: 2,
      hops: 2,
      arbitraryTextPreserved: true,
      held: true,
      portableAuthorityClaimed: false,
    })
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await writeFile(path.join(root, "stderr.log"), await errors)
    await output
  }
}, 90_000)
