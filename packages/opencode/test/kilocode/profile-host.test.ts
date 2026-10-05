import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { held, host } from "../../src/kilocode/migration/profile-host"

test("held host choices retain historical safe evidence, never serialized native authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-held-host-"))
  const folder = path.join(root, "data")
  await mkdir(folder)
  const first = host.parse({
    format: "raya.host-capsule",
    version: 1,
    hosts: [
      {
        id: crypto.randomUUID(),
        role: "view",
        revision: 3,
        models: { selected: { providerID: "local", modelID: "qwen3:8b" }, recent: [], favorite: [], agents: [] },
        owners: [],
        contexts: [],
      },
    ],
  })
  expect(await held(folder)).toBeUndefined()
  await writeFile(path.join(folder, "restore-host.json"), JSON.stringify(first))
  expect(await held(folder)).toEqual(first)
  const current = structuredClone(first)
  current.hosts[0].revision = 4
  expect((await held(folder, current))!.hosts).toEqual(current.hosts)
  current.hosts[0].id = crypto.randomUUID()
  expect((await held(folder, current))!.hosts).toHaveLength(2)
  expect(host.safeParse({ ...first, complete: true }).success).toBe(false)
  expect(host.safeParse({ ...first, hosts: [{ ...first.hosts[0], apiKey: "excluded" }] }).success).toBe(false)
  await link(path.join(folder, "restore-host.json"), path.join(root, "alias.json"))
  await assert.rejects(held(folder), /unique/)
})
