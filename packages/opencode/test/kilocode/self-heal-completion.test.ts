import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { selfHealTools } from "@/kilocode/tool/self-heal"
import { RayaGoal } from "@/kilocode/goal"
import { RayaSelfHeal } from "@/kilocode/self-heal"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
const it = testEffect(
  LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, Git.node, Agent.node, Truncate.node])),
)
const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("goal-model"),
}

function transcript(input: {
  sessionID: SessionID
  tool?: string
  exit?: number
  output?: string
  text?: string
  metadata?: Record<string, unknown>
}) {
  const user: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "code",
    model,
  }
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    parentID: user.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    agent: "code",
    mode: "code",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: model.providerID,
    modelID: model.modelID,
    finish: "stop",
  }
  const part: MessageV2.ToolPart | undefined = input.tool
    ? {
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "tool",
        callID: crypto.randomUUID(),
        tool: input.tool,
        state: {
          status: "completed",
          input: {},
          output: input.output ?? (input.exit === 0 ? "all checks passed" : "check failed"),
          title: "verification",
          metadata: { exit: input.exit, ...input.metadata },
          time: { start: Date.now(), end: Date.now() },
        },
      }
    : undefined
  const text: MessageV2.TextPart | undefined = input.text
    ? {
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
        time: { start: Date.now(), end: Date.now() },
      }
    : undefined
  const rows: MessageV2.WithParts[] = [
    { info: user, parts: [] },
    { info: assistant, parts: [...(part ? [part] : []), ...(text ? [text] : [])] },
  ]
  return { rows, part }
}

function instance<A, E, R>(directory: string, run: (storage: Storage.Interface) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    return yield* run(yield* Storage.Service)
  }).pipe(Effect.provide(Storage.layerFromDir(directory)))
}
function goals(storage: Storage.Interface, rows: MessageV2.WithParts[]) {
  return RayaGoal.make({
    storage,
    sessions: {
      messages: () => Effect.succeed(rows),
      children: () => Effect.succeed([]),
      get: (id) => storage.read<Session.Info>(["fixture-session", id]).pipe(Effect.orDie),
    },
  })
}
const journal = (id: string) => ["raya", "self-heal", "repair", createHash("sha256").update(id).digest("hex"), "0"]
const seed = Effect.fn(function* (storage: Storage.Interface, sessionID: SessionID) {
  const item = yield* RayaSelfHeal.make(storage).create({ description: `Completion fixture ${crypto.randomUUID()}` })
  const outcome = {
    id: crypto.randomUUID(),
    itemID: item.id,
    sessionID,
    source: { root: "/admitted/raya", commit: "a".repeat(40) },
    worktree: {
      root: "/managed",
      directory: "/managed/attempt",
      branch: "raya/repair/attempt",
      common: "/admitted/raya/.git",
      commit: "a".repeat(40),
    },
    revision: 0,
    phase: "submitted",
    at: Date.now(),
  }
  yield* storage.create(journal(item.id), { owner: "private", outcome })
  yield* storage.create(["fixture-session", sessionID], {
    id: sessionID,
    slug: "fixture",
    projectID: "fixture",
    directory: outcome.worktree.directory,
    title: "Repair",
    version: "test",
    time: { created: Date.now(), updated: Date.now() },
    metadata: {
      rayaSelfHealAttempt: outcome.id,
      rayaSelfHealSource: outcome.source,
      rayaSelfHealWorktree: outcome.worktree,
    },
  })
  return { item, outcome }
})
const audit = (callID: string) => ({
  summary: "Fixture check",
  requirements: [
    { criterionID: "result", requirement: "Result", passed: true, evidence: [{ callID, summary: "Successful check" }] },
  ],
})

it.live("public updates reject verified, delivery and forged session ownership; legacy claims remain unverified", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* instance(directory, (storage) =>
      Effect.gen(function* () {
        const healing = RayaSelfHeal.make(storage)
        const item = yield* healing.create({ description: "Public claim boundary" })
        for (const input of [
          { status: "verified" as const },
          { reloadRequired: true },
          { workSessionID: SessionID.make("ses_forged") },
        ])
          expect(Exit.isFailure(yield* healing.update(item.id, input).pipe(Effect.exit))).toBe(true)
        yield* storage.replace(["raya", "self-heal", "item", item.id], {
          ...item,
          status: "verified",
          reloadRequired: true,
          updatedAt: 1,
        })
        const legacy = yield* healing.get(item.id)
        expect(legacy?.status).toBe("blocked")
        expect(legacy?.legacyVerification).toBe(true)
        expect(legacy?.completion).toBeUndefined()
        expect(legacy?.reloadRequired).toBe(false)
        const repeated = yield* healing.create({ description: item.description })
        expect(repeated.id).toBe(item.id)
        expect(repeated.status).toBe("blocked")
        expect(repeated.legacyVerification).toBe(true)
        expect((yield* healing.list()).length).toBe(1)
        expect((yield* healing.admit(item.id, { source: { root: "/other", commit: "b".repeat(40) } }))?.owned).toBe(
          false,
        )
      }),
    )
  }),
)

it.live("forged goal links and mismatched attempts cannot close a repair", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* instance(directory, (storage) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_owner")
        const { item } = yield* seed(storage, sessionID)
        const service = goals(storage, [])
        expect(
          Exit.isFailure(
            yield* service
              .create(SessionID.make("ses_forged"), "Result", undefined, undefined, item.id)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const state = yield* service.create(sessionID, "Result", undefined, undefined, item.id)
        expect(state.selfHealAttempt).toBeTruthy()
        expect(
          Exit.isFailure(yield* RayaSelfHeal.make(storage).link(item.id, sessionID, "other-attempt").pipe(Effect.exit)),
        ).toBe(true)
        expect((yield* RayaSelfHeal.make(storage).outcome(item.id))?.completion).toBeUndefined()
      }),
    )
  }),
)

it.live(
  "pending human review and failed evidence cannot publish a receipt; accepted audit retains full proof",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* instance(directory, (storage) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make("ses_review")
          const { item } = yield* seed(storage, sessionID)
          const rows: MessageV2.WithParts[] = []
          const service = goals(storage, rows)
          yield* service.create(sessionID, "Result", undefined, undefined, item.id, [
            { id: "result", description: "Result", verification: "Check result", review: true },
          ])
          const proof = transcript({ sessionID, tool: "bash", exit: 1 })
          rows.push(...proof.rows)
          expect(
            Exit.isFailure(
              yield* service
                .update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          if (proof.part!.state.status !== "completed") throw new Error("fixture")
          proof.part!.state.metadata.exit = 0
          const pending = yield* service.update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
          expect(pending.status).toBe("paused")
          expect((yield* RayaSelfHeal.make(storage).outcome(item.id))?.completion).toBeUndefined()
          const done = yield* service.edit(sessionID, { accept: true, expectedIntent: pending.intent! })
          expect(done.state.status).toBe("complete")
          const observed = yield* RayaSelfHeal.make(storage).get(item.id)
          expect(observed?.status).toBe("verified")
          expect(observed?.reloadRequired).toBe(false)
          const receipt = observed!.completion!
          expect(receipt.goal.review?.status).toBe("accepted")
          expect(receipt.goal.completedRevision).toBe(done.state.revision!)
          expect(receipt.goal.audit.requirements[0].evidence[0]).toMatchObject({
            sessionID,
            messageID: proof.part!.messageID,
            partID: proof.part!.id,
            callID: proof.part!.callID,
          })
          expect(receipt.goal.audit.requirements[0].evidence[0].record.digest).toHaveLength(64)
        }),
      )
    }),
  30_000,
)

it.live(
  "independent Storage contenders preserve one immutable receipt and reject conflicting audit",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const sessionID = SessionID.make("ses_contenders")
      const rows: MessageV2.WithParts[] = []
      const fixture = yield* instance(directory, (storage) =>
        Effect.gen(function* () {
          const fixture = yield* seed(storage, sessionID)
          yield* goals(storage, rows).create(sessionID, "Result", undefined, undefined, fixture.item.id)
          const proof = transcript({ sessionID, tool: "bash", exit: 0 })
          rows.push(...proof.rows)
          yield* goals(storage, rows).update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
          return { ...fixture, receipt: (yield* RayaSelfHeal.make(storage).outcome(fixture.item.id))!.completion! }
        }),
      )
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          instance(directory, (storage) =>
            RayaSelfHeal.make(storage).complete(fixture.item.id, sessionID, fixture.outcome.id, fixture.receipt.goal),
          ),
        ),
        { concurrency: 4 },
      )
      expect(new Set(results.map((row) => row.at))).toEqual(new Set([fixture.receipt.at]))
      expect(
        Exit.isFailure(
          yield* instance(directory, (storage) =>
            RayaSelfHeal.make(storage).complete(fixture.item.id, sessionID, fixture.outcome.id, {
              ...fixture.receipt.goal,
              objective: "different",
            }),
          ).pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* instance(directory, (storage) => storage.remove(["raya", "self-heal", "item", fixture.item.id]))
      expect(
        (yield* instance(directory, (storage) => RayaSelfHeal.make(storage).outcome(fixture.item.id)))?.completion,
      ).toEqual(fixture.receipt)
    }),
  30_000,
)

it.live(
  "receipt survives interrupted goal projection and retry reuses the recorded completion revision",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* instance(directory, (storage) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make("ses_interrupted")
          const fixture = yield* seed(storage, sessionID)
          const rows: MessageV2.WithParts[] = []
          const service = goals(storage, rows)
          yield* service.create(sessionID, "Result", undefined, undefined, fixture.item.id)
          const proof = transcript({ sessionID, tool: "bash", exit: 0 })
          rows.push(...proof.rows)
          const broken = goals(
            {
              ...storage,
              replace: (key, value) =>
                key[0] === "raya" && key[1] === "goal"
                  ? Effect.die(new Error("Injected interrupted goal projection"))
                  : storage.replace(key, value),
            },
            rows,
          )
          expect(
            Exit.isFailure(
              yield* broken
                .update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          const receipt = (yield* RayaSelfHeal.make(storage).outcome(fixture.item.id))!.completion!
          expect(receipt).toBeTruthy()
          expect((yield* service.get(sessionID))?.status).toBe("active")
          expect((yield* RayaSelfHeal.make(storage).get(fixture.item.id))?.status).toBe("verified")
          const done = yield* service.update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
          expect(done.revision).toBe(receipt.goal.completedRevision)
        }),
      )
    }),
  30_000,
)

it.live(
  "a goal revised during audit collection cannot publish stale completion",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* instance(directory, (storage) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make("ses_revision")
          const { item } = yield* seed(storage, sessionID)
          const rows: MessageV2.WithParts[] = []
          const service = goals(storage, rows)
          const initial = yield* service.create(sessionID, "Result", undefined, undefined, item.id)
          const proof = transcript({ sessionID, tool: "bash", exit: 0 })
          rows.push(...proof.rows)
          const racing = RayaGoal.make({
            storage,
            sessions: {
              children: () => Effect.succeed([]),
              get: (id) => storage.read<Session.Info>(["fixture-session", id]).pipe(Effect.orDie),
              messages: () =>
                service
                  .edit(sessionID, { objective: "Changed", expectedIntent: initial.intent! })
                  .pipe(Effect.as(rows), Effect.orDie),
            },
          })
          expect(
            Exit.isFailure(
              yield* racing
                .update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect((yield* RayaSelfHeal.make(storage).outcome(item.id))?.completion).toBeUndefined()
        }),
      )
    }),
  30_000,
)

it.live(
  "persisted session directory and attempt provenance gate creation, refinement and completion",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* instance(directory, (storage) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make("ses_provenance")
          const { item } = yield* seed(storage, sessionID)
          const saved = yield* storage.read<Session.Info>(["fixture-session", sessionID])
          const rows: MessageV2.WithParts[] = []
          const service = goals(storage, rows)
          yield* storage.replace(["fixture-session", sessionID], { ...saved, directory: "/unrelated-project" })
          expect(
            Exit.isFailure(yield* service.create(sessionID, "Result", undefined, undefined, item.id).pipe(Effect.exit)),
          ).toBe(true)
          yield* storage.replace(["fixture-session", sessionID], saved)
          yield* service.create(sessionID, "Result", undefined, undefined, item.id)
          const proof = transcript({ sessionID, tool: "bash", exit: 0 })
          rows.push(...proof.rows)
          yield* storage.replace(["fixture-session", sessionID], {
            ...saved,
            metadata: { ...saved.metadata, rayaSelfHealAttempt: "foreign" },
          })
          const info = yield* selfHealTools(service, RayaSelfHeal.make(storage)).refine
          const tool = yield* info.init()
          const ctx = {
            sessionID,
            messageID: MessageID.ascending(),
            agent: "chief",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }
          expect(Exit.isFailure(yield* tool.execute({ title: "Unauthorized rename" }, ctx).pipe(Effect.exit))).toBe(
            true,
          )
          expect((yield* RayaSelfHeal.make(storage).get(item.id))?.title).toBe(item.title)
          expect(
            Exit.isFailure(
              yield* service
                .update(sessionID, { status: "complete", audit: audit(proof.part!.callID) })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect((yield* RayaSelfHeal.make(storage).outcome(item.id))?.completion).toBeUndefined()
          expect(
            Exit.isFailure(
              yield* service.update(sessionID, { status: "blocked", reason: "foreign claim" }).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect((yield* RayaSelfHeal.make(storage).get(item.id))?.status).toBe("triaged")
        }),
      )
    }),
  30_000,
)
