import type { DraftCapture } from "../../../src/shared/composer-drafts-messages"
import type { ReviewMessageData } from "../../../src/shared/review-comments"
import type {
  FileAttachment,
  ModelSelection,
  QuestionRequest,
  SuggestionRequest,
  WebviewMessage,
} from "../types/messages"
import { Identifier } from "../utils/id"

/** Keep each send bound to its captured origin and exact durable draft receipt. */
export function createMessageSender(opts: {
  connected(): boolean
  current(): string | undefined
  selected(id?: string): ModelSelection | null
  usage(provider?: string, model?: string): void
  preview(): string | null
  continuation(id: string): string | undefined
  agent(id?: string): string | undefined
  variant(id?: string): string | undefined
  post(message: WebviewMessage): void
  suggestions(id?: string): SuggestionRequest[]
  questions(id?: string): QuestionRequest[]
  dismissSuggestion(id: string): void
  dismissQuestion(id: string): void
  seed(id: string): void
  prepare(scope: string, message: string, text: string, files?: FileAttachment[], review?: ReviewMessageData): void
  activate(scope: string): void
  draft(): string | undefined
}) {
  function stage(
    sid: string | undefined,
    draftID: string | undefined,
    messageID: string,
    text: string,
    files?: FileAttachment[],
    review?: ReviewMessageData,
  ) {
    const draft = !sid && !draftID ? crypto.randomUUID() : draftID
    const scope = draft ?? sid
    if (!sid && !draftID && draft) opts.seed(draft)
    if (scope) {
      opts.prepare(scope, messageID, text, files, review)
      if (!sid && (!draftID || opts.draft() === scope)) opts.activate(scope)
    }
    return { draft, scope }
  }

  return function sendMessage(
    text: string,
    providerID?: string,
    modelID?: string,
    files?: FileAttachment[],
    draftID?: string,
    context?: string,
    review?: ReviewMessageData,
    origin?: string | null,
    capture?: DraftCapture,
  ) {
    if (!opts.connected()) {
      console.warn("[Raya] Cannot send message: not connected")
      return
    }
    const messageID = Identifier.ascending("message")
    const sid = origin === undefined ? opts.current() : (origin ?? undefined)
    const selection = providerID && modelID ? { providerID, modelID } : opts.selected(sid)
    opts.usage(selection?.providerID, selection?.modelID)
    const preview = sid?.startsWith("cloud:")
      ? sid.slice("cloud:".length)
      : origin === undefined
        ? opts.preview()
        : null
    if (preview) {
      const scope = draftID ?? sid
      const agent = opts.agent(scope)
      opts.post({
        type: "importAndSend",
        cloudSessionId: preview,
        continuationID: opts.continuation(preview),
        text,
        messageID,
        providerID,
        modelID,
        agent,
        variant: opts.variant(scope),
        files,
        review,
      })
      return
    }
    const suggestion = opts.suggestions(sid)[0]
    if (suggestion) opts.dismissSuggestion(suggestion.id)
    for (const question of opts.questions(sid)) opts.dismissQuestion(question.id)
    const staged = stage(sid, draftID, messageID, text, files, review)
    const agent = opts.agent(staged.scope)
    opts.post({
      type: "sendMessage",
      capture,
      text,
      messageID,
      sessionID: sid,
      draftID: staged.draft,
      providerID,
      modelID,
      agent,
      variant: opts.variant(staged.scope),
      files,
      review,
      agentManagerContext: context,
    })
  }
}
