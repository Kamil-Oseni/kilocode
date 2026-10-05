import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { sanitize } from "@opencode-ai/core/kilocode/profile-preferences"
import { project } from "../../src/kilo-provider/host-projection"

test("capsule projection keeps safe per-generation choices and omits unrelated host state", () => {
  const id = randomUUID()
  const root = path.resolve("synthetic-model.json")
  const safe = sanitize(
    {},
    {
      modelState: { model: { auto: { providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" } } },
      extensionState: { favoriteModels: [{ providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" }] },
      credentials: { synthetic: "never-export-this" },
    },
  )
  const result = project([
    {
      generation: randomUUID(),
      role: "view",
      payload: {
        revision: 2,
        models: [{ generation: id, revision: 3, roots: [{ kind: "json", path: root }], preferences: safe }],
        preferences: { preferences: safe },
        pane: { command: "never-export-this" },
      },
    },
  ])
  expect(result.hosts[0]!.owners[0]).toMatchObject({ id, revision: 3, root: { kind: "json", path: root } })
  expect(result.hosts[0]!.owners[0]!.models!.agents[0]!.agent).toBe("auto")
  expect(result.hosts[0]!.models.favorite).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain("never-export-this")
  expect(Object.isFrozen(result.hosts[0]!.owners[0]!.models!.agents)).toBeTrue()
})

test("cold contexts have no invented admission root and capsule bounds refuse without truncating", () => {
  const id = randomUUID()
  const row = {
    generation: randomUUID(),
    role: "agent-manager" as const,
    payload: [{ id: "project", generation: id, root: path.resolve("synthetic-cold") }],
  }
  const result = project([row])
  expect(result.hosts[0]!.contexts[0]!.id).toBe(id)
  expect(result.hosts[0]!.contexts[0]!.root).toBeUndefined()
  expect(() => project(Array.from({ length: 65 }, () => ({ ...row, generation: randomUUID() })))).toThrow()
})
