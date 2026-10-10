import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises"
import { prepare } from "../../src/kilocode/source-profile"
import { covers } from "../../src/kilocode/source-policy"

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-source-config-policy-")))
  const home = path.join(root, "home")
  const account = path.join(root, "account")
  const legacy = path.join(root, "legacy")
  const cwd = path.join(root, "workspace")
  await Promise.all([home, account, legacy, cwd].map((file) => mkdir(file)))
  return { root, home, account, cwd, env: { KILO_TEST_HOME: legacy } }
}

test("native account lock boundary is independent of logical and compatibility homes without creating paths", async () => {
  const input = await fixture()
  const before = await readdir(input.account)
  const value = await prepare(input)
  expect(await readdir(input.account)).toEqual(before)
  expect(covers(value.policy, path.join(input.account, ".raya-config-rmw-locks", "original.lock"))).toBe(true)
  for (const file of [
    input.account,
    path.join(input.account, "private.txt"),
    path.join(input.account, ".raya-config-rmw-locks-other", "original.lock"),
    path.join(input.home, ".raya-config-rmw-locks"),
    path.join(input.env.KILO_TEST_HOME, ".raya-config-rmw-locks"),
  ])
    expect(covers(value.policy, file)).toBe(false)
  expect(value.policy.directories.length + value.policy.files.length).toBeLessThanOrEqual(128)
})

test("default account boundary uses actual userInfo, without enumerating or creating account contents", async () => {
  const input = await fixture()
  const value = await prepare({ home: input.home, cwd: input.cwd, env: input.env })
  const account = await realpath(os.userInfo().homedir)
  expect(covers(value.policy, path.join(account, ".raya-config-rmw-locks", "original.lock"))).toBe(true)
  expect(covers(value.policy, path.join(account, "private-unselected.json"))).toBe(false)
  expect(await readdir(input.account)).toEqual([])
})

test("occupied lock boundary refuses instead of admitting it as a credential file", async () => {
  const input = await fixture()
  const locks = path.join(input.account, ".raya-config-rmw-locks")
  await writeFile(locks, "original occupied boundary")
  const err = await prepare(input).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(err).toBeInstanceOf(Error)
  if (!(err instanceof Error)) throw new Error("Occupied lock directory did not refuse")
  expect(err.message).toContain("directory is occupied by a file")
  expect(await Bun.file(locks).text()).toBe("original occupied boundary")
})

test("physical account alias admits canonical exact locks, while redirected lock directory refuses", async () => {
  const input = await fixture()
  const alias = path.join(input.root, "alias")
  await symlink(input.account, alias, process.platform === "win32" ? "junction" : "dir")
  const value = await prepare({ ...input, account: alias })
  expect(covers(value.policy, path.join(input.account, ".raya-config-rmw-locks", "original.lock"))).toBe(true)
  expect(covers(value.policy, path.join(alias, ".raya-config-rmw-locks", "original.lock"))).toBe(false)
  await symlink(
    input.root,
    path.join(input.account, ".raya-config-rmw-locks"),
    process.platform === "win32" ? "junction" : "dir",
  )
  const err = await prepare(input).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(err).toBeInstanceOf(Error)
  if (!(err instanceof Error)) throw new Error("Redirected lock directory did not refuse")
  expect(err.message).toContain("lock directory changed its exact boundary")
})
