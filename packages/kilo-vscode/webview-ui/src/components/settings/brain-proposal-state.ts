import type { BrainProposal, BrainProposalResult } from "../../../../src/shared/second-brain"

export function project(value: string) {
  const path = value.replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function proposal(value: unknown): value is BrainProposal {
  if (!record(value) || value.format !== "raya.memory.proposal.v1" || value.capture_enabled !== false) return false
  const header = ["id", "project", "digest", "provenance", "status"]
  if (header.some((key) => typeof value[key] !== "string")) return false
  if (!["pending", "cancelled", "applying", "applied"].includes(String(value.status))) return false
  if (
    !Array.isArray(value.sources) ||
    !Array.isArray(value.changes) ||
    value.sources.length > 8 ||
    value.changes.length > 16
  )
    return false
  return (
    value.sources.every(
      (source) => record(source) && ["path", "sha256", "kind"].every((key) => typeof source[key] === "string"),
    ) &&
    value.changes.every(
      (change) =>
        record(change) &&
        typeof change.path === "string" &&
        [change.expected, change.before, change.content].every((text) => text === null || typeof text === "string"),
    )
  )
}

/** Refuse malformed transport data instead of crashing the review or inventing a receipt. */
export function reviewed(value: unknown): BrainProposalResult | undefined {
  if (proposal(value)) return value
  if (
    record(value) &&
    value.capture_enabled === false &&
    Array.isArray(value.proposals) &&
    value.proposals.length <= 128 &&
    value.proposals.every(proposal)
  )
    return { capture_enabled: false, proposals: value.proposals }
}
