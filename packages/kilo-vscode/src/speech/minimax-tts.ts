// raya_change - Milestone H low-latency MiniMax streaming TTS client
import WebSocket from "ws"

export type TtsInput = {
  id: string
  endpoint: string
  key: string
  model: string
  voice: string
  text: string
}

export type TtsResult = {
  firstAudioMs: number
  chunks: number
  bytes: number
}

type Sink = {
  chunk: (data: string, mime: string) => void
  done: (result: TtsResult) => void
  error: (error: string) => void
}

type Reply = {
  event?: string
  is_final?: boolean
  data?: { audio?: string }
  base_resp?: { status_code?: number; status_msg?: string }
}

export class MiniMaxTts {
  private readonly sockets = new Map<string, WebSocket>()

  speak(input: TtsInput, sink: Sink): void {
    this.cancel(input.id)
    const stats = { firstAudioMs: 0, chunks: 0, bytes: 0 }
    const timing = { requested: 0 }
    const socket = new WebSocket(input.endpoint, { headers: { Authorization: `Bearer ${input.key}` } })
    this.sockets.set(input.id, socket)
    const timer = setTimeout(() => fail("MiniMax TTS did not respond within 20 seconds."), 20_000)
    const finish = () => {
      clearTimeout(timer)
      if (this.sockets.get(input.id) === socket) this.sockets.delete(input.id)
    }
    const close = () => {
      finish()
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
    const fail = (message: string) => {
      close()
      sink.error(message)
    }

    socket.on("message", (raw) => {
      const reply = parse(raw.toString())
      if (!reply) return fail("MiniMax TTS returned invalid JSON.")
      const code = reply.base_resp?.status_code
      if (typeof code === "number" && code !== 0)
        return fail(reply.base_resp?.status_msg || `MiniMax TTS failed with status ${code}.`)
      if (reply.event === "connected_success") {
        socket.send(
          JSON.stringify({
            event: "task_start",
            model: input.model,
            voice_setting: {
              voice_id: input.voice,
              speed: 1,
              vol: 1,
              pitch: 0,
              english_normalization: false,
            },
            audio_setting: {
              sample_rate: 16_000,
              format: "pcm", // raya_change - raw PCM streams reliably in VS Code webviews without MSE codec support
              channel: 1,
            },
          }),
        )
        return
      }
      if (reply.event === "task_started") {
        timing.requested = performance.now()
        socket.send(JSON.stringify({ event: "task_continue", text: input.text }))
        return
      }
      const audio = reply.data?.audio
      if (audio) {
        const bytes = Buffer.from(audio, "hex")
        if (stats.chunks === 0) stats.firstAudioMs = Math.max(0, performance.now() - timing.requested)
        stats.chunks++
        stats.bytes += bytes.length
        sink.chunk(bytes.toString("base64"), "audio/pcm;rate=16000")
      }
      if (!reply.is_final) return
      socket.send(JSON.stringify({ event: "task_finish" }))
      finish()
      sink.done(stats)
    })
    socket.on("error", (err) => fail(err.message))
    socket.on("close", () => {
      if (this.sockets.get(input.id) !== socket) return
      finish()
      if (stats.chunks === 0) sink.error("MiniMax TTS closed before returning audio.")
    })
  }

  cancel(id?: string): void {
    const entries = id ? ([[id, this.sockets.get(id)]] as const) : [...this.sockets.entries()]
    for (const [key, socket] of entries) {
      if (!socket) continue
      this.sockets.delete(key)
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: "task_finish" }))
      socket.close()
    }
  }

  dispose(): void {
    this.cancel()
  }
}

function parse(value: string): Reply | undefined {
  try {
    return JSON.parse(value) as Reply
  } catch (err) {
    console.error("[Kilo New] MiniMax TTS response parsing failed:", err)
    return undefined
  }
}
