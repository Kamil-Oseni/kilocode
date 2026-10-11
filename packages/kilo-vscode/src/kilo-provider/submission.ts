import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"

/** Submit human input once; a failed response cannot authorize another POST. */
export async function submit(opts: {
  run: () => Promise<{ error?: unknown }>
  load: () => Promise<InputReceipt.Row | undefined>
  current: () => boolean
  cancelled: () => boolean
  sessionID: string
  messageID?: string
}): Promise<boolean> {
  if (opts.cancelled()) return false
  if (!opts.current()) throw new Error("The connection or workspace changed before this message was sent.")
  const result = await opts.run().catch(() => ({ error: true }))
  if (!result.error || opts.cancelled()) return false
  const row = opts.messageID && opts.current() ? await opts.load().catch(() => undefined) : undefined
  if (opts.cancelled()) return false
  if (opts.current() && opts.messageID && InputReceipt.complete(row, opts.sessionID, opts.messageID)) return true
  throw new Error(
    "Raya could not confirm this message was accepted. Check the chat before sending again; it was not automatically resubmitted.",
  )
}
