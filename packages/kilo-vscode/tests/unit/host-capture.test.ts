import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { HostCapture, hostPayload } from "../../src/kilo-provider/host-capture"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"

test("all loaded host preparations settle before any actual state writer closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-host-registry-"))
  const registry = new HostCapture()
  const contexts = (path: string) =>
    new ProjectContexts({
      workspaceRoot: () => path,
      enabled: () => false,
      registry: { list: () => [], get: () => undefined },
      deps: { log: () => undefined },
    })
  const a = contexts(join(root, "first"))
  const b = contexts(join(root, "second"))
  const first = a.pinned()!.stateManager()
  const second = b.pinned()!.stateManager()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const client = createKiloClient({ baseUrl: "http://127.0.0.1:1" })
  const events: string[] = []
  registry.register(randomUUID(), "agent-manager", {
    prepare: async (sdk) => {
      expect(sdk).toBe(client)
      first.addSession("prepared", null)
      await first.flush()
      events.push("first-prepared")
      return () => expect(events).toContain("second-prepared")
    },
    close: async () => {
      events.push("first-closed")
      return a.captureSnapshot()
    },
  })
  registry.register(randomUUID(), "agent-manager", {
    prepare: async () => {
      entered.resolve()
      await release.promise
      expect(events).not.toContain("first-closed")
      second.addSession("prepared", null)
      await second.flush()
      events.push("second-prepared")
      return () => undefined
    },
    close: async () => {
      events.push("second-closed")
      return b.captureSnapshot()
    },
  })
  const capture = registry.capture(client, Date.now() + 5000)
  try {
    await entered.promise
    expect(() => registry.check()).toThrow("retired")
    expect(registry.capture(client, Date.now() + 5000)).toBe(capture)
    release.resolve()
    const result = await capture
    const payload = hostPayload(result)
    expect(payload.hosts).toHaveLength(2)
    expect(payload.hosts[0]!.contexts[0]!.root?.path).toBe(first.publications().roots[0]!.path)
    expect(Object.isFrozen(payload.hosts[0]!.contexts[0])).toBeTrue()
    expect(() => hostPayload(JSON.parse(JSON.stringify(result)))).toThrow("not owned")
    expect(() => hostPayload({ generation: result.generation })).toThrow("not owned")
    expect(Object.isFrozen(result)).toBeTrue()
    expect(events.indexOf("second-prepared")).toBeLessThan(events.indexOf("first-closed"))
    expect(
      JSON.parse(await readFile(join(root, "second", ".kilo", "agent-manager.json"), "utf8")).sessions.prepared,
    ).toBeDefined()
    expect(() => second.addSession("late", null)).toThrow("retired")
  } finally {
    release.resolve()
    await Promise.allSettled([capture, first.retire(), second.retire()])
    await rm(root, { recursive: true, force: true })
  }
})

test("a synchronous failed host still attempts every later real owner close and keeps failure sticky", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-host-registry-failure-"))
  const registry = new HostCapture()
  const state = new WorktreeStateManager(root, () => undefined)
  const error = new Error("Owned host preparation failed")
  const closed: string[] = []
  registry.register("failed", "view", {
    prepare: () => {
      throw error
    },
    close: async () => {
      closed.push("failed")
    },
  })
  registry.register("state", "agent-manager", {
    prepare: async () => () => undefined,
    close: async () => {
      state.addSession("joined", null)
      await state.retire()
      closed.push("state")
    },
  })
  const capture = registry.capture(createKiloClient({ baseUrl: "http://127.0.0.1:1" }), Date.now() + 5000)
  try {
    const failure = await capture.catch((err) => err)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toContain(error)
    expect(closed).toEqual(["failed", "state"])
    expect(JSON.parse(await readFile(join(root, ".kilo", "agent-manager.json"), "utf8")).sessions.joined).toBeDefined()
    await expect(registry.capture(createKiloClient({ baseUrl: "http://127.0.0.1:1" }), Date.now() + 5000)).rejects.toBe(
      failure,
    )
  } finally {
    await state.retire()
    await rm(root, { recursive: true, force: true })
  }
})
