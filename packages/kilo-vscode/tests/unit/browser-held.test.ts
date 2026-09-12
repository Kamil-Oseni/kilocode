import { expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { held, same } from "../../src/services/browser-automation/browser-held"
import { profile } from "../../src/services/browser-automation/browser-profile"

function recase(value: string) {
  if (process.platform !== "win32") return value
  return value.replace(/^([A-Za-z]):/, (_, letter: string) =>
    letter === letter.toUpperCase() ? `${letter.toLowerCase()}:` : `${letter.toUpperCase()}:`,
  )
}

test("same folds case on win32 and darwin and matches exactly on linux", () => {
  expect(same("/x/Y", "/x/y")).toBe(process.platform !== "linux")
  expect(same("/x/y", "/x/y")).toBe(true)
  expect(same("/x/y", "/x/z")).toBe(false)
})

test("same treats Windows drive-letter and long-path prefixes as one identity", () => {
  if (process.platform !== "win32") return
  expect(same("C:\\Users\\User\\AppData", "c:\\Users\\User\\AppData")).toBe(true)
  expect(same("C:\\Users\\User\\AppData", "C:\\Users\\USER\\AppData")).toBe(true)
  expect(same("\\\\?\\C:\\Users\\User", "C:\\Users\\User")).toBe(true)
})

test("held accepts a recased existing directory", async () => {
  if (process.platform !== "win32") return
  const home = await mkdtemp(join(tmpdir(), "raya-held-"))
  try {
    const root = join(home, "profiles")
    await mkdir(root)
    expect(await held(recase(root))).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("profile accepts a recased storage root", async () => {
  if (process.platform !== "win32") return
  const home = await mkdtemp(join(tmpdir(), "raya-held-profile-"))
  try {
    const result = await profile(recase(join(home, "profiles")), home)
    expect(result.owner.directory).toBeTruthy()
    expect(result.path.includes(result.owner.profileID)).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("profile refuses a redirected storage root", async () => {
  const home = await mkdtemp(join(tmpdir(), "raya-held-link-"))
  const real = join(home, "real")
  const alias = join(home, "alias")
  await mkdir(real)
  symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir")
  try {
    expect(await held(alias)).toBe(false)
    await expect(profile(alias, home)).rejects.toThrow(/identity changed/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
