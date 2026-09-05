import { createMemo, createSignal, type Component } from "solid-js"
import { UserMessageDisplay } from "@kilocode/kilo-ui/message-part"
import { partReview } from "../../../../src/shared/review-comments"
import type { Message, Part, TextPart } from "../../types/messages"
import { ReviewComments } from "./ReviewComments"

interface VscodeUserMessageProps {
  message: Message
  parts: Part[]
  interrupted?: boolean
  queued?: boolean
  onDelete?: () => void
  onEdit?: (text: string) => void
  onFork?: () => void
  onRevert?: () => void
}

export const VscodeUserMessage: Component<VscodeUserMessageProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false) // raya_change - compact long goal and instruction prompts
  const text = createMemo(() => props.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic))
  const review = createMemo(() => {
    const part = text()
    if (!part) return undefined
    return partReview(part.metadata, part.text)
  })
  const body = createMemo(() => review()?.body)
  const long = createMemo(() => {
    const value = body() ?? text()?.text ?? ""
    return value.length > 600 || value.split(/\r?\n/).length > 8
  })

  return (
    <UserMessageDisplay
      message={props.message as unknown as Parameters<typeof UserMessageDisplay>[0]["message"]}
      parts={props.parts as unknown as Parameters<typeof UserMessageDisplay>[0]["parts"]}
      text={body()}
      copyText={review() ? text()?.text : undefined}
      collapsed={long() && !expanded()}
      toggleLabel={expanded() ? "Show less" : "Show full prompt"}
      onToggle={long() ? () => setExpanded((value) => !value) : undefined}
      header={
        review() ? (
          <ReviewComments comments={review()!.data.comments} sessionID={props.message.sessionID} variant="message" />
        ) : undefined
      }
      interrupted={props.interrupted}
      queued={props.queued}
      onDelete={props.onDelete}
      onEdit={props.onEdit}
      onFork={props.onFork}
      onRevert={props.onRevert}
    />
  )
}
