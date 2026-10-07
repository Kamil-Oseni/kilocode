import path from "node:path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Equality, GoalCriteria } from "./criteria"
import * as Artifact from "./artifact"

const normalize = (value: string) =>
  process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)

const current = (check: Equality, bound: readonly (Artifact.Entry | undefined)[]) =>
  Effect.gen(function* () {
    if (bound.some((entry) => !entry || entry.status !== "captured")) return false
    const fs = yield* Effect.serviceOption(FSUtil.Service)
    if (Option.isNone(fs)) return false
    for (const entry of bound) {
      if (!entry || entry.status !== "captured") return false
      const now = yield* Artifact.capture(fs.value, entry.path, entry.canonical)
      if (
        now.status !== "captured" ||
        now.sha256 !== entry.sha256 ||
        now.bytes !== entry.bytes ||
        now.mode !== entry.mode ||
        now.sha256 !== check.source.sha256 ||
        now.bytes !== check.source.bytes
      )
        return false
    }
    return true
  })

/** Only inspect exact artifacts already authorized and cited through successful reads. */
export const equality = (check: Equality, cited: readonly SessionV1.ToolPart[]) => {
  const revisions = cited.flatMap((part) =>
    part.tool === "read" && part.state.status === "completed"
      ? Artifact.entries(part.state.metadata["rayaRevision"])
      : [],
  )
  const bound = [check.source, check.target].map((selected) =>
    revisions.find(
      (entry) =>
        entry.status === "captured" &&
        entry.bytes !== undefined &&
        normalize(entry.path) === normalize(selected.path) &&
        normalize(entry.canonical) === normalize(selected.canonical),
    ),
  )
  return current(check, bound)
}

type Row = {
  messageID: string
  partID: string
  sessionID: string
  callID: string
  tool: string
  artifact?: unknown
}

/** Guidance from eligible recorded reads; completion still rechecks every cited artifact. */
export const citations = (criteria: GoalCriteria | undefined, evidence: readonly Row[]) =>
  Effect.gen(function* () {
    const reads = evidence.flatMap((row) =>
      row.tool === "read" ? Artifact.entries(row.artifact).map((entry) => ({ row, entry })) : [],
    )
    const hints = yield* Effect.forEach(criteria ?? [], (criterion) =>
      Effect.gen(function* () {
        const check = criterion.check
        if (check?.kind !== "byte-equality") return undefined
        const choose = (selected: { path: string; canonical: string }) =>
          reads.find(
            ({ entry }) =>
              entry.status === "captured" &&
              entry.bytes !== undefined &&
              normalize(entry.path) === normalize(selected.path) &&
              normalize(entry.canonical) === normalize(selected.canonical),
          )
        const source = choose(check.source)
        const target = choose(check.target)
        if (!source || !target || !(yield* current(check, [source.entry, target.entry]))) return undefined
        return {
          criterionID: criterion.id,
          action: "correct-audit-citations",
          evidence: [source, target].map(({ row }) => ({
            callID: row.callID,
            messageID: row.messageID,
            partID: row.partID,
            sessionID: row.sessionID,
            summary: "Current read matches the saved original bytes",
          })),
          instruction:
            "Cite both read receipts together for this criterion. The files currently match the saved original bytes; correct missing audit citations without rewriting files or repeating delegated work. This does not complete the goal; update_goal rechecks all criteria and current artifacts.",
        }
      }),
    )
    return hints.filter((hint) => hint !== undefined)
  })
