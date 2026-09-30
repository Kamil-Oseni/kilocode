import { expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { addSessionToLifecycleWorktree, type LifecycleHost } from "../../src/agent-manager/provider-lifecycle"
import { ProjectContext } from "../../src/agent-manager/project/context"
import type { AgentManagerOutMessage } from "../../src/agent-manager/types"

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

it("echoes the exact new-session request after reordered creation and omits it for imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-composer-lifecycle-"))
  const held = gate()
  const arrived = gate()
  let count = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/session")
      const index = ++count
      if (index === 1) {
        arrived.open()
        await held.promise
      }
      return Response.json({
        id: `session-${index}`,
        version: "fixture",
        projectID: "fixture",
        directory: root,
        title: "New session",
        time: { created: 1, updated: 1 },
      })
    },
  })
  const ctx = new ProjectContext("fixture", root, true, { log: () => {} })
  const state = ctx.stateManager()
  const worktree = state.addWorktree({ branch: "fixture", parentBranch: "main", path: root })
  const posts: AgentManagerOutMessage[] = []
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const unused = (): never => {
    throw new Error("Unexpected lifecycle capability")
  }
  const host: LifecycleHost = {
    client: () => client,
    metadata: async () => ({}),
    post: (message) => posts.push(message),
    log: () => {},
    push: () => {},
    register: () => {},
    capture: () => {},
    sessions: {
      register: () => {},
      clearDirectory: unused,
      directories: unused,
      abort: unused,
      forget: unused,
    },
    createOnDisk: unused,
    runSetup: unused,
    createSession: unused,
    notifyReady: unused,
    skipStats: unused,
    unskipStats: unused,
    removePR: unused,
    removeRun: unused,
    clearRun: unused,
    forgetName: unused,
    stopDiffs: unused,
    autoName: unused,
    acquirePtyCleanup: unused,
  }
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const pending = addSessionToLifecycleWorktree(ctx, host, worktree.id, undefined, first)
  try {
    await arrived.promise
    await addSessionToLifecycleWorktree(ctx, host, worktree.id, "imported", first)
    await addSessionToLifecycleWorktree(ctx, host, worktree.id, undefined, second)
    held.open()
    await pending
    expect(posts.filter((message) => message.type === "agentManager.sessionAdded")).toEqual([
      { type: "agentManager.sessionAdded", worktreeId: worktree.id, sessionId: "imported" },
      { type: "agentManager.sessionAdded", worktreeId: worktree.id, sessionId: "session-2", requestID: second },
      { type: "agentManager.sessionAdded", worktreeId: worktree.id, sessionId: "session-1", requestID: first },
    ])
    expect(count).toBe(2)
  } finally {
    held.open()
    await Promise.allSettled([pending])
    server.stop(true)
    await state.save()
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("raya-composer-lifecycle-"))
      throw new Error("Unexpected disposable lifecycle root")
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
