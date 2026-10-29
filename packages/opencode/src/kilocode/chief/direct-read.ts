import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Tool } from "@/tool/tool"
import { inspectionFile } from "../task/request"
import { Refusal } from "../session/tool-refusal"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")

/** Bind the actual executing assistant to its persisted owner; never grant Read permission. */
export const guard = Effect.fn("DirectRead.guard")(function* (
  ctx: Tool.Context,
  file: string,
  fs: FSUtil.Interface,
): Effect.fn.Return<Effect.Effect<void, unknown> | undefined, unknown> {
  if (ctx.agent !== "auto") return undefined
  const module = yield* Effect.promise(() => import("@/session/session"))
  const selected = yield* Effect.serviceOption(module.Session.Service)
  if (Option.isNone(selected)) return yield* Effect.fail(new Error("Direct Read owner service is unavailable."))
  const sessions = selected.value
  const session = yield* sessions.get(ctx.sessionID)
  if (session.parentID || session.metadata?.rayaRoutine !== undefined) return undefined
  const rows = yield* sessions.messages({ sessionID: ctx.sessionID })
  const assistant = rows.find((row) => row.info.id === ctx.messageID)
  if (
    !assistant ||
    assistant.info.role !== "assistant" ||
    assistant.info.agent !== "auto" ||
    assistant.info.sessionID !== ctx.sessionID
  )
    return yield* Effect.fail(new Error("Direct Read executing assistant is unavailable."))
  const parent = assistant.info.parentID
  const source = rows.find((row) => row.info.id === parent)
  if (!source || source.info.role !== "user" || source.info.sessionID !== ctx.sessionID)
    return yield* Effect.fail(new Error("Direct Read original owner is unavailable."))
  const text = source.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim()
  const target = inspectionFile(text)
  if (!target) return undefined
  const hash = digest(text)
  const key = process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)
  if (!path.isAbsolute(file) || key !== target)
    return yield* Effect.fail(new Refusal("chief-work-class", "Read only the single file named by the current owner."))
  const verify = Effect.gen(function* () {
    const current = yield* sessions.get(ctx.sessionID)
    const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
    const latest = messages.findLast((row) => row.info.role === "user")
    const executing = messages.find((row) => row.info.id === ctx.messageID)
    const request = latest?.parts
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim()
    if (
      latest?.info.id !== parent ||
      !request ||
      digest(request) !== hash ||
      current.parentID ||
      current.metadata?.rayaRoutine !== undefined ||
      current.metadata?.["raya.chief.request"] !== text ||
      (current.metadata?.["raya.chief.phase"] ?? "route") !== "route" ||
      executing?.info.role !== "assistant" ||
      executing.info.parentID !== parent ||
      executing.info.agent !== "auto"
    )
      return yield* Effect.fail(
        new Refusal("chief-work-class", "The original direct Read owner changed; use the current request."),
      )
    return undefined
  })
  yield* verify
  if ((yield* fs.stat(file)).type !== "File")
    return yield* Effect.fail(
      new Refusal("chief-work-class", "The direct Read target must be a file, not a directory."),
    )
  return verify
})
