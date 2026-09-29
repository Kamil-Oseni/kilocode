import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserAuth } from "../../src/services/browser-automation/browser-auth"
import { profile } from "../../src/services/browser-automation/browser-profile"

test("workspace authentication captures have independent identities, expiry, and effective deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-auth-store-"))
  try {
    const workspace = await profile(join(dir, "profiles"), dir)
    const other = await profile(join(dir, "profiles"), join(dir, "profiles"))
    expect(workspace.owner.profileID).not.toBe(other.owner.profileID)
    expect((await profile(join(dir, "profiles"), dir)).owner).toEqual(workspace.owner)
    const auth = new BrowserAuth(join(workspace.path, "auth"), workspace.owner)
    const state = { cookies: [{ name: "login", value: "private-session-value", domain: ".example.test" }], origins: [] }
    const first = await auth.capture("app/a", state)
    const second = await auth.capture("app a", state)
    expect(first.id).not.toBe(second.id)
    expect(first.domains).toEqual([".example.test"])
    expect(JSON.stringify(first)).not.toContain("private-session-value")
    expect((await auth.read(first.id)).state).toEqual(state)
    const foreign = new BrowserAuth(join(workspace.path, "auth"), other.owner)
    await expect(foreign.read(first.id)).rejects.toThrow("another workspace")
    const receipt = join(workspace.path, "auth", `${first.id}.json`)
    await writeFile(receipt, JSON.stringify({ ...first, expiresAt: 1 }))
    await expect(auth.read(first.id)).rejects.toThrow("expired")
    expect(await Bun.file(join(workspace.path, "auth", `${first.id}.state`)).exists()).toBe(false)
    expect((await auth.list()).find((info) => info.id === first.id)?.status).toBe("expired")
    await auth.delete(first.id)
    await expect(auth.read(first.id)).rejects.toThrow()

    const bytes = join(workspace.path, "auth", `${second.id}.state`)
    const original = await readFile(bytes)
    await writeFile(bytes, Buffer.alloc(original.length, "x"))
    await expect(auth.read(second.id)).rejects.toThrow("digest")
    await writeFile(join(workspace.path, "auth", `${second.id}.json`), "invalid receipt")
    expect((await auth.list())[0].status).toBe("invalid")
    await auth.clear()
    expect(await auth.list()).toEqual([])
    expect(await Bun.file(bytes).exists()).toBe(false)
    await expect(auth.read("../../outside")).rejects.toThrow("identity")
    expect(createHash("sha256").update(original).digest("hex")).toBe(second.sha256)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("revocation before authentication deletion preserves the exact saved capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-auth-guarded-"))
  try {
    const workspace = await profile(join(dir, "profiles"), dir)
    const auth = new BrowserAuth(join(workspace.path, "auth"), workspace.owner)
    const saved = await auth.capture("Guarded capture", {
      cookies: [{ name: "session", value: "guarded-value", domain: ".example.test" }],
      origins: [],
    })
    const state = join(workspace.path, "auth", `${saved.id}.state`)
    const receipt = join(workspace.path, "auth", `${saved.id}.json`)
    const before = await Promise.all([readFile(state), readFile(receipt)])

    await expect(
      auth.delete(saved.id, () => {
        throw new Error("Computer Use grant was revoked")
      }),
    ).rejects.toThrow("grant was revoked")

    expect(await readFile(state)).toEqual(before[0])
    expect(await readFile(receipt)).toEqual(before[1])
    expect((await auth.read(saved.id)).info.id).toBe(saved.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("revocation after authentication bytes are removed retains the exact receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-auth-partial-"))
  try {
    const workspace = await profile(join(dir, "profiles"), dir)
    const auth = new BrowserAuth(join(workspace.path, "auth"), workspace.owner)
    const saved = await auth.capture("Partial deletion", {
      cookies: [{ name: "session", value: "partial-value", domain: ".example.test" }],
      origins: [],
    })
    const state = join(workspace.path, "auth", `${saved.id}.state`)
    const receipt = join(workspace.path, "auth", `${saved.id}.json`)
    const before = await readFile(receipt)
    let checks = 0

    await expect(
      auth.delete(saved.id, () => {
        checks++
        if (checks === 2) throw new Error("Computer Use grant was revoked")
      }),
    ).rejects.toThrow("grant was revoked")

    expect(checks).toBe(2)
    expect(await Bun.file(state).exists()).toBe(false)
    expect(await readFile(receipt)).toEqual(before)
    expect((await auth.list()).find((info) => info.id === saved.id)?.status).toBe("missing")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
