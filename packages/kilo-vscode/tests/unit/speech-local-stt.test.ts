import { expect, test } from "bun:test"
import { transcribe } from "../../src/speech/openai-stt"

test("local transcription uses multipart Whisper and rejects redirects", async () => {
  let received = 0
  let forwarded = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/destination") {
        forwarded++
        return Response.json({ text: "must not be reached" })
      }
      received++
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-local-key")
      expect(await request.clone().text()).toMatch(/Content-Type: audio\/wav\r\n/i)
      const form = await request.formData()
      expect(form.get("model")).toBe("whisper-small.en")
      expect(form.get("file")).toBeInstanceOf(Blob)
      if (received === 2) return Response.redirect(`${server.url}destination`, 307)
      return Response.json({ text: "Raya local voice check complete." })
    },
  })
  const input = {
    endpoint: `${server.url}v1/audio/transcriptions`,
    key: "synthetic-local-key",
    model: "whisper-small.en",
    data: Buffer.from("synthetic audio payload").toString("base64"),
    format: "audio/wav",
    local: true,
  }
  try {
    expect(await transcribe(input)).toEqual({ ok: true, text: "Raya local voice check complete." })
    expect(await transcribe(input)).toEqual({ ok: false, error: "Local transcription request failed." })
    expect(forwarded).toBe(0)
    expect(await transcribe({ ...input, endpoint: "https://example.com/v1/audio/transcriptions" })).toEqual({
      ok: false,
      error: "Invalid local transcription request.",
    })
    expect(await transcribe({ ...input, model: "cloud-model" })).toEqual({
      ok: false,
      error: "Invalid local transcription request.",
    })
    expect(received).toBe(2)
  } finally {
    await server.stop(true)
  }
})

test("local transcription bounds response bytes and never surfaces service error bodies", async () => {
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      if (calls === 1) return new Response("x".repeat(262_145))
      return Response.json({ error: "private service content" }, { status: 503 })
    },
  })
  const input = {
    endpoint: `${server.url}v1/audio/transcriptions`,
    key: "synthetic",
    model: "whisper-small.en",
    data: "AA==",
    format: "audio/wav",
    local: true,
  }
  try {
    expect(await transcribe(input)).toEqual({ ok: false, error: "Local transcription request failed." })
    expect(await transcribe(input)).toEqual({
      ok: false,
      error: "Local transcription failed with status 503.",
      code: undefined,
    })
  } finally {
    await server.stop(true)
  }
})

test("local 422 maps only exact safe codes and keeps authentication precedence", async () => {
  const responses = [
    { status: 422, error: { code: "empty_transcript", message: "private diagnostic" } },
    { status: 422, error: { code: "inference_failed", message: "private path" } },
    { status: 422, error: { code: "unknown", message: "private content" } },
    { status: 401, error: { code: "empty_transcript", message: "private content" } },
  ]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const value = responses.shift()!
      return Response.json({ error: value.error }, { status: value.status })
    },
  })
  const input = {
    endpoint: `${server.url}v1/audio/transcriptions`,
    key: "synthetic",
    model: "whisper-small.en",
    data: "AA==",
    format: "audio/wav",
    local: true,
  }
  try {
    expect(await transcribe(input)).toEqual({ ok: false, error: "No speech was detected.", code: "empty_transcript" })
    expect(await transcribe(input)).toEqual({
      ok: false,
      error: "Local transcription failed. Try recording again.",
      code: "inference_failed",
    })
    expect(await transcribe(input)).toEqual({
      ok: false,
      error: "Local transcription failed with status 422.",
      code: undefined,
    })
    expect(await transcribe(input)).toEqual({
      ok: false,
      error: "Local transcription failed with status 401.",
      code: "not_authenticated",
    })
  } finally {
    await server.stop(true)
  }
})
