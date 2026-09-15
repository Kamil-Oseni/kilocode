import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SandboxPreference } from "@/kilocode/sandbox/preference"
import { SandboxStore } from "@/kilocode/sandbox/store"
import { SessionID } from "@/session/schema"
import { tmpdir } from "../../fixture/fixture"

test("sandbox state operations follow the active profile generation", async () => {
  await using tmp = await tmpdir()
  const original = Global.Path.state
  const first = path.join(tmp.path, "first")
  const second = path.join(tmp.path, "second")
  const directory = path.join(tmp.path, "project")
  const id = SessionID.make("ses_sandbox_path_late_binding")
  const enabled: SandboxStore.Snapshot = {
    enabled: true,
    mode: "deny",
    allowedHosts: [],
    writablePaths: [],
    version: 1,
  }
  await Promise.all([fs.mkdir(first), fs.mkdir(second)])

  try {
    Global.Path.state = path.join(first, "kilo")
    await SandboxPreference.write(directory, true)
    await SandboxStore.write(directory, id, enabled)

    Global.Path.state = path.join(second, "kilo")
    expect(await SandboxPreference.read(directory)).toBeUndefined()
    expect(await SandboxStore.read(directory, id)).toBeUndefined()
    await SandboxPreference.write(directory, false)
    await SandboxStore.write(directory, id, { ...enabled, enabled: false, version: 2 })

    Global.Path.state = path.join(first, "kilo")
    expect(await SandboxPreference.read(directory)).toBe(true)
    expect(await SandboxStore.read(directory, id)).toEqual(enabled)

    Global.Path.state = path.join(second, "kilo")
    expect(await SandboxPreference.read(directory)).toBe(false)
    expect(await SandboxStore.read(directory, id)).toEqual({ ...enabled, enabled: false, version: 2 })

    const removeID = SessionID.make("ses_sandbox_path_remove")
    Global.Path.state = path.join(first, "kilo")
    const before = new Set(await fs.readdir(SandboxStore.root()))
    await SandboxStore.write(directory, removeID, enabled)
    const folder = (await fs.readdir(SandboxStore.root())).find((name) => !before.has(name))
    if (!folder) throw new Error("sandbox remove fixture was not created")

    Global.Path.state = path.join(second, "kilo")
    const canary = path.join(SandboxStore.root(), folder)
    await fs.mkdir(canary, { recursive: true })

    Global.Path.state = path.join(first, "kilo")
    const removing = SandboxStore.remove(directory, removeID)
    Global.Path.state = path.join(second, "kilo")
    await removing
    expect(await fs.stat(canary).then((value) => value.isDirectory())).toBe(true)

    Global.Path.state = path.join(first, "kilo")
    expect(await fs.stat(path.join(SandboxStore.root(), folder)).catch(() => undefined)).toBeUndefined()
  } finally {
    Global.Path.state = original
  }
})
