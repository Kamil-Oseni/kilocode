// raya_change - model-facing native desktop observation tool
import { Desktop, HostError, type Input } from "@/kilocode/desktop/service"
import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"

function abort(signal: AbortSignal) {
  return Effect.callback<never, HostError>((resume) => {
    const err = () => new HostError({ code: "cancelled", detail: "The desktop observation was cancelled" })
    if (signal.aborted) return resume(Effect.fail(err()))
    const handler = () => resume(Effect.fail(err()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
}

function run(desktop: Desktop.Interface, input: Input, signal: AbortSignal) {
  return desktop.request(input).pipe(Effect.raceFirst(abort(signal)), Effect.orDie)
}

const Params = Schema.Struct({})
export const DesktopObserveTool = Tool.define<typeof Params, { mime: string }, Desktop.Service, "desktop_observe">(
  "desktop_observe",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Capture the current foreground Windows application as an image visible to the model. Use it to inspect the desktop before any future desktop action; it does not send input.",
      parameters: Params,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "desktop_observe", patterns: ["foreground-window"], always: [], metadata: {} })
          const result = yield* run(desktop, { operation: "observe", sessionID: ctx.sessionID }, ctx.abort)
          const summary = {
            width: result.width,
            height: result.height,
            observation: result.observation,
            receipt: result.receipt,
          }
          return {
            title: "Desktop observation",
            output: JSON.stringify(summary, undefined, 2),
            metadata: { mime: result.mime },
            attachments: [
              {
                type: "file" as const,
                mime: result.mime,
                filename: result.mime === "image/png" ? "desktop.png" : "desktop.jpg",
                url: `data:${result.mime};base64,${result.data}`,
              },
            ],
          }
        }),
    }
  }),
)

export const DesktopTools = [DesktopObserveTool]
