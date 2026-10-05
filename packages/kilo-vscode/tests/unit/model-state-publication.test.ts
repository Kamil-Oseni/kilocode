import { expect, test } from "bun:test"
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { Flock } from "@opencode-ai/core/util/flock"
import { admitProfileOperation, coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
import { handleMessage, reset, retire } from "../../src/kilo-provider/model-state"
import { writer } from "../../src/kilo-provider/model-state-writer"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-model-publication-"))
  const state = path.join(root, "state")
  await mkdir(state)
  const seen = Promise.withResolvers<void>()
  const selected = { state, requests: 0, current: true }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/path") return new Response("Unexpected request", { status: 400 })
      selected.requests++
      seen.resolve()
      return Response.json({ state: selected.state, home: root, config: root, data: root, worktree: root })
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString(), throwOnError: true })
  const current = () => selected.current
  const post = () => undefined
  const pick = (agent: string, model = "qwen") =>
    handleMessage("persistModelSelection", { agent, providerID: "local", modelID: model }, client, post, current)
  const file = path.join(state, "model.json")
  const close = async () => {
    await retire(client).then(
      () => undefined,
      () => undefined,
    ) // Expected refusal is inspected by each failure case.
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
  return { root, state, file, client, current, post, pick, selected, seen, close }
}

test("live separate-process model holder is not evicted by heartbeat age", async () => {
  const state = await fixture()
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures/model-state-holder.ts"), state.state],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const output = child.stdout.getReader()
  const stderr = new Response(child.stderr).text()
  const result = {
    task: undefined as Promise<PromiseSettledResult<unknown>[]> | undefined,
    settled: false,
    code: undefined as number | undefined,
    err: "",
    out: "",
    data: undefined as Record<string, unknown> | undefined,
    statuses: [] as string[],
  }
  try {
    expect(new TextDecoder().decode((await output.read()).value).trim()).toBe("ready")
    process.kill(child.pid, 0)
    const dir = path.join(state.state, ".raya-model-locks")
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    const lock = path.join(dir, names[0])
    const owner = await readFile(path.join(lock, "meta.json"))
    expect(JSON.parse(owner.toString()).pid).toBe(child.pid)
    const before = JSON.stringify({ retained: "unchanged", variant: { "local/model": "none" }, recent: [] })
    await writeFile(state.file, before)
    const aged = new Date(Date.now() - 120000)
    await utimes(path.join(lock, "heartbeat"), aged, aged)
    result.task = Promise.allSettled([state.pick("ask")]).then((value) => {
      result.settled = true
      return value
    })
    await state.seen.promise
    await Bun.sleep(350)
    expect(result.settled).toBeFalse()
    expect(await readFile(state.file, "utf8")).toBe(before)
    expect(await readFile(path.join(lock, "meta.json"))).toEqual(owner)
    process.kill(child.pid, 0)
  } finally {
    child.stdin.write("release\n")
    child.stdin.end()
    const rest = await output.read()
    result.code = await child.exited
    result.err = await stderr
    result.out = new TextDecoder().decode(rest.value).trim()
    result.statuses = (await result.task)?.map((row) => row.status) ?? []
    result.data = JSON.parse(await readFile(state.file, "utf8"))
    await state.close()
  }
  expect(result.code).toBe(0)
  expect(result.err).toBe("")
  expect(result.out).toBe("released")
  expect(result.statuses).toEqual(["fulfilled"])
  expect(result.data).toEqual({
    retained: "unchanged",
    variant: { "local/model": "none" },
    recent: [],
    model: { ask: { providerID: "local", modelID: "qwen" } },
  })
}, 15000)

test("actual SDK path and full queued read-modify-write preserve concurrent agent choices and unrelated fields", async () => {
  const state = await fixture()
  try {
    await writeFile(
      state.file,
      JSON.stringify({ model: {}, recent: [{ providerID: "local", modelID: "old" }], retained: "evidence" }),
    )
    await Promise.all([state.pick("auto"), state.pick("plan", "second")])
    const data = JSON.parse(await readFile(state.file, "utf8"))
    expect(data.model).toEqual({
      auto: { providerID: "local", modelID: "qwen" },
      plan: { providerID: "local", modelID: "second" },
    })
    expect(data.retained).toBe("evidence")
    expect(data.recent).toEqual([{ providerID: "local", modelID: "old" }])
    await handleMessage("clearModelSelection", { agent: "auto" }, state.client, state.post, state.current)
    expect(JSON.parse(await readFile(state.file, "utf8")).model).toEqual({
      plan: { providerID: "local", modelID: "second" },
    })
    await reset(state.client, state.post, state.current)
    expect(JSON.parse(await readFile(state.file, "utf8")).model).toEqual({})
    expect((await readdir(state.state)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(
      ProfileRoots.snapshot().some(
        (root) => root.kind === "json" && root.path.toLowerCase() === state.file.toLowerCase(),
      ),
    ).toBeTrue()
  } finally {
    await state.close()
  }
})

test("joined model evidence uses only actual admitted cached payload with no further SDK request", async () => {
  const state = await fixture()
  try {
    const owner = writer(state.client, state.current)
    await state.pick("auto")
    const requests = state.selected.requests
    const snapshot = await owner.captureSnapshot()
    expect(state.selected.requests).toBe(requests)
    expect(snapshot.roots).toEqual([{ kind: "json", path: state.file }])
    expect(snapshot.revision).toBe(1)
    expect(snapshot.preferences?.modelState.models).toEqual([{ agent: "auto", providerID: "local", modelID: "qwen" }])
    expect(snapshot.preferences?.reviewOnly).toBeTrue()
    expect(Object.isFrozen(snapshot.roots[0])).toBeTrue()
    await expect(state.pick("late")).rejects.toThrow("retired")
  } finally {
    await state.close()
  }
})

test("terminal retirement joins an actual Flock-held writer and queued picks, with a live Root admission marker", async () => {
  const state = await fixture()
  const key = `raya.model-state:${process.platform === "win32" ? state.file.toLowerCase() : state.file}`
  const lock = await Flock.acquire(key, { dir: path.join(state.state, ".raya-model-locks"), timeoutMs: 5000 })
  const gate = { released: false }
  const first = state.pick("first")
  const second = state.pick("second")
  const operations = Promise.allSettled([first, second])
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const maintenance = { task: undefined as Promise<unknown> | undefined }
  try {
    await state.seen.promise
    const dir = path.join(state.state, ".raya-profile-locks")
    const deadline = performance.now() + 3000
    while (true) {
      const names = await readdir(dir).catch((err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return []
        throw err
      })
      const marker = names.find((name) => name.endsWith(".writers"))
      if (marker && (await readdir(path.join(dir, marker))).length) break
      if (performance.now() >= deadline) throw new Error("Actual model writer admission marker was not observed")
      await Bun.sleep(10)
    }
    const retirement = retire(state.client)
    const joined = retirement.then(() => "settled")
    expect(retire(state.client)).toBe(retirement)
    await expect(state.pick("late")).rejects.toThrow("retired")
    expect(await Promise.race([joined, Promise.resolve("held")])).toBe("held")
    maintenance.task = coordinateNativeRoots([{ kind: "json", path: state.file }], async () => {
      held.resolve()
      await release.promise
      return "gated"
    })
    expect(await Promise.race([held.promise.then(() => "entered"), Promise.resolve("pending")])).toBe("pending")
    expect(await Promise.race([joined, Promise.resolve("held")])).toBe("held")
    await lock.release()
    gate.released = true
    await held.promise
    expect(Object.keys(JSON.parse(await readFile(state.file, "utf8")).model)).toEqual(["first", "second"])
    expect(() => admitProfileOperation({ kind: "json", path: state.file })).toThrow("maintenance excludes")
    release.resolve()
    await maintenance.task
    expect((await operations).map((item) => item.status)).toEqual(["fulfilled", "fulfilled"])
    await retirement
    expect(Object.keys(JSON.parse(await readFile(state.file, "utf8")).model)).toEqual(["first", "second"])
    const receipt = await coordinateNativeRoots(
      [{ kind: "json", path: state.file }],
      async () => "after native release",
    )
    expect(receipt.value).toBe("after native release")
    expect(receipt.admission.completeProfileCoverage).toBeFalse()
  } finally {
    release.resolve()
    if (!gate.released) await lock.release()
    await operations
    await maintenance.task
    await state.close()
  }
})

test("fresh SDK replacement joins and fences the old writer without reusing the source path", async () => {
  const first = await fixture()
  const second = await fixture()
  try {
    await first.pick("source")
    const before = await readFile(first.file, "utf8")
    first.selected.current = false
    await second.pick("destination")
    await expect(first.pick("stale")).rejects.toThrow("generation changed")
    expect(await readFile(first.file, "utf8")).toBe(before)
    expect(Object.keys(JSON.parse(await readFile(second.file, "utf8")).model)).toEqual(["destination"])
    expect(second.selected.requests).toBe(1)
  } finally {
    await first.close()
    await second.close()
  }
})

test("same-client physical profile replacement refuses before destination file creation", async () => {
  const state = await fixture()
  try {
    await state.pick("source")
    const before = await readFile(state.file, "utf8")
    const next = path.join(state.root, "next")
    await mkdir(next)
    state.selected.state = next
    await expect(state.pick("changed")).rejects.toThrow("path changed")
    expect(await readFile(state.file, "utf8")).toBe(before)
    expect(await readdir(next)).toEqual([])
    await expect(retire(state.client)).rejects.toBeInstanceOf(AggregateError)
  } finally {
    await state.close()
  }
})

test("actual malformed JSON and hard-linked file failures are retained instead of rewriting unknown data", async () => {
  const state = await fixture()
  try {
    await writeFile(state.file, "{broken")
    await expect(state.pick("failed")).rejects.toBeInstanceOf(AggregateError)
    expect(await readFile(state.file, "utf8")).toBe("{broken")
    await writeFile(state.file, "{}")
    await link(state.file, path.join(state.state, "linked.json"))
    await expect(state.pick("linked")).rejects.toBeInstanceOf(AggregateError)
    expect(await readFile(state.file, "utf8")).toBe("{}")
    const result = await retire(state.client).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError)) throw new Error("Expected retained failures")
    expect(result.errors).toHaveLength(2)
    await expect(retire(state.client)).rejects.toBe(result)
  } finally {
    await state.close()
  }
})

test.skipIf(process.platform !== "win32")(
  "actual Windows read-only target rename failure retains the old file and sticky refusal",
  async () => {
    const state = await fixture()
    try {
      await writeFile(state.file, "{}")
      await chmod(state.file, 0o444)
      await expect(state.pick("failed")).rejects.toBeInstanceOf(AggregateError)
      expect(await readFile(state.file, "utf8")).toBe("{}")
      expect((await readdir(state.state)).filter((name) => name.endsWith(".tmp"))).toEqual([])
      await expect(retire(state.client)).rejects.toBeInstanceOf(AggregateError)
    } finally {
      await chmod(state.file, 0o600)
      await state.close()
    }
  },
)
