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
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node])))
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

      const { db } = yield* Database.Service
      const anchor = yield* db
        .get<{ projectID: ProjectV2.ID }>(sql`SELECT project_id AS projectID FROM session WHERE id = ${session.id}`)
        .pipe(Effect.orDie)
      expect(anchor).toBeDefined()

      expect(yield* ProjectUsage.get(anchor!.projectID, "24h", now)).toMatchObject({
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
    }),
  )
})
