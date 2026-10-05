import { test, expect } from "bun:test"
import { mkdtemp, mkdir, readdir, writeFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepare } from "../../src/kilocode/source-profile"
import { covers } from "../../src/kilocode/source-policy"

test("producer plans configured profile boundaries without creating source directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-profile-"))
  const home = path.join(root, "home")
  const cwd = path.join(root, "workspace")
  await mkdir(home)
  await mkdir(cwd)
  const env = {
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    KILO_TEST_HOME: home,
    RAYA_DB: path.join(root, "database/raya.db"),
    KILO_CONFIG_DIR: path.join(root, "extra-config"),
  }
  const before = await readdir(root)
  const value = await prepare({ home, cwd, env })
  expect(await readdir(root)).toEqual(before)
  for (const file of [
    path.join(env.XDG_DATA_HOME, "kilo/storage/state.json"),
    path.join(env.XDG_STATE_HOME, "kilo/raya/goal.json"),
    env.RAYA_DB,
    path.join(home, ".kilocode/settings.json"),
    path.join(env.KILO_CONFIG_DIR, "commands/example.md"),
  ])
    expect(covers(value.policy, file)).toBe(true)
  expect(covers(value.policy, path.join(root, "unapproved/other.db"))).toBe(false)
  expect(covers(value.policy, path.join(root, "database-other/raya.db"))).toBe(false)
  expect(value.roots).toHaveLength(1)
  expect(value.roots[0].kind).toBe("json")
  expect(covers(value.policy, value.roots[0].path)).toBe(true)
  expect(Object.isFrozen(value.policy)).toBe(true)
})

test("producer preserves a blocked default state ancestor as exact file without granting descendants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-profile-state-"))
  const home = path.join(root, "home")
  const cwd = path.join(root, "workspace")
  await mkdir(cwd)
  await mkdir(path.join(home, ".local"), { recursive: true })
  const file = path.join(home, ".local/state")
  await writeFile(file, "Existing immutable state ancestor")
  const value = await prepare({ home, cwd, env: {} })
  expect(covers(value.policy, await realpath(file))).toBe(true)
  expect(covers(value.policy, path.join(file, "kilo/state.json"))).toBe(false)
  expect(covers(value.policy, path.join(home, ".local/share/kilo/state/file.json"))).toBe(true)
  expect(await Bun.file(file).text()).toBe("Existing immutable state ancestor")
})

test("producer refuses relative configured namespaces before realizing paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-profile-relative-"))
  const failure = await prepare({ home: root, cwd: root, env: { XDG_DATA_HOME: "relative" } }).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(await readdir(root)).toEqual([])
})
