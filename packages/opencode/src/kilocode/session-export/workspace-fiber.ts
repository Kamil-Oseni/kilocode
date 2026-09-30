import type {
  CaptureMetadata,
  DeltaEntry,
  ExportEvent,
  FileEntry,
  WorkspaceDeltaCaptured,
} from "./events"
import { ulid } from "ulid"

export type BaselineFiberArgs = {
  sessionId: string
  rootSessionId: string
  turnId?: string
  timeoutMs: number
  now: () => number
  syncSeq: () => number
  agentVersion: string
  requestSnapshot: () => Promise<{ snapshotId: string; files: FileEntry[]; capture?: CaptureMetadata }>
  dispatch: (envelope: ExportEvent) => void
  active?: () => boolean
  onSnapshot?: (snapshotId: string) => void
  onPending?: (pending: Promise<void>) => void
}

export type DeltaFiberArgs = {
  sessionId: string
  rootSessionId: string
  turnId?: string
  trigger: "next_request" | "turn_end" | "session_close"
  prevSnapshotHash: string
  now: () => number
  syncSeq: () => number
  agentVersion: string
  requestDiff: (prevSnapshotHash: string) => Promise<{ snapshotHash: string; diff: DeltaEntry[] }>
  dispatch: (envelope: ExportEvent) => void
  active?: () => boolean
}

export async function startBaselineFiber(args: BaselineFiberArgs): Promise<string | undefined> {
  const pending = Promise.resolve().then(args.requestSnapshot)
  const settled = Promise.withResolvers<void>()
  args.onPending?.(settled.promise)
  const timer: { value?: ReturnType<typeof setTimeout> } = {}
  const timeout = new Promise<"timeout">((resolve) => {
    timer.value = setTimeout(() => resolve("timeout"), args.timeoutMs)
  })
  const winner = await Promise.race([pending, timeout]).catch((err) => {
    console.warn("[session-export] baseline failed", err)
    return undefined
  })
  clearTimeout(timer.value)
  if (winner === "timeout") {
    try {
      emitBaseline(args, { consistency: "missing", files: [] })
    } catch (err) {
      settled.reject(err)
      throw err
    }
    void pending.then(
      (result) => {
        try {
          emitBaseline(args, { consistency: "eventual", ...result })
          if (args.active?.() !== false) args.onSnapshot?.(result.snapshotId)
          settled.resolve()
        } catch (err) {
          settled.reject(err)
        }
      },
      (err) => {
        console.warn("[session-export] eventual baseline failed", err)
        settled.resolve()
      },
    )
    return undefined
  }
  if (!winner) {
    emitBaseline(args, { consistency: "missing", files: [] })
    settled.resolve()
    return undefined
  }
  try {
    emitBaseline(args, { consistency: "stable", ...winner })
    if (args.active?.() !== false) args.onSnapshot?.(winner.snapshotId)
    settled.resolve()
    return winner.snapshotId
  } catch (err) {
    settled.reject(err)
    throw err
  }
}

function emitBaseline(
  args: BaselineFiberArgs,
  result: {
    consistency: "stable" | "eventual" | "missing"
    snapshotId?: string
    files: FileEntry[]
    capture?: CaptureMetadata
  },
): void {
  if (args.active?.() === false) return
  const seq = args.syncSeq()
  args.dispatch({
    id: ulid(),
    schemaVersion: 1,
    type: "workspace_baseline_completed",
    sessionId: args.sessionId,
    rootSessionId: args.rootSessionId,
    turnId: args.turnId,
    seq,
    eventSeq: seq,
    ts: args.now(),
    agentVersion: args.agentVersion,
    snapshotId: result.snapshotId,
    consistency: result.consistency,
    files: result.files,
    capture: result.capture,
  })
}

export async function startDeltaFiber(args: DeltaFiberArgs): Promise<string | undefined> {
  try {
    const result = await args.requestDiff(args.prevSnapshotHash)
    if (args.active?.() === false) return undefined
    if (result.diff.length === 0) return result.snapshotHash
    const seq = args.syncSeq()
    const env: WorkspaceDeltaCaptured = {
      id: ulid(),
      schemaVersion: 1,
      type: "workspace_delta_captured",
      sessionId: args.sessionId,
      rootSessionId: args.rootSessionId,
      turnId: args.turnId,
      seq,
      eventSeq: seq,
      ts: args.now(),
      agentVersion: args.agentVersion,
      snapshotHash: result.snapshotHash,
      prevSnapshotHash: args.prevSnapshotHash,
      trigger: args.trigger,
      diff: result.diff,
    }
    args.dispatch(env)
    return result.snapshotHash
  } catch (err) {
    console.warn("[session-export] delta capture failed", err)
    return undefined
  }
}
