import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { Flock } from "@opencode-ai/core/util/flock"
import { writer, retire } from "../../src/kilo-provider/model-state-writer"
import { HostPublications } from "../../src/kilo-provider/host-publications"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-choice-guards-"))
  const state = path.join(root, "state")
  await mkdir(state)
  const file = path.join(state, "model.json")
  const original = JSON.stringify({ model: { ask: { providerID: "local", modelID: "old" } }, retained: true })
  await writeFile(file, original)
  const control = {
    source: true,
    current: true,
    entered: Promise.withResolvers<void>(),
    hold: undefined as ReturnType<typeof Promise.withResolvers<void>> | undefined,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      control.entered.resolve()
      await control.hold?.promise
      return Response.json({ state, home: root, config: root, data: root, worktree: root })
    },
  })
  const client = createKiloClient({ baseUrl: server.url.origin })
  const owner = writer(client, () => control.source)
  const close = async () => {
    await retire(client).catch((err: unknown) => {
      if (!(err instanceof AggregateError)) throw err
    })
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
  return { root, state, file, original, client, owner, control, close }
}

test("a page refusal after actual temporary write cleans the temporary file without poisoning capture", async () => {
  const state = await fixture()
  try {
    await state.owner.run()
    const result = await state.owner.guarded(
      () => !readdirSync(state.state).some((name) => name.endsWith(".tmp")),
      () => true,
      (data) => ({ ...data, model: {} }),
    )
    expect(result.accepted).toBe(false)
    expect(await readFile(state.file, "utf8")).toBe(state.original)
    expect((await readdir(state.state)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    const snapshot = await state.owner.captureSnapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.preferences?.modelState.models).toEqual([{ agent: "ask", providerID: "local", modelID: "old" }])
  } finally {
    await state.close()
  }
})

test("a refusal before the held file lock is acquired preserves the previously admitted cache and revision", async () => {
  const state = await fixture()
  const key = `raya.model-state:${process.platform === "win32" ? state.file.toLowerCase() : state.file}`
  try {
    await state.owner.run()
    const held = await Flock.acquire(key, { dir: path.join(state.state, ".raya-model-locks"), timeoutMs: 5000 })
    const control = { current: true }
    const pending = state.owner.guarded(
      () => control.current,
      () => true,
      (data) => ({ ...data, model: {} }),
    )
    try {
      const dir = path.join(state.state, ".raya-profile-locks")
      const deadline = performance.now() + 3000
      while (true) {
        const names = await readdir(dir)
        const active = await Promise.all(
          names.filter((name) => name.endsWith(".writers")).map((name) => readdir(path.join(dir, name))),
        )
        if (active.some((names) => names.length > 0)) break
        if (performance.now() >= deadline) throw new Error("Actual held writer admission was not observed")
        await Bun.sleep(5)
      }
      control.current = false
    } finally {
      await held.release()
    }
    expect((await pending).accepted).toBe(false)
    const snapshot = await state.owner.captureSnapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.preferences?.modelState.models[0]?.modelID).toBe("old")
    expect(await readFile(state.file, "utf8")).toBe(state.original)
  } finally {
    await state.close()
  }
})

test("model expected-value refusal is a no-write result and later capture remains valid", async () => {
  const state = await fixture()
  try {
    expect(
      (
        await state.owner.guarded(
          () => true,
          () => false,
          () => ({ model: {} }),
        )
      ).accepted,
    ).toBe(false)
    expect(await readFile(state.file, "utf8")).toBe(state.original)
    expect((await state.owner.captureSnapshot()).preferences?.modelState.models[0]?.modelID).toBe("old")
  } finally {
    await state.close()
  }
})

test("a delayed actual SDK path read from a replaced client leaves the admitted capture valid", async () => {
  const state = await fixture()
  try {
    await state.owner.read(() => state.control.current)
    state.control.entered = Promise.withResolvers<void>()
    state.control.hold = Promise.withResolvers<void>()
    const pending = state.owner.read(() => state.control.current)
    await state.control.entered.promise
    state.control.source = false
    state.control.current = false
    state.control.hold.resolve()
    await pending
    const snapshot = await state.owner.captureSnapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.preferences?.modelState.models[0]?.modelID).toBe("old")
    expect(await readFile(state.file, "utf8")).toBe(state.original)
  } finally {
    state.control.hold?.resolve()
    await state.close()
  }
})

test("host CAS and current-view refusals do not enter native updates or poison capture", async () => {
  const data = new Map<string, unknown>([["recentModels", []]])
  const calls: string[] = []
  const owner = new HostPublications({
    get: (key) => data.get(key),
    update: (key, value) => {
      calls.push(key)
      data.set(key, value)
      return Promise.resolve()
    },
  })
  expect(
    (
      await owner.guarded(
        () => true,
        () => false,
        { recentModels: [] },
      )
    ).accepted,
  ).toBe(false)
  expect(
    (
      await owner.guarded(
        () => false,
        () => true,
        { recentModels: [] },
      )
    ).accepted,
  ).toBe(false)
  expect(calls).toEqual([])
  expect((await owner.captureSnapshot()).revision).toBe(0)
})
