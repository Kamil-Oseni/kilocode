// raya_change - Milestone H streaming TTS latency contract
import { afterAll, describe, expect, it } from "bun:test"
import { WebSocketServer } from "ws"
import { MiniMaxTts, type TtsResult } from "../../src/speech/minimax-tts"

const server = new WebSocketServer({ port: 0 })
await new Promise<void>((resolve) => server.once("listening", resolve))
server.on("connection", (socket, request) => {
  if (request.headers.authorization !== "Bearer funded-test-key") return socket.close()
  socket.send(JSON.stringify({ event: "connected_success", base_resp: { status_code: 0 } }))
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { event: string; model?: string; text?: string }
    if (message.event === "task_start") {
      expect(message.model).toBe("speech-2.6-turbo")
      socket.send(JSON.stringify({ event: "task_started", base_resp: { status_code: 0 } }))
    }
    if (message.event === "task_continue") {
      socket.send(
        JSON.stringify({
          event: "task_continued",
          data: { audio: Buffer.from("streaming-audio").toString("hex") },
          is_final: true,
          base_resp: { status_code: 0 },
        }),
      )
    }
  })
})

afterAll(() => server.close())

describe("MiniMax TTS latency", () => {
  it("streams the turbo model's first audio chunk under 250 ms", async () => {
    const port = (server.address() as { port: number }).port
    const client = new MiniMaxTts()
    const chunks: string[] = []
    const result = await new Promise<TtsResult>((resolve, reject) => {
      client.speak(
        {
          id: "latency",
          endpoint: `ws://127.0.0.1:${port}`,
          key: "funded-test-key",
          model: "speech-2.6-turbo",
          voice: "English_Graceful_Lady",
          text: "Raya is ready.",
        },
        {
          chunk: (data) => chunks.push(data),
          done: resolve,
          error: (error) => reject(new Error(error)),
        },
      )
    })
    client.dispose()

    expect(result.firstAudioMs).toBeLessThan(250)
    expect(result.chunks).toBe(1)
    expect(Buffer.from(chunks[0]!, "base64").toString()).toBe("streaming-audio")
  })
})
