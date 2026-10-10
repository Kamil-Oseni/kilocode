import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"

const cfg = { localInference: true, localInferenceAPI: "ollama", localInferenceToolFormat: "completion-envelope-v1" }

for (const stream of [false, true]) {
  test(`empty terminal text refuses instead of a silent successful ${stream ? "stream" : "response"}`, async () => {
    const state = { text: "" }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = await req.json()
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
        const err = await send().then(
          () => undefined,
          (err: unknown) => err,
        )
        expect(err).toBeInstanceOf(OllamaBridgeError)
        if (!(err instanceof OllamaBridgeError)) throw new Error("Empty envelope was accepted")
        expect(err.isRetryable).toBe(false)
        expect(err.diagnostic).toMatchObject({ reason: "envelope-validation", finish: "stop", eval: 9 })
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
