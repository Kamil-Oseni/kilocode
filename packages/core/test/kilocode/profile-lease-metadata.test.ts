import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireProfileRoot } from "../../src/kilocode/profile-maintenance"

test("writer lease retains its actual admitted root when a supplied alias is later rebound", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-lease-metadata-")))
  const first = path.join(root, "first")
  const next = path.join(root, "next")
  const alias = path.join(root, "alias")
  await Promise.all([mkdir(first), mkdir(next)])
  await symlink(first, alias, process.platform === "win32" ? "junction" : "dir")
  const lease = await acquireProfileRoot({ kind: "json", path: path.join(alias, "model.json") })
  try {
    expect(lease.root).toEqual({ kind: "json", path: path.join(first, "model.json") })
    expect(Object.isFrozen(lease.root)).toBe(true)
    await unlink(alias)
    await symlink(next, alias, process.platform === "win32" ? "junction" : "dir")
    expect(lease.root.path).toBe(path.join(first, "model.json"))
    const current = await acquireProfileRoot({ kind: "json", path: path.join(alias, "model.json") })
    try {
      expect(current.root.path).toBe(path.join(next, "model.json"))
      expect(current.id).not.toBe(lease.id)
    } finally {
      await current.release()
    }
  } finally {
    await lease.release()
  }
})
