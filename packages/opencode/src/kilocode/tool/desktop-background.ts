import { Effect, Schema } from "effect"
import { Desktop } from "@/kilocode/desktop/service"
import { BackgroundRole, SelectedWindowTarget } from "@/kilocode/desktop/protocol"
import { ActionClassification } from "@/kilocode/computer-use/lease"
import * as Tool from "@/tool/tool"
import { approve, run } from "./desktop-host"

const Params = Schema.Struct({ target: SelectedWindowTarget })
const Action = Schema.Struct({
  target: SelectedWindowTarget,
  action: Schema.Literals(["click", "set_value"]),
  role: BackgroundRole,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description: "Exact accessible name from a fresh background snapshot of the selected window.",
  }),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(16_384))),
  sensitive_category: ActionClassification,
}).check(
  Schema.makeFilter((input) => {
    if (input.action === "click") return input.value === undefined ? undefined : "Value is only valid for set_value"
    if (input.role === "textfield" && input.value !== undefined) return
    return "Set value needs a textfield and explicit value"
  }),
)

const snapshot = Tool.define<typeof Params, {}, Desktop.Service, "desktop_background_snapshot">(
  "desktop_background_snapshot",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Read the accessibility tree of one exact selected Windows window without activating it or moving the user's pointer. Requires the existing Computer Use grant. Use the observed exact role and name for a background action.",
      parameters: Params,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const authorization = yield* approve(desktop, ctx, {
            action: "observe",
            windowID: params.target.windowID,
            target: params.target,
            permission: "desktop_background_snapshot",
            patterns: [params.target.windowID],
            always: [],
            metadata: {},
          })
          const result = yield* run(
            desktop,
            {
              operation: "background_snapshot",
              sessionID: ctx.sessionID,
              target: params.target,
              authorization,
            },
            ctx.abort,
          )
          if (result.operation !== "background_snapshot")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return { title: "Background desktop snapshot", output: JSON.stringify(result), metadata: {} }
        }),
    }
  }),
)

const action = Tool.define<typeof Action, {}, Desktop.Service, "desktop_background_action">(
  "desktop_background_action",
  Effect.gen(function* () {
    const desktop = yield* Desktop.Service
    return {
      description:
        "Invoke one control or set one textfield in the exact selected Windows window using its observed role and name. Uses only background accessibility delivery; never activates a window or sends physical input. Read the delivery receipt and fresh readback before continuing. Never automatically replay a possibly delivered action.",
      parameters: Action,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const sensitive = params.sensitive_category === "ordinary" ? false : params.sensitive_category
          const authorization = yield* approve(desktop, ctx, {
            action: params.action === "click" ? "pointer" : "keyboard",
            windowID: params.target.windowID,
            target: params.target,
            sensitive,
            permission: "desktop_background_action",
            patterns: [`${params.target.windowID}/${params.action}/${params.role}/${params.name}`],
            always: [],
            metadata: { action: params.action, role: params.role, name: params.name },
          })
          const base = {
            operation: "background_action" as const,
            sessionID: ctx.sessionID,
            target: params.target,
            name: params.name,
            sensitive,
            authorization,
          } as const
          const result = yield* run(
            desktop,
            params.action === "click"
              ? { ...base, action: "click", role: params.role }
              : { ...base, action: "set_value", role: "textfield", value: params.value! },
            ctx.abort,
          )
          if (result.operation !== "background_action")
            return yield* Effect.die(new Error("Desktop host returned the wrong result"))
          return { title: "Background desktop action receipt", output: JSON.stringify(result), metadata: {} }
        }),
    }
  }),
)

export const DesktopBackgroundTools = [snapshot, action]
