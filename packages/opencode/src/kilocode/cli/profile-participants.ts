import { workerScopes } from "./worker-scopes"
import { sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { SourceScopes } from "@opencode-ai/core/kilocode/source-scopes"
import { createHash } from "node:crypto"
import path from "node:path"
import type { observation } from "./profile-retirement"

type Participant = Readonly<{
  role: "worker" | "session-export-worker" | "indexing-worker"
  runID: string
  generation: string
  requestID: string
  receipt: ReturnType<typeof observation>
  scopes?: ReturnType<typeof workerScopes>
}>

function verify(receipt: Participant["receipt"]) {
  if (
    receipt.format !== "raya.profile-root-observation" ||
    receipt.version !== 1 ||
    receipt.processLocal !== true ||
    receipt.participantOnly !== true ||
    receipt.cooperativeOnly !== true ||
    receipt.completeProfileCoverage !== false ||
    receipt.portableCaptureAuthorized !== false ||
    receipt.portable !== false ||
    !["participating-roots", "no-participating-roots"].includes(receipt.observation) ||
    (receipt.observation === "no-participating-roots") !== (receipt.roots.length === 0) ||
    "nativeOwners" in receipt ||
    "operations" in receipt ||
    "scope" in receipt
  )
    throw new Error("Profile participant observation is invalid")
}

/** Historical metadata only. Callers must first confirm the exact acknowledgment and clean Worker exit. */
export function participants() {
  const records = new Map<string, Participant>()
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  return {
    remember(input: Participant) {
      if (!input.runID || !uuid.test(input.generation) || !uuid.test(input.requestID))
        throw new Error("Profile participant identity is invalid")
      if (!["worker", "session-export-worker", "indexing-worker"].includes(input.role))
        throw new Error("Profile participant role is invalid")
      const receipt = input.receipt
      verify(receipt)
      const roots = receipt.roots.map((root) => Object.freeze({ kind: root.kind, path: root.path }))
      const keys = roots.map((root) => {
        if (
          !["sqlite", "json"].includes(root.kind) ||
          !path.isAbsolute(root.path) ||
          path.normalize(root.path) !== root.path
        )
          throw new Error("Profile participant root metadata is invalid")
        return `${root.kind}:${process.platform === "win32" ? root.path.toLowerCase() : root.path}`
      })
      const sorted = [...keys].sort()
      if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sorted[index]))
        throw new Error("Profile participant roots are not an ordered distinct inventory")
      const digest = createHash("sha256")
        .update(
          JSON.stringify(
            roots.map((root) => ({
              ...root,
              path: process.platform === "win32" ? root.path.toLowerCase() : root.path,
            })),
          ),
        )
        .digest("hex")
      if (receipt.inventory !== digest) throw new Error("Profile participant inventory checksum is invalid")
      const value = Object.freeze({
        role: input.role,
        runID: input.runID,
        generation: input.generation,
        requestID: input.requestID,
        receipt: Object.freeze({ ...receipt, roots: Object.freeze(roots) }),
        scopes: workerScopes(input.scopes, roots),
      })
      const key = `${value.role}:${value.runID}:${value.generation}`
      const previous = records.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(value))
        throw new Error("Profile participant observation changed after confirmation")
      if (!previous) records.set(key, value)
      return previous ?? value
    },
    snapshot() {
      return Object.freeze([...records.values()])
    },
  }
}

export const ProfileParticipants = participants()

/** Legacy confirmations remain usable for ordinary shutdown but cannot certify state-role completeness. */
export function participantScopes(required: boolean) {
  const records = ProfileParticipants.snapshot()
  const own = sourceScopes()
  const values = [own, ...records.flatMap((item) => (item.scopes ? [item.scopes] : []))]
  if (
    required &&
    (records.some((item) => item.scopes?.version !== 4 || item.scopes.configStatus !== "complete") ||
      own.version !== 4 ||
      own.configStatus !== "complete" ||
      own.globals.length === 0)
  ) {
    const failed = [
      { role: "source" as const, scopes: own },
      ...records.map((item) => ({ role: item.role, scopes: item.scopes })),
    ].filter(
      (item) =>
        item.scopes?.version !== 4 ||
        item.scopes.configStatus !== "complete" ||
        (item.role === "source" && item.scopes.globals.length === 0),
    )
    console.error(
      "RAYA_SOURCE_SCOPE_FAILURE " +
        JSON.stringify({
          code: "RAYA_SOURCE_SCOPE_INCOMPLETE",
          scopes: failed.slice(0, 129).map((item) => ({
            role: item.role,
            version: item.scopes?.version ?? null,
            configStatus:
              item.scopes && (item.scopes.version === 3 || item.scopes.version === 4)
                ? item.scopes.configStatus
                : "unavailable",
            configReason:
              item.scopes && (item.scopes.version === 3 || item.scopes.version === 4)
                ? (item.scopes.configReason ?? null)
                : null,
            globalCount: item.scopes && item.scopes.version !== 1 ? item.scopes.globals.length : 0,
          })),
          omitted: Math.max(0, failed.length - 129),
        }),
    )
    throw new Error("Source export lacks confirmed configuration origin and Global namespace identities")
  }
  const states = [...new Set(values.flatMap((value) => value.states))].sort()
  if (records.some((item) => !item.scopes) || values.some((value) => value.version === 1))
    return SourceScopes.parse({ version: 1, states })
  const globals = new Map<string, unknown>()
  const configs = new Map<string, unknown>()
  for (const value of values) {
    if (value.version === 1) continue
    for (const roles of value.globals) {
      const key = JSON.stringify(
        Object.fromEntries(
          Object.entries(roles).map(([role, file]) => [role, process.platform === "win32" ? file.toLowerCase() : file]),
        ),
      )
      globals.set(key, roles)
    }
    if (value.version === 3 || value.version === 4)
      for (const graph of value.configs) {
        const previous = configs.get(graph.graph)
        if (previous && JSON.stringify(previous) !== JSON.stringify(graph))
          throw new Error("Confirmed configuration graph changed after acknowledgment")
        configs.set(graph.graph, graph)
      }
  }
  const metadata = {
    states,
    globals: [...globals.keys()].sort().map((key) => globals.get(key)),
  }
  const incomplete = values.find(
    (value) => (value.version === 3 || value.version === 4) && value.configStatus !== "complete",
  )
  const refusal =
    incomplete && (incomplete.version === 3 || incomplete.version === 4)
      ? { configStatus: incomplete.configStatus, configReason: incomplete.configReason }
      : { configStatus: "complete" as const }
  return SourceScopes.parse(
    values.some((value) => value.version !== 4)
      ? { version: 2, ...metadata }
      : {
          version: 4,
          ...metadata,
          ...refusal,
          configs: refusal.configStatus === "complete" ? [...configs.keys()].sort().map((key) => configs.get(key)) : [],
        },
  )
}
