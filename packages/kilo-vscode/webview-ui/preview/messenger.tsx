import type { Component } from "solid-js"
import { MarkedProvider } from "@kilocode/kilo-ui/context/marked"
import { MessageBubble } from "../kiloclaw/components/MessageBubble"
import { KiloClawLanguageProvider } from "../kiloclaw/context/language"
import type { Message } from "../kiloclaw/lib/types"

const message = (id: string, senderId: string, text: string): Message => ({
  id,
  senderId,
  content: [{ type: "text", text }],
  inReplyToMessageId: null,
  updatedAt: null,
  clientUpdatedAt: null,
  deleted: false,
  deliveryFailed: false,
  reactions: [],
})

const rows = [
  { key: "assistant", value: message("01ARZ3NDEKTSV4RRFFQ69G5FAV", "bot:raya", "The weekly report is ready.") },
  { key: "user", value: message("01ARZ3NDEKTSV4RRFFQ69G5FAW", "owner", "Open the revenue section.") },
  { key: "invalid", value: message("invalid-message-id", "bot:raya", "This imported message has no trusted time.") },
]

export const MessengerPreview: Component = () => (
  <KiloClawLanguageProvider locale={() => "en"}>
    <MarkedProvider>
      <section class="pv-messenger" aria-label="Raya Messenger timestamp preview">
        {rows.map((row) => (
          <div data-messenger-message={row.key}>
            <MessageBubble
              message={row.value}
              isOwn={row.key === "user"}
              assistantName="Raya"
              replyToMessage={null}
              pendingDeleteId={null}
              onReply={() => undefined}
              onRequestDelete={() => undefined}
              onCancelDelete={() => undefined}
              onConfirmDelete={() => undefined}
              onEdit={() => undefined}
              onAddReaction={() => undefined}
              onRemoveReaction={() => undefined}
              onExecuteAction={() => undefined}
            />
          </div>
        ))}
      </section>
    </MarkedProvider>
  </KiloClawLanguageProvider>
)
