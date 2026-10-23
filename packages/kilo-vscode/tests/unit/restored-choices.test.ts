import { expect, test } from "bun:test"
import { Application, Snapshot } from "../../src/shared/restore-review"
import { confirmed, issues, project } from "../../src/shared/restored-choices"

const pick = { providerID: "local", modelID: "good" }
const old = { providerID: "offline", modelID: "old" }
const host = "c83b05e8-a10e-4275-9272-d60da1de3c49"
const owner = "188d8585-1a68-4429-8c31-c430362a6ade"
const preferences = {
  format: "raya.profile-preferences",
  version: 1,
  reviewOnly: true,
  activation: "held",
  config: { model: old, smallModel: old, defaultAgent: "general" },
  modelState: {
    models: [{ agent: "general", ...old }],
    recent: [old],
    favorite: [old],
    variants: [{ ...old, variant: "kept" }],
  },
  extensionState: { recentModels: [old], favoriteModels: [old], expanded: true },
} as const
function fixture() {
  return Snapshot.parse({
    id: crypto.randomUUID(),
    choices: {
      version: 1,
      state: "ready",
      revision: "a".repeat(64),
      sources: [
        {
          kind: "profile",
          preferences: {
            ...preferences,
            config: { model: pick },
            modelState: { models: [], recent: [old], favorite: [] },
            extensionState: { recentModels: [], favoriteModels: [], expanded: false },
          },
        },
        {
          kind: "host",
          id: host,
          role: "view",
          revision: 0,
          models: {
            selected: pick,
            recent: [],
            favorite: [],
            agents: [],
            variants: [{ ...pick, variant: "supported" }],
          },
          owners: [
            {
              id: owner,
              revision: 0,
              models: { recent: [old], favorite: [], agents: [{ agent: "general", ...pick }] },
            },
          ],
        },
      ],
    },
    destination: { version: 1, revision: "b".repeat(64), preferences },
    availability: { models: [{ ...pick, variants: ["supported"] }], agents: ["general"] },
  })
}
test("shared projection preserves optional absence and makes captured empty/false explicit", () => {
  const snapshot = fixture()
  const row = project(snapshot, { kind: "profile" }, "config")
  expect(row.patch).toEqual({ model: pick })
  expect(row.after).toEqual({ ...preferences.config, model: pick })
  expect(issues(snapshot, row)).toEqual([])
  const history = project(snapshot, { kind: "profile" }, "history")
  expect(history.patch).toEqual({ recent: [old], favorite: [] })
  expect(history.after).toEqual({ recent: [old], favorite: [], variants: preferences.modelState.variants })
  expect(issues(snapshot, history)).toEqual([])
  const client = project(snapshot, { kind: "profile" }, "client")
  expect(client.patch).toEqual({ recentModels: [], favoriteModels: [], expanded: false })
  expect(confirmed(client, snapshot.destination.preferences)).toBe(false)
  expect(
    confirmed(client, {
      ...snapshot.destination.preferences,
      extensionState: client.after as Snapshot["destination"]["preferences"]["extensionState"],
    }),
  ).toBe(true)
})
test("host owner is explicit and never inferred from top selected model", () => {
  const snapshot = fixture()
  expect(project(snapshot, { kind: "host", id: host }, "models").captured).toBe(false)
  expect(project(snapshot, { kind: "host", id: host }, "history").captured).toBe(false)
  expect(project(snapshot, { kind: "host", id: host }, "config").patch).toEqual({ model: pick })
  expect(project(snapshot, { kind: "host", id: host, owner }, "models").patch).toEqual({
    models: [{ agent: "general", ...pick }],
  })
  expect(project(snapshot, { kind: "host", id: host, owner: crypto.randomUUID() }, "client").captured).toBe(false)
  expect(
    Application.safeParse({
      id: snapshot.id,
      revision: "a".repeat(64),
      source: { kind: "host", id: host },
      expected: "b".repeat(64),
      groups: ["models"],
      reviewed: true,
    }).success,
  ).toBe(false)
})
test("explicit variants and active choices refuse unavailable values; historical IDs do not", () => {
  const snapshot = fixture()
  snapshot.availability.models = []
  expect(issues(snapshot, project(snapshot, { kind: "profile" }, "history"))).toEqual([])
  expect(issues(snapshot, project(snapshot, { kind: "profile" }, "config"))).toHaveLength(1)
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host }, "client"))).toHaveLength(1)
  snapshot.availability.models = [{ ...pick, variants: [] }]
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host }, "client"))[0]).toContain("Variant supported")
})
test("ambiguous mode maps are refused and readback requires captured values", () => {
  const snapshot = fixture()
  if (snapshot.choices.state !== "ready") throw new Error("ready fixture missing")
  const source = snapshot.choices.sources.find((item) => item.kind === "host")
  if (source?.kind !== "host" || !source.owners[0].models) throw new Error("host fixture missing")
  source.owners[0].models.agents.push({ agent: "general", ...old })
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host, owner }, "models"))[0]).toContain("ambiguous")
  const row = project(snapshot, { kind: "profile" }, "models")
  expect(confirmed(row, snapshot.destination.preferences)).toBe(false)
  expect(
    confirmed(row, {
      ...snapshot.destination.preferences,
      modelState: { ...snapshot.destination.preferences.modelState, models: [] },
    }),
  ).toBe(true)
})

test("scoped variants and explicit model default remain distinct and read back without map-order dependence", () => {
  const snapshot = fixture()
  if (snapshot.choices.state !== "ready") throw new Error("ready fixture missing")
  const source = snapshot.choices.sources.find((item) => item.kind === "host")
  if (source?.kind !== "host") throw new Error("host fixture missing")
  source.models.variants = [
    { ...pick, agent: "general", variant: "" },
    { ...pick, variant: "supported" },
  ]
  const parsed = Snapshot.parse(snapshot)
  const row = project(parsed, { kind: "host", id: host }, "client")
  expect(issues(parsed, row)).toEqual([])
  expect(row.patch).toMatchObject({
    variants: [
      { ...pick, agent: "general", variant: "" },
      { ...pick, variant: "supported" },
    ],
  })
  const target = structuredClone(parsed.destination.preferences)
  target.extensionState = {
    ...target.extensionState,
    recentModels: [],
    favoriteModels: [],
    variants: [
      { ...pick, variant: "supported" },
      { ...pick, agent: "general", variant: "" },
    ],
  }
  expect(confirmed(row, target)).toBe(true)
  target.extensionState.variants = [{ ...pick, variant: "supported" }]
  expect(confirmed(row, target)).toBe(false)
  parsed.availability.models[0].variants = []
  source.models.variants = [{ ...pick, agent: "general", variant: "" }]
  const defaults = project(snapshot, { kind: "host", id: host }, "client")
  expect(issues(parsed, defaults)).toEqual([])
  parsed.availability.agents = []
  expect(issues(parsed, defaults)[0]).toContain("Mode general")
  parsed.availability.models = []
  expect(issues(parsed, defaults)).toHaveLength(2)
})

test("duplicate variants are ambiguous only within the exact mode and model scope", () => {
  const snapshot = fixture()
  if (snapshot.choices.state !== "ready") throw new Error("ready fixture missing")
  const source = snapshot.choices.sources.find((item) => item.kind === "host")
  if (source?.kind !== "host") throw new Error("host fixture missing")
  source.models.variants = [
    { ...pick, agent: "general", variant: "" },
    { ...pick, agent: "general", variant: "supported" },
  ]
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host }, "client"))[0]).toContain("ambiguous")
})

test("CLI history refuses mode-scoped variants before writes while client defaults remain valid", () => {
  const snapshot = fixture()
  if (snapshot.choices.state !== "ready") throw new Error("ready fixture missing")
  const source = snapshot.choices.sources.find((item) => item.kind === "host")
  if (source?.kind !== "host" || !source.owners[0].models) throw new Error("host fixture missing")
  const scoped = { ...pick, agent: "general", variant: "" }
  source.owners[0].models.variants = [scoped]
  source.models.variants = [scoped]
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host, owner }, "history"))[0]).toContain(
    "cannot be applied to CLI model history",
  )
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host }, "client"))).toEqual([])
  source.owners[0].models.variants = [{ ...pick, variant: "" }]
  expect(issues(snapshot, project(snapshot, { kind: "host", id: host, owner }, "history"))).toEqual([])
})
