// raya_change - hybrid self-heal classification: the repair agent sharpens the deterministic
// keyword triage from inside the session that is already open, via RayaSelfHeal.update.
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaGoal } from "@/kilocode/goal"
import { RayaSelfHeal } from "@/kilocode/self-heal"

type Goals = ReturnType<typeof RayaGoal.make>
type Healing = ReturnType<typeof RayaSelfHeal.make>

const clean = (value: string) => value.trim().replace(/\s+/g, " ")
const cap = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 3)}...`)

const Params = Schema.Struct({
  category: Schema.optional(RayaSelfHeal.Category),
  severity: Schema.optional(RayaSelfHeal.Severity),
  approach: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  explanation: Schema.optional(Schema.String),
  duplicateOf: Schema.optional(Schema.String),
})

export function selfHealTools(goals: Goals, healing: Healing) {
  const refine = Tool.define(
    "refine_self_heal",
    Effect.succeed({
      description:
        "Reconcile this self-heal repair item's classification. Only usable inside a Raya self-heal session. Call it as your FIRST action: pass your best category, severity, approach, and title after reading the report; the deterministic keyword triage stays as the fallback. The result lists the other open backlog items — if this report clearly duplicates one, call again with duplicateOf set to that item's id (this marks the current item a duplicate). No-op when no self-heal item is linked to the session.",
      parameters: Params,
      execute: (input: typeof Params.Type, ctx) =>
        Effect.gen(function* () {
          const goal = yield* goals.get(ctx.sessionID)
          if (!goal?.selfHealID)
            return {
              title: "No self-heal item",
              metadata: {},
              output: "No self-heal item is linked to this session; there is nothing to reconcile.",
            }
          if (!goal.selfHealAttempt)
            return {
              title: "Repair linkage needs review",
              metadata: {},
              output: "Legacy repair linkage has no authoritative attempt; do not refine or close this item.",
            }
          yield* goals.repair(ctx.sessionID).pipe(Effect.orDie)
          const item = yield* healing.get(goal.selfHealID)
          if (!item)
            return {
              title: "Self-heal item missing",
              metadata: {},
              output: `Self-heal item ${goal.selfHealID} was not found (it may have been closed). Continue the repair.`,
            }

          const dup = input.duplicateOf ? clean(input.duplicateOf) : undefined
          const canonical = dup && dup !== item.id ? yield* healing.get(dup) : undefined
          if (dup && dup !== item.id && !canonical)
            return {
              title: "Duplicate target missing",
              metadata: {},
              output: `No open self-heal item ${dup} exists to duplicate against. Re-check the backlog ids and try again, or reconcile classification without duplicateOf.`,
            }

          const update: typeof RayaSelfHeal.Update.Type = {
            category: input.category,
            severity: input.severity,
            approach: input.approach ? cap(clean(input.approach), 400) : undefined,
            title: input.title ? cap(clean(input.title), 100) : undefined,
            explanation: input.explanation ? cap(clean(input.explanation), 400) : undefined,
            classifiedBy: "model",
            ...(canonical
              ? {
                  status: "duplicate" as const,
                  duplicateOf: canonical.id,
                  blockedReason: `Duplicate of ${canonical.id}: ${canonical.title}`,
                }
              : {}),
          }
          const next = yield* healing.update(item.id, update).pipe(Effect.orDie)
          if (!next)
            return {
              title: "Self-heal item missing",
              metadata: {},
              output: `Self-heal item ${item.id} could not be updated (it may have been closed). Continue the repair.`,
            }

          const open = (yield* healing.list()).filter(
            (row) => row.id !== next.id && !["verified", "duplicate", "cancelled"].includes(row.status),
          )
          const backlog = open.length
            ? open.map((row) => `${row.id} | ${row.status} | ${row.category}/${row.severity} | ${row.title}`).join("\n")
            : "No other open self-heal items."
          const head = canonical
            ? `Marked ${next.id} as a duplicate of ${canonical.id}. Stop repair work on this item; the canonical item owns the fix.`
            : `Reconciled ${next.id}: ${next.category}/${next.severity}. Now reproduce and repair.`
          return {
            title: canonical ? "Marked duplicate" : "Classification reconciled",
            metadata: {},
            output: `${head}\n\nOther open backlog items (flag a clear duplicate by calling refine_self_heal with duplicateOf):\n${backlog}`,
          }
        }),
    }),
  )

  return { refine }
}
