import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as vscode from "vscode"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { SpeechService } from "../../src/speech/service"

test("cascade admission waits for real HTTP preparation and Stop fences readiness", async () => {
  for (const action of ["ready", "stop", "stale", "legacy"]) {
    const values = new Map<string, unknown>()
    const secrets = new Map<string, string>()
    const context = {
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
    const state = { id: "", ready: false, current: true, deletes: 0, connects: 0, posts: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer private-test-key")
        if (new URL(request.url).pathname === "/health")
          return Response.json({ version: 2, ready: true, ...(action === "legacy" ? {} : { capabilities: ["prepare"] }) })
        if (request.method === "POST") {
          state.posts++
          state.id = request.headers.get("x-raya-job-id") ?? ""
          expect(await request.json()).toEqual({
            kind: "prepare",
            model: "chatterbox-nano",
            voice: "freeman-reference-c-AI",
          })
        }
        if (request.method === "DELETE") {
          state.deletes++
          return Response.json({ id: state.id, status: "cancelled" })
        }
        return Response.json({
          id: state.id,
          kind: "prepare",
          model: "chatterbox-nano",
          voice: "freeman-reference-c-AI",
          fallback: null,
          chunks: [],
          status: state.ready ? "completed" : "running",
        })
      },
    })
    const connection = {
      async getClientAsync() {
        state.connects++
        return {}
      },
    } as unknown as KiloConnectionService
    const root = await mkdtemp(join(tmpdir(), "raya-prepare-host-"))
    const speech = new SpeechService(context)
    const posts: { type?: string; fallback?: string; requestId?: string }[] = []
    try {
      await speech.settings.setKey("local", "private-test-key")
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
      const pending = speech.realtimeStart(
        { requestId: "request_1", sessionID: "session_1", directory: root, connection, current: () => state.current },
        (msg) => posts.push(msg as (typeof posts)[number]),
      )
      if (action === "legacy") {
        await pending
        expect(posts).toEqual([
          {
            type: "speechRealtimeError",
            requestId: "request_1",
            code: "setup_failed",
            error: "Update the local Speech service to match this Raya installation, then start voice again.",
            fallback: undefined,
          },
        ])
        expect(state.posts).toBe(0)
        expect(state.deletes).toBe(0)
        expect(state.connects).toBe(1)
        continue
      }
      const deadline = Date.now() + 3000
      while (!state.id) {
        if (Date.now() > deadline) throw new Error("Preparation was not submitted.")
        await Bun.sleep(2)
      }
      expect(posts).toHaveLength(0)
      expect(state.connects).toBe(1)
      if (action === "stop") await speech.realtimeStop("request_1", (msg) => posts.push(msg as (typeof posts)[number]))
      if (action === "stale") state.current = false
      if (action !== "stop") state.ready = true
      await pending
      expect(state.deletes).toBe(1)
      expect(posts.filter((msg) => msg.fallback === "cascade-v1")).toHaveLength(action === "ready" ? 1 : 0)
      if (action === "stop") expect(posts.some((msg) => msg.type === "speechRealtimeStopped")).toBe(true)
      if (action === "ready") {
        await speech.realtimeStop("stale_request", (msg) => posts.push(msg as (typeof posts)[number]))
        expect(posts.filter((msg) => msg.type === "speechRealtimeStopped")).toHaveLength(0)
        await speech.realtimeStop("request_1", (msg) => posts.push(msg as (typeof posts)[number]))
        expect(posts.filter((msg) => msg.type === "speechRealtimeStopped")).toEqual([
          { type: "speechRealtimeStopped", requestId: "request_1" },
        ])
        await speech.realtimeStop("request_1", (msg) => posts.push(msg as (typeof posts)[number]))
        expect(posts.filter((msg) => msg.type === "speechRealtimeStopped")).toHaveLength(1)
      }
    } finally {
      speech.dispose()
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }
})
