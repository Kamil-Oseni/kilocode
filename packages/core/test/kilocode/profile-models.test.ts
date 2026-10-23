import { expect, test } from "bun:test"
import { sanitize } from "../../src/kilocode/profile-preferences"
import { project, read } from "../../src/kilocode/profile-models"

test("actual CLI writer shape and loaded safe state produce the same bounded model evidence", () => {
  const raw = {
    model: {
      auto: { providerID: "local", modelID: "general" },
      ask: { providerID: "local", modelID: "ask" },
      code: { providerID: "local", modelID: "code" },
    },
    recent: [{ providerID: "local", modelID: "ask" }],
    favorite: [{ providerID: "local", modelID: "code" }],
    variant: { "local/ask": "", "local/code": "high" },
    unrelated: "private-not-a-portable-field",
  }
  const loaded = project(sanitize({}, { modelState: raw }).modelState)
  expect(read(raw)).toEqual(loaded)
  expect(loaded.agents).toEqual([
    { agent: "ask", providerID: "local", modelID: "ask" },
    { agent: "auto", providerID: "local", modelID: "general" },
    { agent: "code", providerID: "local", modelID: "code" },
  ])
  expect(loaded.variants).toEqual([
    { providerID: "local", modelID: "ask", variant: "" },
    { providerID: "local", modelID: "code", variant: "high" },
  ])
  expect(JSON.stringify(loaded)).not.toContain(raw.unrelated)
})

test("projected host JSON cannot substitute for a CLI model file, including empty projected choices", () => {
  expect(() => read({ recent: [], favorite: [], agents: [] })).toThrow("not a CLI")
  expect(() =>
    read({ model: {}, recent: [], favorite: [], selected: { providerID: "local", modelID: "other" } }),
  ).toThrow("not a CLI")
  expect(() => read({ model: { ask: { providerID: "local", modelID: "../../unsafe" } } })).toThrow()
  expect(() => read({ model: [], recent: [], favorite: [] })).toThrow()
})
