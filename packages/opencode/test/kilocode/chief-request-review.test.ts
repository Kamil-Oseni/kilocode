import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { ChiefRequestReview } from "@/kilocode/chief/request-review"
import { RayaChief } from "@/kilocode/chief"
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

const setup = Effect.fn("ChiefRequestReviewTest.setup")(function* () {
  const sessions = yield* Session.Service
  const storage = yield* Storage.Service
  const parent = yield* sessions.create({ title: "Request review" })
  const request = "Audit authorization and navigation"
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "auto",
    model,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: parent.id,
    type: "text",
    text: request,
  })
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
  const review = ChiefRequestReview.make(storage, sessions)
  return { sessions, storage, parent, user, plan, ledger, review }
})

const child = Effect.fn("ChiefRequestReviewTest.child")(function* (
  state: Effect.Success<ReturnType<typeof setup>>,
  id: "safety" | "design",
  status: "completed" | "failed" | "unknown" = "completed",
) {
  const specialist = id === "safety" ? "researcher" : "designer"
  const callID = `call-${id}`
  const identity = {
    sessionID: state.parent.id,
    requestID: state.user.id,
    revision: state.plan.identity.revision,
    branchID: id,
    callID,
  }
  yield* state.ledger.reserve(identity)
  const session = yield* state.sessions.create({
    title: id,
    parentID: state.parent.id,
    agent: specialist,
    metadata: TaskAuthority.save({}, "read"),
  })
  const input = yield* state.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: session.id,
    agent: specialist,
    model,
    time: { created: Date.now() },
  })
  yield* state.sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.id,
    sessionID: session.id,
    type: "text",
    text: `Inspect ${id}`,
  })
  yield* state.ledger.admit({ ...identity, childID: session.id, messageID: input.id })
  const tool = yield* state.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: input.id,
    sessionID: session.id,
    mode: specialist,
    agent: specialist,
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
    sessionID: session.id,
    type: "tool",
    tool: "read",
    callID: `read-${id}`,
    state: {
      status: "completed",
      input: {},
      output: `${id} evidence`,
      title: "Read",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })
  const final = yield* state.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: input.id,
    sessionID: session.id,
    mode: specialist,
    agent: specialist,
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
    sessionID: session.id,
    type: "text",
    text: `${id} report`,
  })
  yield* state.ledger.settle({
    ...identity,
    childID: session.id,
    messageID: input.id,
    state: status,
    result: status,
  })
  return {
    ...identity,
    childID: session.id,
    messageID: input.id,
    evidence: { messageID: tool.id, partID, callID: `read-${id}` },
  }
})

const receipt = Effect.fn("ChiefRequestReviewTest.receipt")(function* (
  state: Effect.Success<ReturnType<typeof setup>>,
  output?: unknown,
) {
  const view = yield* state.review.inspect(state.parent.id)
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
    callID: "call-inspect",
    state: {
      status: "completed",
      input: {},
      output: JSON.stringify(output ?? view),
      title: "Inspect",
      metadata: { requestID: state.user.id, requestRevision: state.plan.identity.revision },
      time: { start: Date.now(), end: Date.now() },
    },
  })
  return { messageID: assistant.id, partID, callID: "call-inspect" }
})

describe("request-bound Chief review eligibility", () => {
  it.instance(
    "requires two exact reviewed child turns before durable synthesis",
    () =>
      Effect.gen(function* () {
        const state = yield* setup()
        const safety = yield* child(state, "safety")
        const design = yield* child(state, "design")
        const input = {
          sessionID: state.parent.id,
          requestID: state.user.id,
          revision: state.plan.identity.revision,
        }
        expect(
          Exit.isFailure(
            yield* state.review
              .synthesize({
                ...input,
                summary: "Both passed",
                findings: [
                  { branchID: "safety", conclusion: "Safe" },
                  { branchID: "design", conclusion: "Clear" },
                ],
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const first = yield* receipt(state)
        expect(
          Exit.isFailure(
            yield* state.review
              .review({
                ...safety,
                inspect: first,
                evidence: { ...safety.evidence, partID: "wrong" },
                assessment: "Verified",
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.review
              .review({ ...safety, inspect: first, evidence: design.evidence, assessment: "Wrong child" })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const changed = yield* receipt(state, { version: 1, identity: state.plan.identity, branches: [] })
        expect(
          Exit.isFailure(
            yield* state.review
              .review({ ...safety, inspect: changed, evidence: safety.evidence, assessment: "Forged view" })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* state.review.review({ ...safety, inspect: first, evidence: safety.evidence, assessment: "Verified" })
        const second = yield* receipt(state)
        yield* state.review.review({ ...design, inspect: second, evidence: design.evidence, assessment: "Verified" })
        const findings = [
          { branchID: "safety", conclusion: "Safe" },
          { branchID: "design", conclusion: "Clear" },
        ]
        const saved = yield* state.review.synthesize({ ...input, summary: "Both passed", findings })
        expect(saved.findings).toEqual(findings)
        const restarted = ChiefRequestReview.make(state.storage, state.sessions)
        expect((yield* restarted.synthesize({ ...input, summary: "Both passed", findings })).at).toBe(saved.at)
        expect((yield* state.ledger.read(state.parent.id, state.user.id))?.synthesis).toEqual(saved)
        expect(
          Exit.isFailure(yield* restarted.synthesize({ ...input, summary: "Changed", findings }).pipe(Effect.exit)),
        ).toBe(true)
      }),
    30_000,
  )

  it.instance(
    "refuses failed or stale request branches despite saved child evidence",
    () =>
      Effect.gen(function* () {
        const state = yield* setup()
        const safety = yield* child(state, "safety")
        yield* child(state, "design", "unknown")
        const input = {
          sessionID: state.parent.id,
          requestID: state.user.id,
          revision: state.plan.identity.revision,
        }
        const first = yield* receipt(state)
        yield* state.review.review({ ...safety, inspect: first, evidence: safety.evidence, assessment: "Verified" })
        expect(
          Exit.isFailure(
            yield* state.review
              .synthesize({
                ...input,
                summary: "Blocked",
                findings: [
                  { branchID: "safety", conclusion: "Safe" },
                  { branchID: "design", conclusion: "Unknown" },
                ],
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const newer = yield* state.sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: state.parent.id,
          agent: "auto",
          model,
          time: { created: Date.now() },
        })
        yield* state.sessions.updatePart({
          id: PartID.ascending(),
          messageID: newer.id,
          sessionID: state.parent.id,
          type: "text",
          text: "New request",
        })
        expect(Exit.isFailure(yield* state.review.inspect(state.parent.id).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* state.review.synthesize({ ...input, summary: "Old", findings: [] }).pipe(Effect.exit)),
        ).toBe(true)
        const stale = yield* setup()
        const done = yield* child(stale, "safety")
        yield* child(stale, "design")
        const later = yield* stale.sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: stale.parent.id,
          agent: "auto",
          model,
          time: { created: Date.now() },
        })
        yield* stale.sessions.updatePart({
          id: PartID.ascending(),
          messageID: later.id,
          sessionID: stale.parent.id,
          type: "text",
          text: "Different request before inspection",
        })
        expect(Exit.isFailure(yield* stale.review.inspect(stale.parent.id).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* stale.review
              .review({
                ...done,
                inspect: { messageID: later.id, partID: "none", callID: "none" },
                evidence: done.evidence,
                assessment: "Too late",
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const corrupt = yield* setup()
        const record = yield* corrupt.ledger.read(corrupt.parent.id, corrupt.user.id)
        if (!record) throw new Error("Missing saved request plan")
        yield* corrupt.storage.replace(ChiefRequestPlan.key(corrupt.parent.id, corrupt.user.id), {
          ...record,
          branches: record.branches.map((branch) =>
            branch.id === "safety" ? { ...branch, access: "edit" as const } : branch,
          ),
        })
        expect(Exit.isFailure(yield* corrupt.review.inspect(corrupt.parent.id).pipe(Effect.exit))).toBe(true)
      }),
    30_000,
  )
})
