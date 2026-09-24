import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RayaChief } from "@/kilocode/chief"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { ChiefRequestReview } from "@/kilocode/chief/request-review"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Storage.node])))
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const proposals = [
  {
    id: "safety",
    name: "Safety audit",
    specialist: "researcher",
    access: "read" as const,
    brief: { objective: "Audit authorization", constraints: [], expectedReturn: "Safety findings" },
    scope: ["authorization"],
    dependsOn: [],
    independence: "Separate policy scope.",
    authority: "Inspection only.",
  },
  {
    id: "design",
    name: "UX audit",
    specialist: "designer",
    access: "read" as const,
    brief: { objective: "Audit navigation", constraints: [], expectedReturn: "UX findings" },
    scope: ["navigation"],
    dependsOn: [],
    independence: "Separate navigation scope.",
    authority: "Inspection only.",
  },
]

const setup = Effect.fn("ChiefRequestRotationTest.setup")(function* () {
  const sessions = yield* Session.Service
  const storage = yield* Storage.Service
  const parent = yield* sessions.create({ title: "Request rotation" })
  const request = "Audit authorization and navigation"
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "auto",
    model,
    time: { created: Date.now() },
  })
  const part = PartID.ascending()
  yield* sessions.updatePart({ id: part, messageID: user.id, sessionID: parent.id, type: "text", text: request })
  yield* sessions.setMetadata({
    sessionID: parent.id,
    metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task" },
  })
  const ledger = ChiefRequestPlan.make(storage, sessions)
  const plan = yield* ledger.start({
    sessionID: parent.id,
    requestID: user.id,
    proposals,
    agents: [
      { name: "researcher", mode: "subagent" },
      { name: "designer", mode: "subagent" },
    ],
    parent: Permission.fromConfig({ task: "allow" }),
  })
  return { sessions, storage, parent, user, part, ledger, plan }
})

const advance = Effect.fn("ChiefRequestRotationTest.advance")(function* (
  state: Effect.Success<ReturnType<typeof setup>>,
) {
  const request = "Audit the next request"
  const user = yield* state.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: state.parent.id,
    agent: "auto",
    model,
    time: { created: Date.now() },
  })
  yield* state.sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: state.parent.id,
    type: "text",
    text: request,
  })
  yield* state.sessions.setMetadata({
    sessionID: state.parent.id,
    metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task" },
  })
  return user
})

const complete = Effect.fn("ChiefRequestRotationTest.complete")(function* (
  state: Effect.Success<ReturnType<typeof setup>>,
) {
  const review = ChiefRequestReview.make(state.storage, state.sessions)
  const evidence = [] as {
    sessionID: SessionID
    requestID: MessageID
    revision: string
    branchID: string
    callID: string
    childID: SessionID
    messageID: MessageID
    evidence: { messageID: MessageID; partID: PartID; callID: string }
  }[]
  for (const branch of state.plan.branches) {
    const identity = {
      sessionID: state.parent.id,
      requestID: state.user.id,
      revision: state.plan.identity.revision,
      branchID: branch.id,
      callID: `call-${branch.id}`,
    }
    yield* state.ledger.reserve(identity)
    const child = yield* state.sessions.create({
      title: branch.name,
      parentID: state.parent.id,
      agent: branch.specialist,
      metadata: TaskAuthority.save({}, "read"),
    })
    const input = yield* state.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: child.id,
      agent: branch.specialist,
      model,
      time: { created: Date.now() },
    })
    yield* state.sessions.updatePart({
      id: PartID.ascending(),
      messageID: input.id,
      sessionID: child.id,
      type: "text",
      text: branch.brief.objective,
    })
    yield* state.ledger.admit({ ...identity, childID: child.id, messageID: input.id })
    const tool = yield* state.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.id,
      sessionID: child.id,
      mode: branch.specialist,
      agent: branch.specialist,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: Date.now(), completed: Date.now() },
    })
    const partID = PartID.ascending()
    yield* state.sessions.updatePart({
      id: partID,
      messageID: tool.id,
      sessionID: child.id,
      type: "tool",
      tool: "read",
      callID: `read-${branch.id}`,
      state: {
        status: "completed",
        input: {},
        output: `${branch.id} evidence`,
        title: "Read",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    })
    const final = yield* state.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.id,
      sessionID: child.id,
      mode: branch.specialist,
      agent: branch.specialist,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: Date.now(), completed: Date.now() },
    })
    yield* state.sessions.updatePart({
      id: PartID.ascending(),
      messageID: final.id,
      sessionID: child.id,
      type: "text",
      text: `${branch.id} report`,
    })
    yield* state.ledger.settle({
      ...identity,
      childID: child.id,
      messageID: input.id,
      state: "completed",
      result: "Completed",
    })
    evidence.push({
      ...identity,
      childID: child.id,
      messageID: input.id,
      evidence: { messageID: tool.id, partID, callID: `read-${branch.id}` },
    })
  }
  for (const branch of evidence) {
    const view = yield* review.inspect(state.parent.id)
    const assistant = yield* state.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: state.user.id,
      sessionID: state.parent.id,
      mode: "auto",
      agent: "auto",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: Date.now(), completed: Date.now() },
    })
    const partID = PartID.ascending()
    yield* state.sessions.updatePart({
      id: partID,
      messageID: assistant.id,
      sessionID: state.parent.id,
      type: "tool",
      tool: "chief_inspect",
      callID: `inspect-${branch.branchID}`,
      state: {
        status: "completed",
        input: {},
        output: JSON.stringify(view),
        title: "Inspect",
        metadata: { requestID: state.user.id, requestRevision: state.plan.identity.revision },
        time: { start: Date.now(), end: Date.now() },
      },
    })
    yield* review.review({
      ...branch,
      inspect: { messageID: assistant.id, partID, callID: `inspect-${branch.branchID}` },
      evidence: branch.evidence,
      assessment: "Verified",
    })
  }
  yield* review.synthesize({
    sessionID: state.parent.id,
    requestID: state.user.id,
    revision: state.plan.identity.revision,
    summary: "Both audits complete",
    findings: evidence.map((branch) => ({ branchID: branch.branchID, conclusion: "Verified" })),
  })
})

describe("request-bound Chief marker rotation", () => {
  it.instance(
    "retires only a fully synthesized plan and binds a later authored request",
    () =>
      Effect.gen(function* () {
        const state = yield* setup()
        yield* complete(state)
        const next = yield* advance(state)
        const input = { sessionID: state.parent.id, priorRequestID: state.user.id, nextRequestID: next.id }
        const receipt = yield* state.ledger.rotate(input)
        expect(receipt.prior).toEqual(state.plan.identity)
        expect(receipt.next.requestID).toBe(next.id)
        expect(yield* ChiefRequestPlan.active(state.storage, state.parent.id)).toBeUndefined()
        expect((yield* state.ledger.read(state.parent.id, state.user.id))?.synthesis?.summary).toBe(
          "Both audits complete",
        )
        yield* state.storage.create(["raya", "chief", "request-plan", state.parent.id, "active"], {
          version: 1,
          identity: state.plan.identity,
        })
        expect((yield* ChiefRequestPlan.make(state.storage, state.sessions).rotate(input)).at).toBe(receipt.at)
        expect(yield* ChiefRequestPlan.active(state.storage, state.parent.id)).toBeUndefined()
        const later = yield* state.ledger.start({
          sessionID: state.parent.id,
          requestID: next.id,
          proposals,
          agents: [
            { name: "researcher", mode: "subagent" },
            { name: "designer", mode: "subagent" },
          ],
          parent: Permission.fromConfig({ task: "allow" }),
        })
        expect(later.identity.requestID).toBe(next.id)
        expect(later.branches.every((branch) => branch.state === "planned" && !branch.callID)).toBe(true)
        expect((yield* ChiefRequestPlan.active(state.storage, state.parent.id))?.identity.requestID).toBe(next.id)

        const gap = yield* setup()
        yield* complete(gap)
        const intermediate = yield* advance(gap)
        yield* gap.ledger.rotate({
          sessionID: gap.parent.id,
          priorRequestID: gap.user.id,
          nextRequestID: intermediate.id,
        })
        const laterUser = yield* advance(gap)
        const laterPlan = yield* gap.ledger.start({
          sessionID: gap.parent.id,
          requestID: laterUser.id,
          proposals,
          agents: [
            { name: "researcher", mode: "subagent" },
            { name: "designer", mode: "subagent" },
          ],
          parent: Permission.fromConfig({ task: "allow" }),
        })
        expect(laterPlan.identity.requestID).toBe(laterUser.id)
      }),
    60_000,
  )

  it.instance(
    "keeps unresolved and marker-only plans active rather than hiding their authority",
    () =>
      Effect.gen(function* () {
        const running = yield* setup()
        yield* running.ledger.reserve({
          sessionID: running.parent.id,
          requestID: running.user.id,
          revision: running.plan.identity.revision,
          branchID: "safety",
          callID: "call-safety",
        })
        const newer = yield* advance(running)
        expect(
          Exit.isFailure(
            yield* running.ledger
              .rotate({
                sessionID: running.parent.id,
                priorRequestID: running.user.id,
                nextRequestID: newer.id,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* ChiefRequestPlan.active(running.storage, running.parent.id))?.identity.requestID).toBe(
          running.user.id,
        )

        const lost = yield* setup()
        yield* lost.storage.remove(["raya", "chief", "request-plan", lost.parent.id, "active"])
        const subsequent = yield* advance(lost)
        expect(
          Exit.isFailure(
            yield* lost.ledger
              .start({
                sessionID: lost.parent.id,
                requestID: subsequent.id,
                proposals,
                agents: [
                  { name: "researcher", mode: "subagent" },
                  { name: "designer", mode: "subagent" },
                ],
                parent: Permission.fromConfig({ task: "allow" }),
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* lost.ledger.readRotation(lost.parent.id, lost.user.id)).toBeUndefined()

        const unknown = yield* setup()
        const branch = {
          sessionID: unknown.parent.id,
          requestID: unknown.user.id,
          revision: unknown.plan.identity.revision,
          branchID: "safety",
          callID: "call-unknown",
        }
        yield* unknown.ledger.reserve(branch)
        const childID = SessionID.create()
        const messageID = MessageID.ascending()
        yield* unknown.ledger.admit({ ...branch, childID, messageID })
        yield* unknown.ledger.settle({ ...branch, childID, messageID, state: "unknown", result: "Uncertain" })
        const changed = yield* advance(unknown)
        expect(
          Exit.isFailure(
            yield* unknown.ledger
              .rotate({
                sessionID: unknown.parent.id,
                priorRequestID: unknown.user.id,
                nextRequestID: changed.id,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* ChiefRequestPlan.active(unknown.storage, unknown.parent.id))?.identity.requestID).toBe(
          unknown.user.id,
        )

        const missing = yield* setup()
        yield* missing.storage.remove(ChiefRequestPlan.key(missing.parent.id, missing.user.id))
        const next = yield* advance(missing)
        expect(
          Exit.isFailure(
            yield* missing.ledger
              .rotate({
                sessionID: missing.parent.id,
                priorRequestID: missing.user.id,
                nextRequestID: next.id,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* missing.ledger.readRotation(missing.parent.id, missing.user.id)).toBeUndefined()
        expect((yield* ChiefRequestPlan.active(missing.storage, missing.parent.id))?.identity.requestID).toBe(
          missing.user.id,
        )
        expect(
          Exit.isFailure(
            yield* missing.ledger
              .start({
                sessionID: missing.parent.id,
                requestID: next.id,
                proposals,
                agents: [
                  { name: "researcher", mode: "subagent" },
                  { name: "designer", mode: "subagent" },
                ],
                parent: Permission.fromConfig({ task: "allow" }),
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        const orphan = yield* setup()
        yield* complete(orphan)
        const target = yield* advance(orphan)
        yield* orphan.ledger.rotate({
          sessionID: orphan.parent.id,
          priorRequestID: orphan.user.id,
          nextRequestID: target.id,
        })
        yield* orphan.storage.remove(ChiefRequestPlan.key(orphan.parent.id, orphan.user.id))
        expect(
          Exit.isFailure(
            yield* orphan.ledger
              .start({
                sessionID: orphan.parent.id,
                requestID: target.id,
                proposals,
                agents: [
                  { name: "researcher", mode: "subagent" },
                  { name: "designer", mode: "subagent" },
                ],
                parent: Permission.fromConfig({ task: "allow" }),
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        const edited = yield* setup()
        yield* complete(edited)
        const future = yield* advance(edited)
        yield* edited.sessions.updatePart({
          id: edited.part,
          messageID: edited.user.id,
          sessionID: edited.parent.id,
          type: "text",
          text: "Altered old request",
        })
        expect(
          Exit.isFailure(
            yield* edited.ledger
              .rotate({
                sessionID: edited.parent.id,
                priorRequestID: edited.user.id,
                nextRequestID: future.id,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* ChiefRequestPlan.active(edited.storage, edited.parent.id))?.identity.requestID).toBe(
          edited.user.id,
        )
      }),
    30_000,
  )
})
