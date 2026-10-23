import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { sanitize } from "@opencode-ai/core/kilocode/profile-preferences"
import { Snapshot, type Application, type Outcome } from "../../src/shared/restore-review"
import { restoreChoices } from "../../src/kilo-provider/restore-choices"
import { writer, retire } from "../../src/kilo-provider/model-state-writer"
import { hostPublications } from "../../src/kilo-provider/host-publications"
import { KiloProvider } from "../../src/KiloProvider"

type Result = {
  type?: string
  snapshot?: Snapshot
  outcome?: Outcome
  error?: string
  variants?: Record<string, string>
  replace?: boolean
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-restore-choices-"))
  const state = path.join(root, "state")
  await mkdir(state)
  const file = path.join(state, "model.json")
  await writeFile(
    file,
    JSON.stringify({
      model: { ask: { providerID: "local", modelID: "old" } },
      recent: [],
      favorite: [],
      retained: "unrelated",
    }),
  )
  const preferences = sanitize(
    { model: "local/new", small_model: "local/new", default_agent: "ask" },
    {
      modelState: {
        model: { ask: { providerID: "local", modelID: "new" } },
        recent: [],
        favorite: [{ providerID: "missing", modelID: "history" }],
        variant: { "local/new": "" },
      },
      extensionState: {
        recentModels: [],
        favoriteModels: [{ providerID: "missing", modelID: "history" }],
        variantSelections: { "agent/ask/local/new": "", "local/new": "high" },
        modelSelectorExpanded: false,
      },
    },
  )
  const saved = {
    state: "held",
    id: randomUUID(),
    revision: "b".repeat(64),
    reconnectCredentials: true,
    uncertainWork: "held-no-replay",
    workspaces: [],
    workers: [],
    choices: { version: 1, state: "ready", revision: "c".repeat(64), sources: [{ kind: "profile", preferences }] },
  }
  const data = new Map<string, unknown>([
    ["recentModels", [{ providerID: "local", modelID: "old" }]],
    ["favoriteModels", []],
    ["modelSelectorExpanded", true],
    ["unrelated", "preserved"],
  ])
  const selected = {
    config: { model: "local/old", unrelated: "preserved" },
    patches: [] as unknown[],
    updates: [] as string[],
    current: true,
    lost: false,
    fail: "",
    unavailable: false,
    disable: false,
    reviews: 0,
    rotate: "",
    drift: false,
  }
  const gate = {
    review: undefined as ReturnType<typeof Promise.withResolvers<void>> | undefined,
    entered: Promise.withResolvers<void>(),
  }
  const context = {
    globalState: {
      get: (key: string) => data.get(key),
      update(key: string, value: unknown) {
        const task = Promise.resolve().then(() => {
          selected.updates.push(key)
          data.set(key, structuredClone(value))
          if (selected.drift && key === "modelSelectorExpanded") selected.config.model = "local/old"
          if (selected.fail === key) throw new Error("Original Memento commit response lost")
        })
        return { then: task.then.bind(task) }
      },
    },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/path")
        return Response.json({ state, home: root, config: root, data: root, worktree: root })
      if (url.pathname === "/global/config") {
        if (request.method === "PATCH") {
          const patch = await request.json()
          selected.patches.push(patch)
          selected.config = { ...selected.config, ...patch }
          if (selected.disable) selected.unavailable = true
          if (selected.rotate === "hold") saved.id = randomUUID()
          if (selected.rotate === "choices") saved.choices.revision = "d".repeat(64)
          if (selected.lost) return Response.json({ error: "Original committed config response lost" }, { status: 500 })
        }
        return Response.json(selected.config)
      }
      if (url.pathname === "/provider")
        return Response.json({
          all: [
            { id: "local", models: { old: { id: "old", variants: {} }, new: { id: "new", variants: { high: {} } } } },
          ],
          connected: selected.unavailable ? [] : ["local"],
          failed: [],
          default: {},
        })
      if (url.pathname === "/agent")
        return Response.json([{ name: "ask", mode: "primary", options: {}, permission: [] }])
      if (url.pathname === "/kilocode/profile/restore-review") {
        selected.reviews++
        gate.entered.resolve()
        await gate.review?.promise
        return Response.json(saved)
      }
      return Response.json({ error: `Unexpected fixture route ${url.pathname}` }, { status: 404 })
    },
  })
  const client = createKiloClient({ baseUrl: server.url.origin })
  const results: Result[] = []
  const call = async (message: { type: string } & Record<string, unknown>) => {
    await restoreChoices({
      message: { requestID: randomUUID(), ...message },
      client,
      directory: root,
      context,
      current: () => selected.current,
      source: () => true,
      post: (value) => results.push(value as Result),
    })
    return results.at(-1)
  }
  const get = async () => Snapshot.parse((await call({ type: "restoreChoicesGet" }))?.snapshot)
  const apply = async (snapshot: Snapshot, groups: Application["groups"]) =>
    call({
      type: "restoreChoicesApply",
      application: {
        id: snapshot.id,
        revision: saved.choices.revision,
        source: { kind: "profile" },
        expected: snapshot.destination.revision,
        groups,
        reviewed: true,
      },
    })
  const close = async () => {
    gate.review?.resolve()
    await Promise.allSettled([retire(client), hostPublications(context)?.retire()])
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
  return {
    root,
    file,
    client,
    url: server.url.origin,
    context,
    selected,
    data,
    saved,
    gate,
    results,
    call,
    get,
    apply,
    close,
  }
}

test("explicit reviewed groups use actual SDK, locked model.json and native Thenables without copying unrelated keys", async () => {
  const state = await fixture()
  try {
    const snapshot = await state.get()
    if (snapshot.choices.state !== "ready") throw new Error("Expected original saved choices")
    const profile = snapshot.choices.sources.find((row) => row.kind === "profile")
    if (profile?.kind !== "profile") throw new Error("Expected original profile choices")
    expect(profile.preferences.modelState.variants).toEqual([{ providerID: "local", modelID: "new", variant: "" }])
    expect(profile.preferences.extensionState.variants).toEqual([
      { providerID: "local", modelID: "new", variant: "", agent: "ask" },
      { providerID: "local", modelID: "new", variant: "high" },
    ])
    const result = await state.apply(snapshot, ["config", "models", "history", "client"])
    expect(result?.outcome).toEqual({ state: "applied", confirmed: ["config", "models", "history", "client"] })
    expect(state.selected.patches).toEqual([{ model: "local/new", small_model: "local/new", default_agent: "ask" }])
    expect(state.selected.config.unrelated).toBe("preserved")
    const model = JSON.parse(await readFile(state.file, "utf8"))
    expect(model.model).toEqual({ ask: { providerID: "local", modelID: "new" } })
    expect(model.favorite).toEqual([{ providerID: "missing", modelID: "history" }])
    expect(model.retained).toBe("unrelated")
    expect(model.variant).toEqual({ "local/new": "" })
    expect(state.data.get("recentModels")).toEqual([])
    expect(state.data.get("modelSelectorExpanded")).toBe(false)
    expect(state.data.get("variantSelections")).toEqual({ "agent/ask/local/new": "", "local/new": "high" })
    expect(state.data.get("unrelated")).toBe("preserved")
    expect(state.saved.state).toBe("held")
    expect(state.results.map((row) => row.type)).toEqual([
      "restoreChoicesResult",
      "modelSelectionsLoaded",
      "recentsLoaded",
      "favoritesLoaded",
      "variantsLoaded",
      "modelSelectorExpandedLoaded",
      "restoreChoicesResult",
    ])
    expect(state.results.find((row) => row.type === "variantsLoaded")).toEqual({
      type: "variantsLoaded",
      variants: { "agent/ask/local/new": "", "local/new": "high" },
      replace: true,
    })
  } finally {
    await state.close()
  }
})

test("changed destination and unavailable active picks are known no-write refusals with successful later capture", async () => {
  const state = await fixture()
  try {
    const snapshot = await state.get()
    const before = await readFile(state.file, "utf8")
    state.data.set("recentModels", [{ providerID: "local", modelID: "new" }])
    expect((await state.apply(snapshot, ["models"]))?.error).toBeDefined()
    state.selected.unavailable = true
    const refreshed = await state.get()
    expect((await state.apply(refreshed, ["config", "models"]))?.error).toBeDefined()
    expect(state.selected.patches).toEqual([])
    expect(state.selected.updates).toEqual([])
    expect(await readFile(state.file, "utf8")).toBe(before)
    expect((await writer(state.client, () => true).captureSnapshot()).preferences?.modelState.models[0]?.modelID).toBe(
      "old",
    )
    expect(
      (await hostPublications(state.context)!.captureSnapshot()).preferences.extensionState.recentModels[0]?.modelID,
    ).toBe("new")
  } finally {
    await state.close()
  }
})

test("committed global PATCH with failed HTTP response reports unknown and never retries", async () => {
  const state = await fixture()
  try {
    const snapshot = await state.get()
    state.selected.lost = true
    const result = await state.apply(snapshot, ["config", "models"])
    expect(result?.outcome?.state).toBe("unknown")
    expect(result?.outcome?.confirmed).toEqual([])
    expect(result?.snapshot?.destination.preferences.config.model?.modelID).toBe("new")
    expect(state.selected.patches).toHaveLength(1)
    expect(state.selected.config.model).toBe("local/new")
    expect(JSON.parse(await readFile(state.file, "utf8")).model.ask.modelID).toBe("old")
    expect(state.selected.updates).toEqual([])
  } finally {
    await state.close()
  }
})

for (const group of ["config", "models"] as const)
  test(`a later committed Memento failure retains currently confirmed ${group} and remains sticky for capture`, async () => {
    const state = await fixture()
    try {
      const snapshot = await state.get()
      state.selected.fail = "favoriteModels"
      const result = await state.apply(snapshot, [group, "client"])
      expect(result?.outcome?.state).toBe("partial")
      expect(result?.outcome?.confirmed).toEqual([group])
      if (group === "models")
        expect(result?.snapshot?.destination.preferences.modelState.models[0]?.modelID).toBe("new")
      if (group === "config") expect(result?.snapshot?.destination.preferences.config.model?.modelID).toBe("new")
      expect(state.selected.updates).toEqual(["recentModels", "favoriteModels"])
      expect(state.data.get("favoriteModels")).toEqual([{ providerID: "missing", modelID: "history" }])
      await expect(hostPublications(state.context)!.captureSnapshot()).rejects.toThrow("publication failed")
    } finally {
      await state.close()
    }
  })

test("the last native Memento update cannot invalidate an earlier confirmed global choice and still report applied", async () => {
  const state = await fixture()
  try {
    const snapshot = await state.get()
    state.selected.drift = true
    const result = await state.apply(snapshot, ["config", "client"])
    expect(result?.outcome?.state).toBe("unknown")
    expect(result?.outcome?.confirmed).toEqual([])
    expect(result?.snapshot?.destination.preferences.config.model?.modelID).toBe("old")
    expect(state.data.get("modelSelectorExpanded")).toBe(false)
    expect(state.selected.patches).toHaveLength(1)
  } finally {
    await state.close()
  }
})

for (const groups of [["config"], ["config", "models"]] satisfies Application["groups"][])
  test(`a provider becoming unavailable during the final write cannot earn applied for ${groups.join("+")}`, async () => {
    const state = await fixture()
    try {
      const snapshot = await state.get()
      state.selected.disable = true
      const result = await state.apply(snapshot, groups)
      expect(result?.outcome?.state).toBe("unknown")
      expect(result?.outcome?.confirmed).toEqual([])
      expect(result?.snapshot?.availability.models).toEqual([])
      expect(state.selected.patches).toHaveLength(1)
      expect(JSON.parse(await readFile(state.file, "utf8")).model.ask.modelID).toBe("old")
    } finally {
      await state.close()
    }
  })

for (const rotate of ["hold", "choices"] as const)
  test(`a changed ${rotate} during the last write retains the commit as unknown instead of using the initial snapshot`, async () => {
    const state = await fixture()
    try {
      const snapshot = await state.get()
      state.selected.rotate = rotate
      const result = await state.apply(snapshot, ["config"])
      expect(result?.outcome?.state).toBe("unknown")
      expect(result?.outcome?.confirmed).toEqual([])
      expect(result?.error).toBeUndefined()
      expect(state.selected.config.model).toBe("local/new")
      expect(state.selected.patches).toHaveLength(1)
      expect(result?.snapshot?.id).toBe(state.saved.id)
      if (result?.snapshot?.choices.state !== "ready") throw new Error("Expected fresh captured choices")
      expect(result.snapshot.choices.revision).toBe(state.saved.choices.revision)
    } finally {
      await state.close()
    }
  })

for (const mode of ["unknown", "already-desired"] as const)
  test(`duplicate ${mode} application delivery cannot issue another read or write`, async () => {
    const state = await fixture()
    try {
      if (mode === "already-desired") {
        state.selected.config = {
          ...state.selected.config,
          model: "local/new",
          ...{ small_model: "local/new", default_agent: "ask" },
        }
      }
      const snapshot = await state.get()
      state.selected.lost = mode === "unknown"
      const message = {
        type: "restoreChoicesApply",
        requestID: randomUUID(),
        application: {
          id: snapshot.id,
          revision: state.saved.choices.revision,
          source: { kind: "profile" },
          expected: snapshot.destination.revision,
          groups: ["config"],
          reviewed: true,
        },
      }
      const result = await state.call(message)
      expect(result?.outcome?.state).toBe(mode === "unknown" ? "unknown" : "applied")
      const before = {
        results: state.results.length,
        reviews: state.selected.reviews,
        patches: state.selected.patches.length,
      }
      await state.call(message)
      expect({
        results: state.results.length,
        reviews: state.selected.reviews,
        patches: state.selected.patches.length,
      }).toEqual(before)
      expect(state.selected.patches).toHaveLength(mode === "unknown" ? 1 : 0)
    } finally {
      await state.close()
    }
  })

for (const control of ["renew", "client", "directory"] as const)
  test(`actual KiloProvider ${control} replacement withholds a held APPLY and a new page can use the same backend`, async () => {
    const state = await fixture()
    const selected = { client: state.client, directory: state.root }
    const posts: Result[] = []
    const view = {
      postMessage: async (message: unknown) => {
        posts.push(message as Result)
        return true
      },
    }
    const provider = new KiloProvider({} as never, { getClient: () => selected.client } as never, undefined, {
      rootDirectory: () => selected.directory,
    })
    type Owner = {
      extensionContext: typeof state.context
      connectionState: string
      isWebviewReady: boolean
      webview: typeof view
      renew: (view: typeof view) => void
      handleRoutineMessage: (message: Record<string, unknown>) => Promise<boolean>
    }
    const owner = provider as unknown as Owner
    owner.extensionContext = state.context
    owner.connectionState = "connected"
    owner.isWebviewReady = true
    owner.webview = view
    try {
      expect(await owner.handleRoutineMessage({ type: "restoreChoicesGet", requestID: randomUUID() })).toBe(true)
      const snapshot = Snapshot.parse(posts.at(-1)?.snapshot)
      state.gate.entered = Promise.withResolvers<void>()
      state.gate.review = Promise.withResolvers<void>()
      const pending = owner.handleRoutineMessage({
        type: "restoreChoicesApply",
        requestID: randomUUID(),
        application: {
          id: snapshot.id,
          revision: state.saved.choices.revision,
          source: { kind: "profile" },
          expected: snapshot.destination.revision,
          groups: ["models", "client"],
          reviewed: true,
        },
      })
      await state.gate.entered.promise
      if (control === "renew") owner.renew(view)
      if (control === "client") selected.client = createKiloClient({ baseUrl: state.url })
      if (control === "directory") selected.directory = path.join(state.root, "other")
      state.gate.review.resolve()
      expect(await pending).toBe(true)
      expect(posts).toHaveLength(1)
      expect(state.selected.updates).toEqual([])
      expect(state.selected.patches).toEqual([])
      expect(JSON.parse(await readFile(state.file, "utf8")).model.ask.modelID).toBe("old")
      selected.client = state.client
      expect(await owner.handleRoutineMessage({ type: "restoreChoicesGet", requestID: randomUUID() })).toBe(true)
      expect(Snapshot.parse(posts.at(-1)?.snapshot).choices.state).toBe("ready")
    } finally {
      await state.close()
    }
  })

test("the bounded consumed-request ledger refuses overflow without eviction while read-only refresh remains available", async () => {
  const state = await fixture()
  try {
    const pending = Array.from({ length: 1024 }, () => state.call({ type: "restoreChoicesApply", application: null }))
    state.selected.current = false
    await Promise.all(pending)
    state.selected.current = true
    expect((await state.call({ type: "restoreChoicesApply", application: null }))?.error).toContain("request limit")
    expect(state.selected.reviews).toBe(0)
    expect(state.selected.patches).toEqual([])
    expect(state.selected.updates).toEqual([])
    expect((await state.get()).choices.state).toBe("ready")
  } finally {
    await state.close()
  }
})

test("a held source read from an old page causes no writes or stale post and the same backend admits a new page", async () => {
  const state = await fixture()
  try {
    state.gate.review = Promise.withResolvers<void>()
    const pending = state.get().then(
      () => "unexpected",
      () => "withheld",
    )
    await state.gate.entered.promise
    state.selected.current = false
    state.gate.review.resolve()
    expect(await pending).toBe("withheld")
    expect(state.results).toEqual([])
    expect(state.selected.patches).toEqual([])
    expect(state.selected.updates).toEqual([])
    state.selected.current = true
    expect((await state.get()).choices.state).toBe("ready")
  } finally {
    await state.close()
  }
})
