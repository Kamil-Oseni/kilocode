// raya_change - Milestone E model-facing canvas tools
import { Canvas, HostError } from "@/kilocode/canvas/service"
import type { Input } from "@/kilocode/canvas/service"
import { Data } from "@/kilocode/canvas/protocol"
import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
  description: "Stable kebab-case canvas name without a file extension.",
})
const Source = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000)).annotate({
  description:
    "React TSX source with one default-exported component receiving a data prop. Use JSX directly and do not import packages; React and common hooks are already in scope.",
})

function abort(signal: AbortSignal) {
  return Effect.callback<never, HostError>((resume) => {
    const err = () => new HostError({ code: "cancelled", detail: "The canvas tool call was cancelled" })
    if (signal.aborted) return resume(Effect.fail(err()))
    const handler = () => resume(Effect.fail(err()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
}

function run(canvas: Canvas.Interface, input: Input, signal: AbortSignal) {
  return canvas.request(input).pipe(Effect.raceFirst(abort(signal)), Effect.orDie)
}

const CreateParams = Schema.Struct({
  name: Name,
  source: Source,
  data: Schema.optional(Data).annotate({
    description: "JSON-compatible data passed to the component as its data prop.",
  }),
})
export const CreateCanvasTool = Tool.define<
  typeof CreateParams,
  { path: string; status: "ready" | "error"; version: number; error?: string },
  Canvas.Service,
  "create_canvas"
>(
  "create_canvas",
  Effect.gen(function* () {
    const canvas = yield* Canvas.Service
    return {
      description:
        "Create and open a live React canvas beside chat for dashboards, analyses, tables, charts, or interactive artifacts. Provide a default-exported TSX component that receives current host data through its data prop. React, useState, useEffect, useMemo, useCallback, and useRef are already in scope. Compilation and runtime errors are returned and remain visible in the panel so the next update can repair them.",
      parameters: CreateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "create_canvas", patterns: [params.name], always: [params.name], metadata: {} })
          const result = yield* run(
            canvas,
            {
              operation: "create",
              sessionID: ctx.sessionID,
              name: params.name,
              source: params.source,
              data: params.data ?? {},
            },
            ctx.abort,
          )
          return {
            title: result.status === "ready" ? `Canvas ready: ${result.name}` : `Canvas needs repair: ${result.name}`,
            output:
              result.status === "ready"
                ? `Rendered ${result.path} at version ${result.version}.`
                : `Canvas error in ${result.path}:\n${result.error ?? "Unknown canvas error"}`,
            metadata: {
              path: result.path,
              status: result.status,
              version: result.version,
              error: result.error,
            },
          }
        }),
    }
  }),
)

const UpdateParams = Schema.Struct({
  name: Name,
  source: Schema.optional(Source),
  data: Schema.optional(Data).annotate({
    description: "Replacement JSON-compatible data for the component data prop.",
  }),
})
export const UpdateCanvasTool = Tool.define<
  typeof UpdateParams,
  { path: string; status: "ready" | "error"; version: number; error?: string },
  Canvas.Service,
  "update_canvas"
>(
  "update_canvas",
  Effect.gen(function* () {
    const canvas = yield* Canvas.Service
    return {
      description:
        "Update an existing live canvas source, its typed data payload, or both. The open panel refreshes automatically; use the returned compile or runtime error to repair the artifact without reopening it.",
      parameters: UpdateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          if (params.source === undefined && params.data === undefined)
            return yield* Effect.die(new Error("update_canvas requires source, data, or both"))
          yield* ctx.ask({ permission: "update_canvas", patterns: [params.name], always: [params.name], metadata: {} })
          const result = yield* run(
            canvas,
            {
              operation: "update",
              sessionID: ctx.sessionID,
              name: params.name,
              source: params.source,
              data: params.data,
            },
            ctx.abort,
          )
          return {
            title: result.status === "ready" ? `Canvas updated: ${result.name}` : `Canvas needs repair: ${result.name}`,
            output:
              result.status === "ready"
                ? `Rendered ${result.path} at version ${result.version}.`
                : `Canvas error in ${result.path}:\n${result.error ?? "Unknown canvas error"}`,
            metadata: {
              path: result.path,
              status: result.status,
              version: result.version,
              error: result.error,
            },
          }
        }),
    }
  }),
)

export const CanvasTools = [CreateCanvasTool, UpdateCanvasTool]
