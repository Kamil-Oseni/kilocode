import { createSignal } from "solid-js"
import type {
  CloudSessionDataLoadedMessage,
  CloudSessionImportedMessage,
  CloudSessionImportFailedMessage,
} from "../types/messages"

type Continuation = CloudSessionDataLoadedMessage["continuation"] & { error?: string }
type CloudMessage = CloudSessionDataLoadedMessage | CloudSessionImportedMessage | CloudSessionImportFailedMessage

export function createCloudContinuation(handlers: {
  loaded(message: CloudSessionDataLoadedMessage): void
  imported(message: CloudSessionImportedMessage): void
  failed(message: CloudSessionImportFailedMessage): void
}) {
  const [entries, setEntries] = createSignal<Record<string, Continuation>>({})
  const requests = new Map<string, string>()
  const patch = (id: string, value: Continuation) => setEntries((all) => ({ ...all, [id]: value }))
  return {
    get: (id: string | null) => entries()[id ?? ""],
    request(id: string) {
      const requestID = crypto.randomUUID()
      requests.set(id, requestID)
      return requestID
    },
    send(id: string) {
      const entry = entries()[id]
      if (!entry) return undefined
      patch(id, { ...entry, status: "pending" })
      return entry.id
    },
    receive(message: CloudMessage) {
      const id = message.cloudSessionId
      if (message.type === "cloudSessionDataLoaded") {
        if (requests.get(id) !== message.requestID) return
        patch(id, message.continuation)
        handlers.loaded(message)
        return
      }
      const entry = entries()[id]
      if (message.continuationID && entry?.id !== message.continuationID) return
      if (message.type === "cloudSessionImported") {
        if (!entry || !message.continuationID) return
        patch(id, { ...entry, status: "imported", sessionID: message.session.id })
        handlers.imported(message)
        return
      }
      if (message.requestID && requests.get(id) !== message.requestID) return
      if (entry)
        patch(id, {
          ...entry,
          status: message.status ?? entry.status,
          sessionID: message.sessionID ?? entry.sessionID,
          error: message.error,
        })
      handlers.failed(message)
    },
  }
}
