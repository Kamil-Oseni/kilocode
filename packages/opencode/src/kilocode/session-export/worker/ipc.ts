import type { ExportEvent } from "../events"
import type { identity, request, validate } from "../worker-identity"

export type WorkerIdentity = ReturnType<typeof identity>
export type ShutdownRequest = ReturnType<typeof request>
export type ShutdownReply = ReturnType<typeof validate>

export type ToWorker =
  | {
      kind: "init"
      dbPath: string
      agentVersion?: string
      endpoint?: string
      allowCustomEndpoint?: boolean
      surface?: string
      anonId?: string
      identity: WorkerIdentity
    }
  | { kind: "event"; envelope: ExportEvent; approxBytes: number }
  | ({ kind: "shutdown"; timeoutMs: number } & ShutdownRequest)
  | { kind: "network_reconnect" }
  | { kind: "test_event_count" }

export type FromWorker =
  | { kind: "pressure"; sessionId: string }
  | { kind: "ready" }
  | { kind: "telemetry"; name: string; props?: Record<string, unknown> }
  | ShutdownReply
  | ({ kind: "shutdown_refused"; reason: string; failures?: string[] } & ShutdownRequest)
  | { kind: "kill_switch"; reason: string }
