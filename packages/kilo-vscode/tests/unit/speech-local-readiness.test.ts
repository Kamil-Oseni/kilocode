import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type * as vscode from "vscode"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { SpeechService } from "../../src/speech/service"

function context() {
  const values = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  return {
    globalState: {
      get<T>(key: string, fallback?: T) {
        return (values.get(key) ?? fallback) as T
      },
      async update(key: string, value: unknown) {
        values.set(key, value)
      },
    },
    secrets: {
      async get(key: string) {
        return secrets.get(key)
      },
      async store(key: string, value: string) {
        secrets.set(key, value)
      },
      async delete(key: string) {
        secrets.delete(key)
      },
    },
  } as vscode.ExtensionContext
}

for (const action of ["stop", "failure", "stale", "switch", "switch-failure", "drop", "dispose"]) {
  test(`local readiness refresh retires and joins its original HTTP cleanup on ${action}`, async () => {
    const gate = Promise.withResolvers<void>()
    const state = { posts: 0, deletes: 0, current: true }
    const jobs = new Map<string, number>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer readiness-test-key")
        if (new URL(request.url).pathname === "/health") return Response.json({ ready: true, version: 2 })
        const id = request.headers.get("x-raya-job-id") ?? new URL(request.url).pathname.split("/").at(-1)!
        if (request.method === "DELETE") {
          state.deletes++
          if (jobs.get(id) === 2) {
            await gate.promise
            if (action.includes("failure")) return Response.json({ error: "cleanup refused" }, { status: 500 })
          }
          return Response.json({ id, status: "cancelled" })
        }
        if (request.method === "POST") {
          expect(await request.json()).toEqual({
            kind: "prepare",
            model: "chatterbox-nano",
            voice: "freeman-reference-c-AI",
          })
          state.posts++
          jobs.set(id, state.posts)
        }
        return Response.json({
          id,
          kind: "prepare",
          model: "chatterbox-nano",
          voice: "freeman-reference-c-AI",
          fallback: null,
          chunks: [],
          status: "completed",
        })
      },
    })
    const connection = {
      async getClientAsync() {
        return {}
      },
    } as unknown as KiloConnectionService
    const base = resolve(tmpdir())
    const root = await mkdtemp(join(base, "raya-readiness-"))
    const speech = new SpeechService(context(), { refresh: 20 })
    const posts: { type?: string; code?: string; fallback?: string }[] = []
    const post = (msg: unknown) => posts.push(msg as (typeof posts)[number])
    try {
      await speech.settings.setKey("local", "readiness-test-key")
      await speech.update(
        {
          voiceEngine: "cascade-v1",
          ttsEngine: "local-jobs",
          sttEngine: "local",
          sttEndpoint: "http://127.0.0.1:8770/v1/audio/transcriptions",
          localTtsEndpoint: `http://127.0.0.1:${server.port}`,
        },
        root,
        () => {},
      )
      await speech.realtimeStart(
        { requestId: "call_1", sessionID: "session_1", directory: root, connection, current: () => state.current },
        post,
      )
      await speech.ended()
      expect(posts.filter((msg) => msg.fallback === "cascade-v1")).toHaveLength(1)
      expect(speech.admin().failed).toBe(0)
      expect(speech.admin().active).toBe(1)
      const deadline = Date.now() + 2000
      while (state.deletes < 2) {
        if (Date.now() >= deadline) throw new Error("Owned refresh did not reach cleanup.")
        await Bun.sleep(2)
      }
      expect(state.posts).toBe(2)
      await speech.realtimeStop("other_call", post)
      expect(posts.some((msg) => msg.type === "speechRealtimeStopped")).toBe(false)
      const settled = { done: false, failed: false }
      const operation = (async () => {
        if (action === "stale") {
          state.current = false
          return
        }
        if (action.startsWith("switch")) return speech.update({ voiceEngine: "openai-realtime" }, root, () => {})
        if (action === "drop") {
          speech.drop()
          return speech.ended()
        }
        if (action === "dispose") {
          speech.dispose()
          return speech.ended()
        }
        return speech.realtimeStop("call_1", post)
      })().then(
        () => {
          settled.done = true
        },
        () => {
          settled.done = true
          settled.failed = true
        },
      )
      await Bun.sleep(30)
      if (action !== "stale") expect(settled.done).toBe(false)
      expect(posts.some((msg) => msg.type === "speechRealtimeStopped")).toBe(false)
      if (action.startsWith("switch")) expect((await speech.settings.load()).voiceEngine).toBe("cascade-v1")
      gate.resolve()
      await operation
      await Bun.sleep(80)
      await speech.ended()
      expect(state.posts).toBe(2)
      expect(state.deletes).toBe(2)
      expect(speech.admin().active).toBe(0)
      if (action === "stop") expect(posts.filter((msg) => msg.type === "speechRealtimeStopped")).toHaveLength(1)
      if (action === "failure") {
        expect(posts.some((msg) => msg.code === "cleanup_failed")).toBe(true)
        expect(posts.some((msg) => msg.type === "speechRealtimeStopped")).toBe(false)
        expect(speech.admin().incomplete).toBe(1)
      }
      if (action.startsWith("switch")) {
        expect(settled.failed).toBe(action.includes("failure"))
        expect((await speech.settings.load()).voiceEngine).toBe(
          action.includes("failure") ? "cascade-v1" : "openai-realtime",
        )
      }
      if (action === "stale") expect(posts.filter((msg) => msg.type === "speechRealtimeError")).toHaveLength(1)
    } finally {
      gate.resolve()
      speech.dispose()
      await speech.ended()
      await server.stop()
      if (dirname(root) !== base) throw new Error("Private test directory escaped its original parent.")
      await rm(root, { recursive: true, force: true })
    }
  })
}
