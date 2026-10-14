import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { Effect, Result, Schema } from "effect"
import type * as Tool from "@/tool/tool"
import type { MessageV2 } from "@/session/message-v2"
import { command as original, Params, requested } from "./management"
import type { ManageSource } from "./management-protocol"

const key = "raya.memory.commandRefusal"
const intent =
  "Please send a new explicit personal Memory request, such as 'Remember this: I prefer tea', 'Update my drink preference to coffee', or 'Forget my drink preference'. No Memory change was requested from this wording."

function reason(error: unknown) {
  if (!(error instanceof Error)) return undefined
  if (error.message === intent) return "intent" as const
  if (error.message === "The fact must match the exact original user span") return "fact" as const
  if (error.message === "The target must match the original request") return "target" as const
  return undefined
}

function stamp(source: ManageSource, args: typeof Params.Type, call: string, error: unknown) {
  const code = reason(error)
  if (!code) return undefined
  return {
    version: 1,
    sessionID: source.sessionID,
    messageID: source.messageID,
    source_sha256: source.source_sha256,
    callID: call,
    input_sha256: createHash("sha256")
      .update(JSON.stringify([args.action, args.text ?? null, args.query ?? null]))
      .digest("hex"),
    reason: code,
  }
}

/** Unsupported personal change wording may ask for clarification; unrelated work retains its original route. */
function personal(text: string) {
  const body = text.trim().replace(/^(?:please |(?:can|could) you (?:please )?)/i, "")
  if (/^(?:remember(?: this| that)?|forget(?: this| that)?)[.!:]?$/i.test(body)) return true
  return (
    /^(?:write|add|jot(?: down)?|record|note) (?:this )?(?:in|into|to) (?:my personal (?:memory|SecondBrain)|my SecondBrain|my Raya project Memory):\s*[^.!?;`]+[.]?$/i.test(
      body,
    ) && !/\b(?:then|also|and (?:install|deploy|run|buy|delete|control|change))\b/i.test(body)
  )
}

/** Only the local command boundary, before any host request, may produce this marker. */
export const command = Effect.fn("SecondBrain.refusal.command")(function* (
  source: ManageSource,
  args: typeof Params.Type,
  ctx: Pick<Tool.Context, "callID" | "metadata">,
) {
  try {
    return original(source, args)
  } catch (err) {
    const marker = ctx.callID ? stamp(source, args, ctx.callID, err) : undefined
    if (marker) yield* ctx.metadata({ metadata: { [key]: marker } })
    throw err
  }
})

/** Recompute every refusal against today's exact original projection; never infer host failure authority. */
export function current(messages: readonly MessageV2.WithParts[], source: ManageSource, project: string) {
  const failures = []
  const calls = new Set<string>()
  for (const row of messages) {
    if (row.info.role !== "assistant" || row.info.parentID !== source.messageID) continue
    if (
      row.info.sessionID !== source.sessionID ||
      row.info.agent !== "auto" ||
      row.info.error ||
      row.info.summary ||
      path.resolve(row.info.path.cwd) !== path.resolve(project)
    )
      return undefined
    for (const part of row.parts) {
      if (part.type !== "tool") continue
      if (
        part.tool !== "second_brain_manage" ||
        part.sessionID !== source.sessionID ||
        part.messageID !== row.info.id ||
        part.state.status !== "error"
      )
        return undefined
      if (calls.has(part.callID)) return undefined
      calls.add(part.callID)
      const args = Schema.decodeUnknownResult(Params, { onExcessProperty: "error" })(part.state.input)
      if (Result.isFailure(args)) return undefined
      const err = (() => {
        try {
          original(source, args.success)
        } catch (error) {
          return error
        }
        return undefined
      })()
      const marker = stamp(source, args.success, part.callID, err)
      if (
        !marker ||
        !(err instanceof Error) ||
        part.state.error !== err.message ||
        !isDeepStrictEqual(part.state.metadata?.[key], marker)
      )
        return undefined
      failures.push(marker)
    }
  }
  if (!failures.length) return undefined
  return {
    mode: requested(source.text)
      ? failures.length > 1
        ? ("clarify" as const)
        : ("repair" as const)
      : personal(source.text)
        ? ("clarify" as const)
        : ("route" as const),
    source_sha256: source.source_sha256,
    count: failures.length,
  }
}

export function instruction(state: NonNullable<ReturnType<typeof current>>) {
  if (state.mode === "route")
    return "The personal Memory tool was selected incorrectly and refused locally before dispatch. Continue the SAME complete original user request using chief_route. Do not call second_brain_manage again, ask for replacement Memory permission, invent personal facts, or claim a Memory change. Original work and Goal gates remain required."
  if (state.mode === "repair")
    return "The personal Memory command was refused locally before dispatch. Make at most one repair using second_brain_manage with only the correct action derived from the unchanged original user request. Omit text and query rather than paraphrasing them. No other tool, new intent, publication claim, or Goal completion is authorized."
  return "The personal Memory command was refused locally before dispatch. Give one brief final clarification explaining that no Memory change was made and ask for a new explicit remember, correct, or forget request with the intended fact or target. Do not call any more tools, paraphrase a fact into authority, claim publication or indexing, or complete a Goal."
}
