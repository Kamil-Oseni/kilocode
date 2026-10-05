import { test, expect } from "bun:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { remap } from "../../src/kilocode/migration/profile-workspaces"
test.skipIf(process.platform !== "win32")(
  "encrypted native directory aliases preserve creation lineage across two inactive restores",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-directory-alias-"))
    const home = path.join(root, "home")
    await mkdir(home)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          !/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|TOKEN|SECRET|API_KEY|PASSWORD/i.test(entry[0]),
      ),
    )
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      KILO_TEST_HOME: home,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      KILO_DB: path.join(home, "unused.db"),
      RAYA_DB: path.join(home, "unused.db"),
      KILO_AUTH_CONTENT: "{}",
      RAYA_AUTH_CONTENT: "{}",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_DEFAULT_PLUGINS: "1",
      KILO_VSCODE: "1",
    })
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/profile-directory-alias.ts"),
        root,
      ],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const state = { forced: false }
    const timer = setTimeout(() => {
      state.forced = true
      child.kill()
    }, 45000)
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await writeFile(path.join(root, "stdout.log"), out)
      await writeFile(path.join(root, "stderr.log"), err)
      assert.equal(code, 0, `Private diagnostics retained at ${root}`)
      expect(state.forced).toBe(false)
      expect(out).toContain("ALIAS_RESTORE_PASSED")
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        state.forced = true
        child.kill()
        await child.exited
      }
    }
  },
  60000,
)
test("directory alias conflicts refuse distinct metadata and unrelated physical mappings", () => {
  const columns = ["project_id", "directory", "type", "strategy", "time_created"]
  const table = {
    table: "project_directory",
    columns,
    rows: [
      ["project", "C:/source", "main", null, 20],
      ["project", "c:\\SOURCE", "main", null, 10],
    ],
  }
  const map = new Map([["C:/source", "D:/target"]])
  expect(remap([table], map)[0].rows).toEqual([["project", path.join("D:/target"), "main", null, 10]])
  for (const [index, value] of [
    [2, "git_worktree"],
    [3, "different"],
    [4, -1],
  ] as const) {
    const changed = structuredClone(table)
    changed.rows[1][index] = value
    expect(() => remap([changed], map)).toThrow()
  }
  const foreign = {
    ...table,
    rows: [
      ["project", "C:/source", "main", null, 10],
      ["project", "C:/other", "main", null, 10],
    ],
  }
  expect(() =>
    remap(
      [foreign],
      new Map([
        ["C:/source", "D:/target"],
        ["C:/other", "D:/target"],
      ]),
    ),
  ).toThrow()
  const unknown = {
    ...table,
    columns: [...columns, "extra"],
    rows: table.rows.map((row, index) => [...row, String(index)]),
  }
  expect(() => remap([unknown], map)).toThrow()
})
