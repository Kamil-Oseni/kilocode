import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import type { SessionID } from "@/session/schema"

/** Serialize prompt writes and control preconditions in this backend, per session. */
export const gate = KeyedMutex.makeUnsafe<SessionID>()
