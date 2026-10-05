import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostPublications, hostPublications } from "../../src/kilo-provider/host-publications"
import { handleModelUsageMessage } from "../../src/kilo-provider/model-usage"
import { project } from "../../src/kilo-provider/host-projection"
import { randomUUID } from "node:crypto"

test("actual joined variant and selector publications survive inactive capsule projection", async () => {
  const state = await storage()
  const owner = new HostPublications(state.store)
  const input = { "local/org/qwen3:8b": "high" }
  const writes = [owner.write("variantSelections", input), owner.write("modelSelectorExpanded", false)]
  input["local/org/qwen3:8b"] = "caller-changed"
  const snapshot = owner.captureSnapshot()
  state.release.resolve()
  try {
    await Promise.all(writes)
    const value = await snapshot
    expect(JSON.parse(await readFile(join(state.root, "variantSelections.json"), "utf8"))).toEqual({
      value: { "local/org/qwen3:8b": "high" },
    })
    const capsule = project([
      { generation: randomUUID(), role: "view", payload: { revision: value.revision, models: [], preferences: value } },
    ])
    expect(capsule.hosts[0]!.models.variants).toEqual([
      { providerID: "local", modelID: "org/qwen3:8b", variant: "high" },
    ])
    expect(capsule.hosts[0]!.models.expanded).toBe(false)
    expect(value.preferences.activation).toBe("held")
    expect(Object.isFrozen(capsule.hosts[0]!.models.variants)).toBe(true)
    await expect(owner.write("variantSelections", {})).rejects.toThrow("retired")
  } finally {
    state.release.resolve()
    await Promise.allSettled([...writes, snapshot])
    await rm(state.root, { recursive: true, force: true })
  }
})

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "raya-host-publications-"))
  const data = new Map<string, unknown>()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const store = {
    get: (key: string) => data.get(key),
    update(key: string, value: unknown) {
      const job = (async () => {
        started.resolve()
        await release.promise
        const temp = join(root, `${key}.tmp`)
        await writeFile(temp, JSON.stringify({ value }))
        await rename(temp, join(root, `${key}.json`))
        data.set(key, value)
      })()
      // Native VS Code update exposes a Thenable, not necessarily a Promise.
      return { then: job.then.bind(job) }
    },
  }
  return { root, store, started, release }
}

test("terminal host fence joins queued native Thenables and refuses new publications before the held write settles", async () => {
  const state = await storage()
  const context = { globalState: state.store }
  const owner = hostPublications(context)!
  const data = [{ providerID: "local", modelID: "qwen" }]
  const first = owner.write("recentModels", data)
  data[0]!.modelID = "caller changed it"
  const second = owner.write("modelSelectorExpanded", false)
  await state.started.promise
  const retirement = owner.retire()
  const observed = retirement.then(() => "retired")
  try {
    expect(hostPublications({ globalState: state.store })).toBe(owner)
    expect(hostPublications({ globalState: state.store }, false)).toBe(owner)
    expect(owner.retire()).toBe(retirement)
    await expect(owner.write("favoriteModels", [])).rejects.toThrow("retired")
    expect(await Promise.race([observed, Promise.resolve("held")])).toBe("held")
    state.release.resolve()
    await Promise.all([first, second, retirement])
    expect(JSON.parse(await readFile(join(state.root, "recentModels.json"), "utf8"))).toEqual({
      value: [{ providerID: "local", modelID: "qwen" }],
    })
    expect(JSON.parse(await readFile(join(state.root, "modelSelectorExpanded.json"), "utf8"))).toEqual({ value: false })
  } finally {
    state.release.resolve()
    await Promise.allSettled([first, second, retirement])
    await rm(state.root, { recursive: true, force: true })
  }
})

test("accepted model-usage mutations read after prior actual publication and preserve both increments", async () => {
  const state = await storage()
  const context = { globalState: state.store }
  const messages: unknown[] = []
  const first = handleModelUsageMessage(
    { type: "recordModelUsage", providerID: "local", modelID: "qwen" },
    context,
    (msg) => messages.push(msg),
  )
  const second = handleModelUsageMessage(
    { type: "recordModelUsage", providerID: "local", modelID: "qwen" },
    context,
    (msg) => messages.push(msg),
  )
  const retirement = hostPublications(context)!.retire()
  try {
    state.release.resolve()
    await Promise.all([first, second, retirement])
    const data = JSON.parse(await readFile(join(state.root, "modelUsage.json"), "utf8"))
    expect(data.value["local/qwen"].count).toBe(2)
    expect(messages).toHaveLength(2)
    await expect(
      handleModelUsageMessage(
        { type: "recordModelUsage", providerID: "local", modelID: "qwen" },
        context,
        () => undefined,
      ),
    ).rejects.toThrow("retired")
    expect(JSON.parse(await readFile(join(state.root, "modelUsage.json"), "utf8"))).toEqual(data)
  } finally {
    state.release.resolve()
    await Promise.allSettled([first, second, retirement])
    await rm(state.root, { recursive: true, force: true })
  }
})

test("real rename failure remains sticky while later accepted owner writes are attempted", async () => {
  const state = await storage()
  await mkdir(join(state.root, "recentModels.json"))
  const owner = new HostPublications(state.store)
  const failed = owner.write("recentModels", [])
  const success = owner.write("favoriteModels", [])
  const retirement = owner.retire()
  const result = Promise.allSettled([failed, success, retirement])
  try {
    state.release.resolve()
    const settled = await result
    expect(settled.map((entry) => entry.status)).toEqual(["rejected", "fulfilled", "rejected"])
    const error = settled[2]
    if (error?.status !== "rejected") throw new Error("Expected retirement failure")
    expect(error.reason).toBeInstanceOf(AggregateError)
    const publication = settled[0]
    if (publication?.status !== "rejected") throw new Error("Expected publication failure")
    expect(error.reason.errors).toEqual([publication.reason])
    await expect(owner.retire()).rejects.toBe(error.reason)
    expect(JSON.parse(await readFile(join(state.root, "favoriteModels.json"), "utf8"))).toEqual({ value: [] })
  } finally {
    state.release.resolve()
    await result
    await rm(state.root, { recursive: true, force: true })
  }
})

test("loaded-only observation does not create an owner and unknown keys never reach native storage", async () => {
  const state = await storage()
  const context = { globalState: state.store }
  try {
    expect(hostPublications(context, false)).toBeUndefined()
    const owner = hostPublications(context)!
    // Deliberately cross the compile-time boundary to exercise runtime validation.
    const unknown = Reflect.apply(owner.mutate, owner, ["credentials", () => "unused"])
    await expect(unknown).rejects.toThrow("does not participate")
    await owner.retire()
    expect(state.store.get("credentials")).toBeUndefined()
  } finally {
    state.release.resolve()
    await rm(state.root, { recursive: true, force: true })
  }
})

test("joined typed host snapshot reads only declared picks after actual native publication settles", async () => {
  const state = await storage()
  const owner = new HostPublications(state.store)
  const job = owner.write("favoriteModels", [{ providerID: "local", modelID: "qwen" }])
  const snapshot = owner.captureSnapshot()
  try {
    expect(owner.captureSnapshot()).toBe(snapshot)
    await state.started.promise
    expect(await Promise.race([snapshot.then(() => "closed"), Promise.resolve("held")])).toBe("held")
    state.release.resolve()
    await job
    const result = await snapshot
    expect(result.revision).toBe(1)
    expect(result.generation).toBe(owner.generation)
    expect(result.preferences.extensionState.favoriteModels).toEqual([{ providerID: "local", modelID: "qwen" }])
    expect(result.preferences.reviewOnly).toBeTrue()
    expect(Object.isFrozen(result.preferences.extensionState.favoriteModels[0])).toBeTrue()
    await expect(owner.write("recentModels", [])).rejects.toThrow("retired")
  } finally {
    state.release.resolve()
    await Promise.allSettled([job, snapshot])
    await rm(state.root, { recursive: true, force: true })
  }
})
