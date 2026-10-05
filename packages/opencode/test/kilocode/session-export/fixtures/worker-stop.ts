import * as Identity from "@/kilocode/session-export/worker-identity"
import { observation, fingerprint } from "@/kilocode/cli/profile-retirement"
import path from "node:path"
const mode = process.argv.at(-1)
onmessage = (event: MessageEvent<unknown>) => {
  if (mode === "error") throw new Error("actual export worker error")
  const request = Identity.accept(event.data, Identity.identity(event.data))
  if (mode === "refused") {
    postMessage({
      kind: "shutdown_refused",
      ...request,
      reason: "actual refusal",
      failures: ["actual retained cleanup failure"],
    })
    return
  }
  if (mode !== "missing") {
    const reply = Identity.acknowledge(request, observation())
    const root = { kind: "json" as const, path: mode === "relative" ? "relative" : path.resolve(import.meta.dir) }
    const roots = mode === "duplicate" ? [root, root] : [root]
    postMessage({
      ...reply,
      requestID: mode === "wrong" ? crypto.randomUUID() : reply.requestID,
      generation: mode === "generation" ? crypto.randomUUID() : reply.generation,
      runID: mode === "run" ? crypto.randomUUID() : reply.runID,
      role: mode === "role" ? "unrelated-worker" : reply.role,
      version: mode === "version" ? 2 : reply.version,
      receipt:
        mode === "hash"
          ? { ...reply.receipt, inventory: "0".repeat(64) }
          : mode === "malformed"
            ? { ...reply.receipt, portable: true }
            : mode === "globalzero"
              ? { ...reply.receipt, nativeOwners: 0 }
              : ["relative", "duplicate"].includes(mode ?? "")
                ? { ...reply.receipt, roots, observation: "participating-roots", inventory: fingerprint(roots) }
                : reply.receipt,
    })
  }
  if (mode === "noexit") return
  onmessage = null
  if (mode === "badexit") process.exit(1)
}
postMessage({ kind: "ready" })
