import { capture, type InstanceContext } from "../instance"
import { KiloSessionEvent } from "../session/event"
import { SessionID } from "@/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import type { Origin } from "./inference-lane"

const log = Log.create({ service: "local-inference.events" })
const pending = new WeakMap<InstanceContext, Map<SessionID, { dirty: boolean }>>()

/** Capture the actual requesting instance before any scheduler delay; this grants no authority. */
export function notifier(origin?: Origin): (() => void) | undefined {
  if (!origin || origin.helper) return undefined
  try {
    const ctx = capture()
    if (!ctx) return undefined
    const sessionID = SessionID.make(origin.sessionID)
    return () => {
      const rows = pending.get(ctx) ?? new Map<SessionID, { dirty: boolean }>()
      const known = rows.get(sessionID)
      if (known) {
        known.dirty = true
        return
      }
      // Only in-flight publications are retained. Polling covers an overloaded event channel.
      if (rows.size >= 128) return
      const state = { dirty: true }
      rows.set(sessionID, state)
      pending.set(ctx, rows)
      queueMicrotask(() => {
        void (async () => {
          try {
            const { Bus } = await import("@/bus")
            do {
              state.dirty = false
              await Bus.publish(ctx, KiloSessionEvent.InferenceChanged, { sessionID })
            } while (state.dirty)
          } catch {
            log.warn("Transient inference invalidation could not be published")
          } finally {
            if (rows.get(sessionID) === state) rows.delete(sessionID)
            if (!rows.size) pending.delete(ctx)
          }
        })()
      })
    }
  } catch {
    log.warn("Transient inference attribution could not be captured")
    return undefined
  }
}
