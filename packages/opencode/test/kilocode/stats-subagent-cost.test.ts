// Verifies `kilo stats` does not double-count subagent cost while still
// including child-session messages, tokens, tools, and model usage. The task
// tool propagates each child session's total cost up to the parent's
// tool-wrapper assistant message (#6321).

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { aggregateSessionStats, chargeLines } from "../../src/cli/cmd/stats"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "../../src/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Storage } from "../../src/storage/storage"
import { RayaGoal } from "../../src/kilocode/goal"
import { sql } from "drizzle-orm"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node, Storage.node])),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function assistant(sessionID: SessionID, parentID: MessageID, cost: number): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "build",
    agent: "build",
    cost,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
}

const step = Effect.fn("StatsSubagentCost.step")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  cost: number,
  status?: "reported" | "estimated",
) {
  const svc = yield* Session.Service
  yield* svc.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost,
    accounting: status
      ? { version: 1, status, source: "test", currency: "USD", amount: cost, buckets: [], issues: [] }
      : undefined,
    tokens: { total: 15, input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  })
})

const tool = Effect.fn("StatsSubagentCost.tool")(function* (sessionID: SessionID, messageID: MessageID) {
  const time = Date.now()
  const svc = yield* Session.Service
  yield* svc.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "bash",
      metadata: {},
      time: { start: time, end: time },
    },
  })
})

describe("stats subagent cost", () => {
  for (const evidence of [false, true])
    it.instance(
      `counts child usage without double-counting propagated cost (${evidence ? "evidenced" : "legacy"})`,
      () =>
        Effect.gen(function* () {
          const svc = yield* Session.Service
          const parent = yield* svc.create({ title: "root" })
          const child = yield* svc.create({ parentID: parent.id, title: "subagent" })

          const userMsg = yield* svc.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const parentMsg = yield* svc.updateMessage(assistant(parent.id, userMsg.id, 1.5))
          yield* step(parent.id, parentMsg.id, 1, evidence ? "reported" : undefined)

          const childUser = yield* svc.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: child.id,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          const childMsg = yield* svc.updateMessage(assistant(child.id, childUser.id, 0.5))
          yield* step(child.id, childMsg.id, 0.5, evidence ? "estimated" : undefined)
          yield* tool(child.id, childMsg.id)

          const storage = yield* Storage.Service
          const goals = RayaGoal.make({ storage, sessions: svc })
          yield* Effect.addFinalizer(() => goals.clear(parent.id))
          const goal = yield* goals.create(parent.id, "Account for CLI statistics")
          const origin = { sessionID: parent.id, callID: "call_stats_charge" }
          yield* goals.charged(parent.id, {
            id: "stats-provider-zero",
            kind: "tool",
            provider: "Kilo",
            service: "Provider zero",
            source: "provider.receipt",
            origin,
            at: goal.createdAt,
            coverage: "recorded",
            amount: 0,
            currency: "USD",
          })
          yield* goals.charged(parent.id, {
            id: "stats-unknown-charge",
            kind: "tool",
            provider: "Kilo",
            service: "Interrupted search",
            source: "provider-response-without-receipt",
            origin,
            at: goal.createdAt,
            coverage: "unknown",
            reason: "The response was lost after dispatch.",
          })

          const stats = yield* aggregateSessionStats()
          const model = stats.modelUsage["test/test-model"]
          expect(stats.totalCost).toBeCloseTo(1.5, 6)
          expect(stats.totalSessions).toBe(2)
          expect(stats.totalMessages).toBe(4)
          expect(stats.totalTokens.input).toBe(20)
          expect(stats.totalTokens.output).toBe(10)
          expect(stats.toolUsage.bash).toBe(1)
          expect(model.messages).toBe(2)
          expect(model.tokens.input).toBe(20)
          expect(model.tokens.output).toBe(10)
          expect(model.cost).toBeCloseTo(1.5, 6)
          expect(stats.accounting).toEqual(
            evidence
              ? { amount: 1.5, reported: 1, estimated: 1, partial: 0, unknown: 0, legacy: 0 }
              : { amount: 0, reported: 0, estimated: 0, partial: 0, unknown: 0, legacy: 2 },
          )
          expect(model.accounting).toEqual(stats.accounting)
          expect(stats.charges).toEqual({
            goals: 1,
            unreadable: 0,
            conflicts: 0,
            items: [
              {
                currency: "USD",
                provider: "Kilo",
                service: "Provider zero",
                source: "provider.receipt",
                amount: 0,
                recorded: 1,
                unknown: 0,
              },
              {
                provider: "Kilo",
                service: "Interrupted search",
                source: "provider-response-without-receipt",
                recorded: 0,
                unknown: 1,
              },
            ],
          })

          const { db } = yield* Database.Service
          yield* db
            .run(sql`UPDATE session SET time_updated = ${Date.now() - 2 * 86_400_000} WHERE id = ${parent.id}`)
            .pipe(Effect.orDie)
          const today = yield* aggregateSessionStats(0)
          expect(today.totalSessions).toBe(1)
          expect(today.charges).toEqual(stats.charges)
          expect(chargeLines(today.charges)).toEqual([
            "Provider zero: USD 0 (1 recorded)",
            "Interrupted search: amount unavailable (0 recorded; 1 amount unavailable)",
          ])
          expect(chargeLines({ items: [], goals: 1, unreadable: 1, conflicts: 2 })).toEqual([
            "No retained non-model charges in this range.",
            "Incomplete coverage: 1 unreadable goal records; 2 conflicting receipts excluded.",
          ])
        }),
      { git: true },
    )
})
