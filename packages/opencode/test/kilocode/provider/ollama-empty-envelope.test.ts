import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import * as OllamaPrompt from "@/kilocode/provider/ollama-prompt"

const cfg = { localInference: true, localInferenceAPI: "ollama", localInferenceToolFormat: "completion-envelope-v1" }

for (const stream of [false, true]) {
  test(`empty terminal text refuses instead of a silent successful ${stream ? "stream" : "response"}`, async () => {
    const state = { text: "", posts: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = await req.json()
        state.posts++
        expect(body.format).toEqual(ToolEnvelope.schema([], "none"))
        return new Response(
          JSON.stringify({
            model: "fixture",
            message: { role: "assistant", content: JSON.stringify({ kind: "text", content: state.text }) },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 5582,
            eval_count: 9,
          }) + (stream ? "\n" : ""),
        )
      },
    })
    const send = () =>
      ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Thanks, Raya." }], stream }),
      })
    try {
      for (const text of ["", " \n\t"]) {
        state.text = text
        state.posts = 0
        const err = await send().then(
          () => undefined,
          (err: unknown) => err,
        )
        expect(err).toBeInstanceOf(OllamaBridgeError)
        if (!(err instanceof OllamaBridgeError)) throw new Error("Empty envelope was accepted")
        expect(err.isRetryable).toBe(false)
        expect(err.diagnostic).toMatchObject({ reason: "empty-text", finish: "stop", eval: 9 })
        expect(state.posts).toBe(2)
      }
      state.text = "  You're welcome.\n"
      const raw = await (await send()).text()
      const value = stream ? JSON.parse(raw.split("\n")[0].slice(6)) : JSON.parse(raw)
      expect(value.choices[0][stream ? "delta" : "message"].content).toBe(state.text)
    } finally {
      await server.stop()
    }
  })
}

for (const stream of [false, true]) {
  test(`one completed empty reply receives one fresh corrected ${stream ? "stream" : "response"}`, async () => {
    const state = { posts: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = await req.json()
        state.posts++
        expect(body.model).toBe("fixture")
        if (state.posts === 2) {
          expect(body.messages.at(-1)).toMatchObject({ role: "system" })
          expect(body.messages.at(-1).content).toContain("nonempty content")
          expect(
            body.messages.some(
              (row: { role: string; content: string }) => row.role === "user" && row.content === "Thanks, Raya.",
            ),
          ).toBe(true)
        }
        return new Response(
          JSON.stringify({
            model: "fixture",
            message: {
              role: "assistant",
              content: JSON.stringify({ kind: "text", content: state.posts === 1 ? "" : "  You're welcome.\n" }),
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 4000,
            eval_count: 13,
          }) + (stream ? "\n" : ""),
        )
      },
    })
    try {
      const response = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Thanks, Raya." }], stream }),
      })
      const raw = await response.text()
      const value = stream ? JSON.parse(raw.split("\n")[0].slice(6)) : JSON.parse(raw)
      expect(value.choices[0][stream ? "delta" : "message"].content).toBe("  You're welcome.\n")
      expect(state.posts).toBe(2)
    } finally {
      await server.stop()
    }
  })
}

test("correction checks the actual context before another native POST", async () => {
  const messages = [{ role: "user" as const, content: "Thanks, Raya." }]
  const context = OllamaPrompt.measure(OllamaPrompt.project(messages, [], true), []).normalized + 16
  const state = { posts: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.posts++
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: JSON.stringify({ kind: "text", content: "" }) },
        done: true,
        done_reason: "stop",
      })
    },
  })
  try {
    expect(
      await refused(
        ollama({ ...cfg, ollamaContext: context }, fetch)(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ model: "fixture", messages, max_tokens: 16 }),
        }),
      ),
    ).toBeInstanceOf(OllamaPrompt.OllamaWindowError)
    expect(state.posts).toBe(1)
  } finally {
    await server.stop()
  }
})

test("malformed native content is refused without correction", async () => {
  const state = { posts: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.posts++
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: '{"kind":"text","content":"","extra":true}' },
        done: true,
        done_reason: "stop",
      })
    },
  })
  try {
    expect(
      await refused(
        ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Thanks" }] }),
        }),
      ),
    ).toBeInstanceOf(OllamaBridgeError)
    expect(state.posts).toBe(1)
  } finally {
    await server.stop()
  }
})

test("an empty terminal frame without original EOF never starts correction", async () => {
  const state = { posts: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.posts++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  model: "fixture",
                  message: { role: "assistant", content: '{"kind":"text","content":""}' },
                  done: true,
                  done_reason: "stop",
                }) + "\n",
              ),
            )
          },
        }),
      )
    },
  })
  try {
    expect(
      await refused(
        ollama({ ...cfg, timeout: 50 }, fetch)(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Thanks" }], stream: true }),
        }),
      ),
    ).toBeInstanceOf(OllamaBridgeError)
    expect(state.posts).toBe(1)
  } finally {
    await server.stop(true)
  }
})

test("caller cancellation forbids another native correction POST", async () => {
  const ctrl = new AbortController()
  const state = { posts: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.posts++
      queueMicrotask(() => ctrl.abort())
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: '{"kind":"text","content":""}' },
        done: true,
        done_reason: "stop",
      })
    },
  })
  try {
    const result = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Thanks" }] }),
    }).then(
      () => false,
      () => true,
    )
    expect(result).toBe(true)
    expect(state.posts).toBe(1)
  } finally {
    await server.stop(true)
  }
})

test("unsuccessful correction drains its original error body and never repeats", async () => {
  const state = { posts: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.posts++
      if (state.posts === 2) return Response.json({ error: "Unavailable" }, { status: 503 })
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: '{"kind":"text","content":""}' },
        done: true,
        done_reason: "stop",
      })
    },
  })
  try {
    expect(
      await refused(
        ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Thanks" }] }),
        }),
      ),
    ).toBeInstanceOf(OllamaBridgeError)
    expect(state.posts).toBe(2)
  } finally {
    await server.stop()
  }
})

function refused(operation: Promise<unknown>) {
  return operation.then(
    () => {
      throw new Error("Expected the original request to be refused.")
    },
    (err: unknown) => err,
  )
}
