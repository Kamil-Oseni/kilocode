import { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import { RayaChief } from "../chief"
import { localConfig } from "../provider/local-scheduler"
import { Refusal } from "../session/tool-refusal"

function restricted(request: string | undefined) {
  const text =
    request
      ?.replace(/(```|~~~)[\s\S]*?\1/g, "")
      .replace(/^\s*>.*$/gm, "")
      .replace(/"[^"\r\n]*"|`[^`\r\n]*`|'[^'\r\n]*'|“[^”\r\n]*”|‘[^’\r\n]*’/g, "") ?? ""
  return /(?:^|[\n.!?;,])\s*no\s+cloud(?:\s+(?:workers?|models?|providers?))?(?=\s*(?:[.!?;,:]|$))/i.test(text)
}

/** Enforce an explicit current root Auto restriction before any Task child is produced. */
export function check(input: {
  sessions: Pick<Session.Interface, "get" | "messages">
  provider: Pick<Provider.Interface, "getProvider">
  sessionID: SessionID
  messageID: MessageID
  agent: string
  providerID: ProviderV2.ID
}) {
  return Effect.gen(function* () {
    if (input.agent !== "auto") return
    const parent = yield* input.sessions.get(input.sessionID)
    if (parent.parentID || parent.metadata?.rayaRoutine !== undefined) return
    const rows = yield* input.sessions.messages({ sessionID: input.sessionID })
    const user = rows.findLast((row) => row.info.role === "user")
    const owner = user ? RayaChief.requestText(user.parts) : undefined
    const request = RayaChief.request(parent.metadata)
    if (!restricted(owner) && !restricted(request)) return
    const assistant = rows.find((row) => row.info.id === input.messageID)
    if (
      user?.info.role !== "user" ||
      user.info.sessionID !== input.sessionID ||
      user.info.agent !== "auto" ||
      !owner ||
      owner !== request ||
      assistant?.info.role !== "assistant" ||
      assistant.info.agent !== "auto" ||
      assistant.info.sessionID !== input.sessionID ||
      assistant.info.parentID !== user.info.id
    )
      yield* Effect.fail(
        new Refusal(
          "task-access",
          "The local-only Task restriction no longer matches the current owner request. No worker was started.",
        ),
      )
    const provider = yield* input.provider.getProvider(input.providerID)
    if (!provider || !localConfig(provider.options).enabled)
      yield* Effect.fail(
        new Refusal(
          "task-access",
          "The current owner request forbids cloud workers. The selected worker provider is not explicitly configured for local inference. No worker was started; do not replace the saved model or start another cloud worker.",
        ),
      )
  })
}
