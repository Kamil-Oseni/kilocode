import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { selection } from "../../src/second-brain/dream-selection"
import { BrainSettings } from "../../src/second-brain/settings"
import { sources } from "../../src/second-brain/setup-v2"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-selection-"))
  const file = path.join(root, "settings.json")
  const credentials = path.join(root, "synthetic-credentials.json")
  await writeFile(file, "{}")
  await writeFile(credentials, "{}")
  const settings = new BrainSettings(
    {
      get<T>(name: string) {
        return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
      },
      async update(name, value) {
        const current = JSON.parse(await readFile(file, "utf8"))
        current[name] = value
        await writeFile(file, JSON.stringify(current))
      },
    },
    {
      async get(name) {
        return JSON.parse(await readFile(credentials, "utf8"))[name]
      },
      async store(name, value) {
        const current = JSON.parse(await readFile(credentials, "utf8"))
        current[name] = value
        await writeFile(credentials, JSON.stringify(current))
      },
      async delete(name) {
        const current = JSON.parse(await readFile(credentials, "utf8"))
        delete current[name]
        await writeFile(credentials, JSON.stringify(current))
      },
    },
  )
  const setup = {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    origin: "http://127.0.0.1:8874",
    root: path.join(root, "configured-notes"),
    source_sha256: Object.fromEntries(sources.map((name) => [name, "a".repeat(64)])),
  }
  await settings.save(setup, "synthetic-private")
  const approved = {
    scope: "971da465-70aa-4e29-baad-272aaf840354",
    sources: [{ path: "approved.md", sha256: "b".repeat(64), kind: "approved-summary" as const }],
    targets: [{ key: "voice", path: "Preferences/voice.md", expected: null }],
  }
  return { root, file, settings, setup, approved }
}

const check = process.platform === "win32" ? test : test.skip
check("manual grant binds original configured root, selection, trust and credential revision", async () => {
  const f = await fixture()
  let trusted = true
  const signal = new AbortController().signal
  const grant = await selection(
    {
      settings: f.settings,
      project: f.root,
      approved: f.approved,
      trusted: (project) => trusted && project === f.root,
      review: async (value) => {
        expect(value.root).toBe(f.setup.root)
        expect(value.project).toBe(f.root)
        expect(value.approved).toEqual(f.approved)
        return true
      },
    },
    signal,
  )
  await grant.authorize(grant.root, grant.project, grant.approved, signal)
  for (const [root, project, approved] of [
    [f.root, grant.project, grant.approved],
    [grant.root, f.setup.root, grant.approved],
    [grant.root, grant.project, { ...grant.approved, scope: crypto.randomUUID() }],
  ] as const)
    await expect(grant.authorize(root, project, approved, signal)).rejects.toThrow("no longer authorized")
  trusted = false
  await expect(grant.authorize(grant.root, grant.project, grant.approved, signal)).rejects.toThrow(
    "no longer authorized",
  )
  trusted = true
  await f.settings.save(f.setup, "synthetic-replacement")
  await expect(grant.authorize(grant.root, grant.project, grant.approved, signal)).rejects.toThrow(
    "no longer authorized",
  )
  expect(await readFile(f.file, "utf8")).not.toContain("synthetic-replacement")
})

check("refused, changed, cancelled and closed selections cannot mint or retain authorization", async () => {
  const f = await fixture()
  const cfg = {
    settings: f.settings,
    project: f.root,
    approved: f.approved,
    trusted: () => true,
    review: async () => false,
  }
  await expect(selection(cfg, new AbortController().signal)).rejects.toThrow("not approved")
  await expect(
    selection(
      {
        ...cfg,
        review: async () => {
          await f.settings.save({ ...f.setup, root: path.join(f.root, "replacement") }, "synthetic-changed")
          return true
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("changed during review")
  const controller = new AbortController()
  const grant = await selection({ ...cfg, review: async () => true }, controller.signal)
  grant.close()
  await expect(grant.authorize(grant.root, grant.project, grant.approved, controller.signal)).rejects.toThrow(
    "no longer authorized",
  )
  controller.abort(new Error("Manual selection cancelled"))
  await expect(selection(cfg, controller.signal)).rejects.toThrow("selection cancelled")
})
