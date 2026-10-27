import * as Inference from "../../context/local-inference-state"
import type { Box } from "./Inbox"

/** Resource presentation only; persisted run and recovery states remain authoritative. */
export function waiting(input: {
  box?: Box
  run?: { id: string; sessionID: string; status: string }
  connected: boolean
  stale?: boolean
  recovery?: boolean
  stopping?: boolean
  now: number
}) {
  if (!input.connected || input.stale || input.recovery || input.stopping || input.box?.state !== "running")
    return false
  const run = input.run
  const value = input.box.inference
  if (!run || run.status !== "running" || value?.runID !== run.id) return false
  const snapshot = Inference.read(value.snapshot, run.sessionID, input.now)
  if (!snapshot || snapshot.requests.some((row) => row.active > 0)) return false
  return snapshot.requests.some((row) => row.queued > 0 && row.since !== undefined)
}
