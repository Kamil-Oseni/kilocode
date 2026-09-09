/** The parent tool invocation that admitted work; absent identity is not ownership evidence. */
export type Origin = {
  sessionID: string
  messageID: string
  callID: string
  childSessionID?: string
  childMessageID?: string
}

export const copy = (origin: Origin | undefined) => (origin ? { ...origin } : undefined)
