import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as vscode from "vscode"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { KiloProvider } from "../../src/KiloProvider"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { routeInputToolMessage } from "../../src/services/input-tools"
import { VoiceReplies } from "../../src/speech/replies"
import { SpeechService } from "../../src/speech/service"
import type { PlaybackDiagnostic } from "../../src/speech/diagnostics"

const first = "9a1d6a7d-8387-4381-b9bf-e7bfda2d66c3"
const second = "f646737d-3e15-4bc1-8e86-0505d460ee81"

function gate() {
  const result = Promise.withResolvers<void>()
  return result
}

function memory() {
  const values = new Map<string, unknown>()
  const keys = new Map<string, string>()
  const state = { failure: false, held: undefined as ReturnType<typeof gate> | undefined, entered: gate() }
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
        if (state.held) {
          state.entered.resolve()
          await state.held.promise
        }
        if (state.failure) throw new Error("Synthetic credential-store failure")
        return keys.get(key)
      },
      async store(key: string, value: string) {
        keys.set(key, value)
      },
      async delete(key: string) {
        keys.delete(key)
      },
    },
  } as vscode.ExtensionContext
  return { context, state }
}

async function harness(endpoint?: string) {
  const store = memory()
  const diagnostics: PlaybackDiagnostic[] = []
  const speech = new SpeechService(store.context, { diagnostic: (row) => diagnostics.push(row) })
  await speech.settings.update({
    voiceEngine: "cascade-v1",
    mode: "hands-free",
    ttsEngine: "local-jobs",
    localTtsEndpoint: endpoint,
  })
  const posts: Record<string, unknown>[] = []
  const state = { current: true }
  const post = (message: unknown) => posts.push(message as Record<string, unknown>)
  const send = (message: Record<string, unknown>) =>
    routeInputToolMessage(message, {
      connection: {} as KiloConnectionService,
      dir: import.meta.dir,
      speech,
      post,
      voiceScope: (sessionID) =>
        sessionID === "session-1" ? { directory: import.meta.dir, current: () => state.current } : undefined,
    })
  const marker = { user: "" }
  const mark = async (requestId: string) => {
    await send({ type: "speechVoiceTurn", requestId, sessionID: "session-1" })
    marker.user = "user-" + requestId
    speech.bindVoiceTurn("session-1", marker.user, requestId)
  }
  const reply = (id: string) => {
    speech.trackMessage("session-1", "assistant", id, marker.user, true)
    speech.trackPart("session-1", {
      id: id + "-part",
      messageID: id,
      type: "text",
      text: "Synthetic final reply.",
      time: { start: 1, end: 2 },
    })
  }
  return { speech, store, posts, state, post, send, mark, reply, diagnostics }
}

test("actual routing and service expose pre-chunk credential failure with the original frontend UUID", async () => {
  const ctx = await harness()
  try {
    await ctx.send({ type: "speechVoiceTurn", requestId: "invalid", sessionID: "session-1" })
    expect(ctx.posts).toEqual([])
    await ctx.mark(first)
    ctx.speech.trackMessage("foreign", "assistant", "foreign-message")
    ctx.speech.trackPart("foreign", {
      id: "foreign-part",
      messageID: "foreign-message",
      type: "text",
      text: "Foreign reply.",
    })
    await ctx.speech.speakOnIdle("foreign", ctx.post)
    expect(ctx.posts).toEqual([])
    ctx.reply("assistant-1")
    await ctx.speech.speakOnIdle("session-1", ctx.post)
    expect(ctx.posts).toEqual([
      { type: "speechPlaybackError", requestId: first, error: "Configure local speech in Speech settings." },
    ])
    expect(ctx.diagnostics).toContainEqual(
      expect.objectContaining({ request: first, phase: "callback", kind: "error", forwarded: true }),
    )
    expect(JSON.stringify(ctx.diagnostics)).not.toContain("Synthetic final reply.")
    await ctx.mark(first)
    ctx.reply("duplicate")
    await ctx.speech.speakOnIdle("session-1", ctx.post)
    expect(ctx.posts).toHaveLength(1)
  } finally {
    ctx.speech.dispose()
    await ctx.speech.ended()
  }
})

test("actual service distinguishes configured playback skips with content-free current-turn observations", async () => {
  for (const [request, settings, reason] of [
    [first, { mode: "off" as const }, "off"],
    [second, { voiceEngine: "openai-realtime" as const }, "cloud-engine"],
  ] as const) {
    const ctx = await harness()
    try {
      await ctx.mark(request)
      ctx.reply("assistant")
      await ctx.speech.settings.update(settings)
      await ctx.speech.speakOnIdle("session-1", ctx.post)
      expect(ctx.posts).toEqual([])
      expect(ctx.diagnostics).toContainEqual(
        expect.objectContaining({ request, phase: "handoff", boundary: "skip", reason }),
      )
      expect(JSON.stringify(ctx.diagnostics)).not.toContain("Synthetic final reply.")
    } finally {
      ctx.speech.dispose()
      await ctx.speech.ended()
    }
  }
})

test("actual async credential rejection is correlated and suppressed after Stop or a newer turn", async () => {
  const ctx = await harness()
  try {
    await ctx.mark(first)
    ctx.reply("assistant-1")
    ctx.store.state.failure = true
    await ctx.speech.speakOnIdle("session-1", ctx.post)
    expect(ctx.posts[0]).toMatchObject({ type: "speechPlaybackError", requestId: first })
    ctx.posts.length = 0
    ctx.store.state.held = gate()
    await ctx.mark(second)
    ctx.reply("assistant-2")
    const old = ctx.speech.speakOnIdle("session-1", ctx.post)
    await ctx.store.state.entered.promise
    await ctx.send({ type: "speechPlaybackCancel", requestId: second })
    ctx.store.state.held.resolve()
    await old
    expect(ctx.posts).toEqual([])
    expect(ctx.diagnostics).toContainEqual(
      expect.objectContaining({ request: second, phase: "error", forwarded: false }),
    )
  } finally {
    ctx.store.state.held?.resolve()
    ctx.speech.dispose()
    await ctx.speech.ended()
  }
})

test("old idle waiters cannot consume replacement text or rebind prior assistant IDs", async () => {
  const replies = new VoiceReplies()
  replies.mark({ requestId: first, sessionID: "session-1" })
  replies.bind("session-1", "user-1", first)
  replies.message("session-1", "assistant", "old-assistant", "user-1", true)
  const old = replies.wait("session-1")
  replies.mark({ requestId: second, sessionID: "session-1" })
  expect(replies.bind("session-1", "user-1", first)).toBe(false)
  replies.bind("session-1", "user-2", second)
  replies.message("session-1", "assistant", "old-assistant", "user-1", true)
  replies.part("session-1", {
    id: "old",
    messageID: "old-assistant",
    type: "text",
    text: "Old reply.",
    time: { start: 1, end: 2 },
  })
  expect(replies.complete("session-1")).toBeUndefined()
  replies.message("session-1", "assistant", "new-assistant", "user-2", true)
  replies.part("session-1", {
    id: "new",
    messageID: "new-assistant",
    type: "text",
    text: "New reply.",
    time: { start: 1, end: 2 },
  })
  expect(await old).toBeUndefined()
  const result = await replies.wait("session-1")
  expect(result).toMatchObject({ requestId: second, text: "New reply." })
  expect(result?.current()).toBe(true)
  replies.cancel(first)
  expect(result?.current()).toBe(true)
  replies.cancel(second)
  expect(result?.current()).toBe(false)
  expect(replies.mark({ requestId: second, sessionID: "session-1" })).toBe(false)
})

test("actual provider binds only the marker captured before admission and forwards exact assistant parent IDs", async () => {
  const ctx = await harness()
  const root = await mkdtemp(join(tmpdir(), "raya-voice-parent-"))
  const submitted: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/session/session-1/prompt_async")
      submitted.push((await request.json()) as Record<string, unknown>)
      return new Response(null, { status: 204 })
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const connection = {
    getClient: () => client,
    recordMessageSessionId: () => {},
    sandboxPreference: { explicit: () => false, wait: async () => {}, onChange: () => () => {} },
    unregisterVisible: () => {},
    unregisterAttached: () => {},
  }
  const provider = new KiloProvider({ fsPath: root } as never, connection as never, undefined, {
    projectDirectory: root,
    disableViewedRegistration: true,
  })
  const internal = provider as unknown as {
    speech: SpeechService
    webview: { postMessage: (message: unknown) => Promise<boolean> }
    checkpoints: Map<string, Promise<void>>
    handleSendMessage: (
      text: string,
      messageID: string,
      sessionID: string,
      draftID: undefined,
      providerID: string,
      modelID: string,
      agent: string,
    ) => Promise<void>
    handleEvent: (event: unknown) => void
  }
  internal.speech = ctx.speech
  internal.webview = { postMessage: async () => true }
  try {
    // The marker is intentionally unbound until the original provider's dispatch.
    await ctx.send({ type: "speechVoiceTurn", requestId: first, sessionID: "session-1" })
    const held = gate()
    internal.checkpoints.set("session-1", held.promise)
    const old = internal.handleSendMessage(
      "Synthetic old prompt.",
      "user-old",
      "session-1",
      undefined,
      "ollama",
      "pinned",
      "voice",
    )
    // resolveSession yields before admission; the request token was already captured.
    await Promise.resolve()
    await ctx.send({ type: "speechVoiceTurn", requestId: second, sessionID: "session-1" })
    held.resolve()
    await old
    expect(submitted).toHaveLength(1)
    internal.handleEvent({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "assistant-old",
          role: "assistant",
          sessionID: "session-1",
          parentID: "user-old",
          time: { created: 1 },
        },
      },
    })
    internal.handleEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          id: "old-part",
          sessionID: "session-1",
          messageID: "assistant-old",
          type: "text",
          text: "Old answer.",
          time: { start: 1, end: 2 },
        },
      },
    })
    expect(ctx.speech.bindVoiceTurn("session-1", "probe", first)).toBe(false)
    await internal.handleSendMessage(
      "Synthetic current prompt.",
      "user-new",
      "session-1",
      undefined,
      "ollama",
      "pinned",
      "voice",
    )
    expect(submitted[1]).toMatchObject({
      messageID: "user-new",
      agent: "voice",
      model: { providerID: "ollama", modelID: "pinned" },
    })
    expect(ctx.speech.bindVoiceTurn("session-1", "probe", second)).toBe(false)
    // First-seen stale assistant for the prior user is refused, even after dispatch.
    internal.handleEvent({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "assistant-late",
          role: "assistant",
          sessionID: "session-1",
          parentID: "user-old",
          time: { created: 1 },
        },
      },
    })
    internal.handleEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          id: "late-part",
          sessionID: "session-1",
          messageID: "assistant-late",
          type: "text",
          text: "Late old answer.",
        },
      },
    })
    const waiting = ctx.speech.speakOnIdle("session-1", ctx.post)
    for (const finish of ["tool-calls", undefined] as const) {
      internal.handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "intermediate-" + finish,
            role: "assistant",
            sessionID: "session-1",
            parentID: "user-new",
            time: { created: 1, completed: 2 },
            finish,
          },
        },
      })
      internal.handleEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            id: "intermediate-part-" + finish,
            messageID: "intermediate-" + finish,
            type: "text",
            text: "Intermediate reply.",
            time: { start: 1, end: 2 },
          },
        },
      })
      await Promise.resolve()
      expect(ctx.posts).toEqual([])
    }
    internal.handleEvent({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "assistant-new",
          role: "assistant",
          sessionID: "session-1",
          parentID: "user-new",
          time: { created: 1, completed: 2 },
          finish: "stop",
        },
      },
    })
    internal.handleEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          id: "new-part",
          sessionID: "session-1",
          messageID: "assistant-new",
          type: "text",
          text: "New answer.",
          time: { start: 1, end: 2 },
        },
      },
    })
    await Promise.all([waiting, ctx.speech.speakOnIdle("session-1", ctx.post)])
    expect(ctx.posts).toEqual([
      { type: "speechPlaybackError", requestId: second, error: "Configure local speech in Speech settings." },
    ])
    for (const failure of ["error", "length", "info"] as const) {
      const requestId = crypto.randomUUID()
      await ctx.send({ type: "speechVoiceTurn", requestId, sessionID: "session-1" })
      ctx.speech.bindVoiceTurn("session-1", "user-failure", requestId)
      const pending = ctx.speech.speakOnIdle("session-1", ctx.post)
      ctx.speech.busy("session-1")
      internal.handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "failed-" + failure,
            role: "assistant",
            sessionID: "session-1",
            parentID: "user-failure",
            time: { created: 1, completed: 2 },
            finish: failure === "info" ? "stop" : failure,
            error: failure === "info" ? { name: "UnknownError", data: { message: "Synthetic failure" } } : undefined,
          },
        },
      })
      internal.handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "stale-incomplete",
            role: "assistant",
            sessionID: "session-1",
            parentID: "user-failure",
            time: { created: 1 },
          },
        },
      })
      internal.handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "failed-" + failure,
            role: "assistant",
            sessionID: "session-1",
            parentID: "user-failure",
            time: { created: 1 },
          },
        },
      })
      await pending
      expect(ctx.posts.at(-1)).toMatchObject({
        type: "speechPlaybackError",
        requestId,
        error: "The Voice reply did not complete. Check the chat error and retry.",
      })
      expect(ctx.diagnostics.filter((row) => row.request === requestId && row.phase === "start")).toEqual([])
    }
  } finally {
    provider.dispose()
    await ctx.speech.ended()
    await server.stop(true)
  }
})

test("real synthetic HTTP job failure preserves the marker UUID and cancels old publication on replacement", async () => {
  const entered = gate()
  const held = gate()
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push(request.method + " " + path)
      if (path === "/health") return Response.json({ version: 2, ready: true })
      if (request.method === "DELETE") return Response.json({ cancelled: true })
      if (request.method === "POST") {
        const id = request.headers.get("x-raya-job-id")
        if (calls.filter((value) => value.startsWith("POST ")).length === 1) {
          entered.resolve()
          await held.promise
        }
        return Response.json({
          id,
          status: "failed",
          model: "chatterbox-nano",
          voice: "freeman-reference-c-AI",
          fallback: null,
          chunks: [],
        })
      }
      throw new Error("Unexpected synthetic endpoint")
    },
  })
  const ctx = await harness(`http://127.0.0.1:${server.port}`)
  try {
    await ctx.speech.settings.setKey("local", "synthetic-only-key")
    await ctx.mark(first)
    ctx.reply("assistant-1")
    const old = ctx.speech.speakOnIdle("session-1", ctx.post)
    await entered.promise
    await ctx.mark(second)
    held.resolve()
    await old
    expect(ctx.posts).toEqual([])
    ctx.reply("assistant-2")
    await ctx.speech.speakOnIdle("session-1", ctx.post)
    expect(ctx.posts).toEqual([{ type: "speechPlaybackError", requestId: second, error: "Local speech job failed." }])
    expect(calls.filter((value) => value.startsWith("DELETE "))).toHaveLength(2)
    expect(calls.some((value) => value.includes("/audio/"))).toBe(false)
  } finally {
    held.resolve()
    ctx.speech.dispose()
    await ctx.speech.ended()
    await server.stop(true)
  }
})

test("idle before delayed final text still hands the original reply to playback", async () => {
  const ctx = await harness()
  try {
    await ctx.mark(first)
    ctx.speech.trackMessage("session-1", "assistant", "late-assistant", "user-" + first)
    const pending = ctx.speech.speakOnIdle("session-1", ctx.post)
    await Bun.sleep(1600)
    ctx.speech.trackMessage("session-1", "assistant", "late-assistant", "user-" + first, true)
    ctx.speech.trackPart("session-1", {
      id: "late-part",
      messageID: "late-assistant",
      type: "text",
      text: "Delayed final reply.",
      time: { start: 1, end: 2 },
    })
    await pending
    expect(ctx.posts).toContainEqual({
      type: "speechPlaybackError",
      requestId: first,
      error: "Configure local speech in Speech settings.",
    })
  } finally {
    ctx.speech.dispose()
    await ctx.speech.ended()
  }
})

test("idle cannot speak streaming text, and duplicate idle consumers share one terminal handoff", async () => {
  const ctx = await harness()
  try {
    await ctx.mark(first)
    ctx.speech.trackMessage("session-1", "assistant", "final", "user-" + first)
    ctx.speech.trackPart("session-1", { id: "part", messageID: "final", type: "text", text: "Partial" })
    const pending = ctx.speech.speakOnIdle("session-1", ctx.post)
    const duplicate = ctx.speech.speakOnIdle("session-1", ctx.post)
    await Promise.resolve()
    expect(ctx.posts).toEqual([])
    ctx.speech.trackMessage("session-1", "assistant", "final", "user-" + first, true)
    await Promise.resolve()
    expect(ctx.posts).toEqual([])
    ctx.speech.trackMessage("session-1", "assistant", "older", "user-" + first)
    ctx.speech.trackPart("session-1", {
      id: "part",
      messageID: "final",
      type: "text",
      text: "Final reply.",
      time: { start: 1, end: 2 },
    })
    await Promise.all([pending, duplicate])
    expect(ctx.posts).toHaveLength(1)
    expect(ctx.posts[0]).toMatchObject({ type: "speechPlaybackError", requestId: first })
    ctx.speech.trackPart("session-1", {
      id: "part",
      messageID: "final",
      type: "text",
      text: "Duplicate final.",
      time: { start: 1, end: 2 },
    })
    await ctx.speech.speakOnIdle("session-1", ctx.post)
    expect(ctx.posts).toHaveLength(1)
  } finally {
    ctx.speech.dispose()
    await ctx.speech.ended()
  }
})

test("Stop, disconnect and replacement retire original event waiters before late terminal snapshots", async () => {
  for (const mode of ["stop", "disconnect", "replacement"] as const) {
    const ctx = await harness()
    try {
      await ctx.mark(first)
      const pending = ctx.speech.speakOnIdle("session-1", ctx.post)
      if (mode === "stop") await ctx.send({ type: "speechPlaybackCancel", requestId: first })
      if (mode === "disconnect") {
        ctx.state.current = false
        ctx.speech.drop()
      }
      if (mode === "replacement") await ctx.mark(second)
      await pending
      ctx.speech.trackMessage("session-1", "assistant", "late", "user-" + first, true)
      ctx.speech.trackPart("session-1", {
        id: "late",
        messageID: "late",
        type: "text",
        text: "Retired reply.",
        time: { start: 1, end: 2 },
      })
      expect(ctx.posts).toEqual([])
      if (mode !== "replacement") continue
      ctx.reply("fresh")
      await ctx.speech.speakOnIdle("session-1", ctx.post)
      expect(ctx.posts).toEqual([
        { type: "speechPlaybackError", requestId: second, error: "Configure local speech in Speech settings." },
      ])
    } finally {
      ctx.speech.dispose()
      await ctx.speech.ended()
    }
  }
})

test("a busy status revokes earlier idle until the final assistant settles", async () => {
  const ctx = await harness()
  try {
    await ctx.mark(first)
    const pending = ctx.speech.speakOnIdle("session-1", ctx.post)
    ctx.speech.busy("session-1")
    ctx.reply("terminal")
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.posts).toEqual([])
    await Promise.all([pending, ctx.speech.speakOnIdle("session-1", ctx.post)])
    expect(ctx.posts).toHaveLength(1)
  } finally {
    ctx.speech.dispose()
    await ctx.speech.ended()
  }
})

test("a known ended empty final text retires without audio", async () => {
  const ctx = await harness()
  try {
    await ctx.mark(first)
    ctx.speech.trackMessage("session-1", "assistant", "empty", "user-" + first, true)
    ctx.speech.trackPart("session-1", {
      id: "empty",
      messageID: "empty",
      type: "text",
      text: " ",
      time: { start: 1, end: 2 },
    })
    await ctx.speech.speakOnIdle("session-1", ctx.post)
    expect(ctx.posts).toEqual([
      {
        type: "speechPlaybackError",
        requestId: first,
        error: "The Voice reply did not complete. Check the chat error and retry.",
      },
    ])
    expect(ctx.diagnostics.some((row) => row.phase === "start")).toBe(false)
  } finally {
    ctx.speech.dispose()
    await ctx.speech.ended()
  }
})
