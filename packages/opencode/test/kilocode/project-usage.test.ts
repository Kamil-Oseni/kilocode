// raya_change - verify historical project token and cost aggregation
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { ProjectUsage } from "@/kilocode/session/project-usage"
import { RayaGoal } from "@/kilocode/goal"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node, Storage.node])),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model-a") }

describe("project usage", () => {
  it.instance("filters settled step usage by UTC rolling range and model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "usage history" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: Date.now() },
      } satisfies MessageV2.Assistant)
      const now = Date.now()
      const add = (end: number, cost: number, input: number, accounting?: MessageV2.StepFinishPart["accounting"]) =>
        sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: session.id,
          type: "step-finish",
          reason: "stop",
          model,
          cost,
          accounting,
          tokens: { input, output: 20, reasoning: 5, cache: { read: 30, write: 2 } },
          time: { start: end - 1_000, end, elapsed: 1_000 },
        })
      yield* add(now - 2 * 24 * 60 * 60 * 1_000, 2, 200)
      yield* add(now - 60 * 60 * 1_000, 1, 100, {
        version: 1,
        status: "reported",
        source: "gateway.marketCost",
        currency: "USD",
        amount: 1,
        buckets: [],
        issues: [],
      })

      yield* add(now + 1, 999, 99999)

      const { db } = yield* Database.Service
      const anchor = yield* db
        .get<{ projectID: ProjectV2.ID }>(sql`SELECT project_id AS projectID FROM session WHERE id = ${session.id}`)
        .pipe(Effect.orDie)
      expect(anchor).toBeDefined()

      expect(yield* ProjectUsage.get(anchor!.projectID, "24h", now)).toMatchObject({
        projectID: anchor!.projectID,
        range: "24h",
        since: now - 24 * 60 * 60 * 1_000,
        until: now,
        timezone: "UTC",
        sessions: 1,
        totals: {
          steps: 1,
          cost: 1,
          accounting: { amount: 1, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 0 },
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } },
        },
      })
      expect(yield* ProjectUsage.get(anchor!.projectID, "7d", now)).toMatchObject({
        totals: {
          steps: 2,
          cost: 3,
          accounting: { amount: 1, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 1 },
          tokens: { input: 300, output: 40, reasoning: 10, cache: { read: 60, write: 4 } },
        },
      })
      yield* add(now, 0.5, 50)
      yield* add(now - 24 * 60 * 60 * 1_000, 0.25, 25)
      expect((yield* ProjectUsage.get(anchor!.projectID, "24h", now)).totals).toMatchObject({ steps: 3, cost: 1.75 })
      expect((yield* ProjectUsage.get(anchor!.projectID, "all", now)).totals).toMatchObject({ steps: 4, cost: 3.75 })
      expect((yield* ProjectUsage.get(anchor!.projectID, "24h", now - 1)).totals).toMatchObject({
        steps: 2,
        cost: 1.25,
      })
    }),
  )

  it.instance("summarizes exact goal charges while surfacing malformed and conflicting coverage", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "charge history" })
      const malformed = yield* sessions.create({ title: "malformed charge history" })
      const goals = RayaGoal.make({ storage, sessions })
      yield* Effect.addFinalizer(() => goals.clear(session.id))
      yield* Effect.addFinalizer(() => goals.clear(malformed.id))
      const created = yield* goals.create(session.id, "Account for non-model project usage")
      const origin = { sessionID: session.id, callID: "call_project_usage" }
      const usd: RayaGoal.Charge = {
        id: "project-charge-usd-conflict",
        kind: "tool",
        provider: "Kilo",
        service: "Exa Web Search",
        source: "kilo-exa.costDollars.total",
        origin,
        at: created.createdAt,
        coverage: "recorded",
        amount: 0.25,
        currency: "USD",
      }
      const cad: RayaGoal.Charge = {
        ...usd,
        id: "project-charge-cad",
        source: "external.invoice",
        service: "Hosting",
        amount: 0.5,
        currency: "CAD",
      }
      const zero: RayaGoal.Charge = {
        ...usd,
        id: "project-charge-zero",
        source: "provider.receipt",
        service: "Provider zero",
        amount: 0,
      }
      const unknown: RayaGoal.Charge = {
        id: "project-charge-unknown",
        kind: "tool",
        provider: "Kilo",
        service: "Interrupted search",
        source: "provider-response-without-receipt",
        origin,
        at: created.createdAt,
        coverage: "unknown",
        reason: "The provider response was lost after dispatch.",
      }
      yield* goals.charged(session.id, usd, created.createdAt)
      yield* goals.charged(session.id, cad, created.createdAt)
      yield* goals.charged(session.id, zero, created.createdAt)
      yield* goals.charged(session.id, unknown, created.createdAt)
      const state = yield* storage.read<RayaGoal.State>(["raya", "goal", session.id])
      yield* storage.replace(["raya", "goal", session.id], {
        ...state,
        charges: [...(state.charges ?? []), { ...usd, amount: 0.75 }],
        history: [
          {
            objective: "Earlier goal lifecycle",
            status: "complete",
            createdAt: created.createdAt,
            updatedAt: created.createdAt,
            usage: state.usage,
            charges: [cad],
          },
        ],
      })
      yield* storage.replace(["raya", "goal", malformed.id], { broken: true })
      const orphan = ["raya", "goal", "ses_unlinked_project_charge"]
      yield* Effect.addFinalizer(() => storage.remove(orphan))
      yield* storage.replace(orphan, {
        ...state,
        charges: [{ ...zero, id: "unlinked-charge", amount: 999 }],
      })

      const result = yield* ProjectUsage.get(session.projectID, "all", created.createdAt + 1)
      expect(result.charges).toEqual({
        goals: 2,
        unreadable: 1,
        conflicts: 1,
        items: [
          {
            currency: "CAD",
            provider: "Kilo",
            service: "Hosting",
            source: "external.invoice",
            amount: 0.5,
            recorded: 1,
            unknown: 0,
          },
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
      expect((yield* ProjectUsage.get(session.projectID, "all", created.createdAt - 1)).charges).toMatchObject({
        conflicts: 0,
        items: [],
      })
    }),
  )
})
