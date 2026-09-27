import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import * as Truncate from "@/tool/truncate"

test("a rejected Chief completion keeps Auto in the task phase", async () => {
  const id = SessionID.make("ses_chief_rejected_completion")
  const metadata: Record<string, unknown> = { [RayaChief.phaseKey]: "task" }
  const sessions = {
    get: () => Effect.succeed({ metadata }),
    setMetadata: ({ metadata: next }: { metadata: Record<string, unknown> }) =>
      Effect.sync(() => Object.assign(metadata, next)),
  } as unknown as Pick<Session.Interface, "get" | "setMetadata">
  const goals = {
    get: () => Effect.succeed({ status: "active" }),
    update: () => Effect.fail(new RayaGoal.AuditError({ message: "Branch evidence is incomplete" })),
  } as unknown as ReturnType<typeof RayaGoal.make>
  const tool = goalTools(goals, sessions).update
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const def = yield* (yield* tool).init()
      return yield* def.execute(
        { status: "complete", audit: { summary: "Claimed completion", requirements: [] } },
        {
          sessionID: id,
          messageID: MessageID.ascending(),
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    }).pipe(
      Effect.provideService(Truncate.Service, {
        output: (text) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface),
      Effect.provideService(
        Agent.Service,
        Agent.Service.of({ get: () => Effect.succeed({ name: "auto" }) } as unknown as Agent.Interface),
      ),
    ),
  )
  expect(response.title).toBe("Completion audit rejected")
  expect(response.output).toContain("Branch evidence is incomplete")
  expect(RayaChief.phase(metadata)).toBe("task")
})

test("a completed goal cannot be reopened by a later unrelated request", async () => {
  const id = SessionID.make("ses_chief_completed_followup")
  const metadata: Record<string, unknown> = { [RayaChief.phaseKey]: "goal" }
  const sessions = {
    get: () => Effect.succeed({ metadata }),
    setMetadata: ({ metadata: next }: { metadata: Record<string, unknown> }) =>
      Effect.sync(() => Object.assign(metadata, next)),
  } as unknown as Pick<Session.Interface, "get" | "setMetadata">
  const calls: RayaGoal.ModelUpdate[] = []
  const goals = {
    get: () => Effect.succeed({ status: "complete" }),
    update: (_id: unknown, input: RayaGoal.ModelUpdate) =>
      Effect.sync(() => {
        calls.push(input)
        throw new Error("Completed goal was updated")
      }),
  } as unknown as ReturnType<typeof RayaGoal.make>
  const tool = goalTools(goals, sessions).update

  for (const status of ["active", "paused", "blocked", "complete"] as const) {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const def = yield* (yield* tool).init()
        return yield* def.execute(
          status === "complete"
            ? { status, audit: { summary: "Reopen previous goal", requirements: [] } }
            : status === "blocked" || status === "paused"
              ? { status, reason: "A new unrelated request" }
              : { status },
          {
            sessionID: id,
            messageID: MessageID.ascending(),
            agent: "auto",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
      }).pipe(
        Effect.provideService(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        } as Truncate.Interface),
        Effect.provideService(
          Agent.Service,
          Agent.Service.of({ get: () => Effect.succeed({ name: "auto" }) } as unknown as Agent.Interface),
        ),
      ),
    )
    expect(response.title).toBe("Goal already complete")
    expect(response.output).toContain("Handle the current user request directly")
    expect(response.output).toContain("Do not ask about the completed goal")
    expect(response.metadata.status).toBe("complete")
  }
  expect(calls).toEqual([])
  expect(RayaChief.phase(metadata)).toBe("done")
})

test("reading a historical completed goal releases Chief only after task work", async () => {
  const id = SessionID.make("ses_chief_completed_read")
  const metadata: Record<string, unknown> = { [RayaChief.phaseKey]: "task" }
  const sessions = {
    get: () => Effect.succeed({ metadata }),
    setMetadata: ({ metadata: next }: { metadata: Record<string, unknown> }) =>
      Effect.sync(() => Object.assign(metadata, next)),
  } as unknown as Pick<Session.Interface, "get" | "setMetadata">
  const goals = {
    get: () => Effect.succeed({ status: "complete", objective: "Earlier finished work" }),
    evidence: () => Effect.succeed([]),
  } as unknown as ReturnType<typeof RayaGoal.make>
  const tool = goalTools(goals, sessions).get
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const def = yield* (yield* tool).init()
      const ctx = {
        sessionID: id,
        messageID: MessageID.ascending(),
        agent: "auto",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const early = yield* def.execute({}, ctx)
      expect(early.metadata.status).toBe("complete")
      expect(RayaChief.phase(metadata)).toBe("task")
      metadata[RayaChief.phaseKey] = "goal"
      return yield* def.execute({}, ctx)
    }).pipe(
      Effect.provideService(Truncate.Service, {
        output: (text) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface),
      Effect.provideService(
        Agent.Service,
        Agent.Service.of({ get: () => Effect.succeed({ name: "auto" }) } as unknown as Agent.Interface),
      ),
    ),
  )
  expect(response.output).toContain("Earlier finished work")
  expect(RayaChief.phase(metadata)).toBe("done")
})

test("reading an active goal leaves the Chief audit phase available", async () => {
  const id = SessionID.make("ses_chief_active_read")
  const metadata: Record<string, unknown> = { [RayaChief.phaseKey]: "goal" }
  const sessions = {
    get: () => Effect.succeed({ metadata }),
    setMetadata: ({ metadata: next }: { metadata: Record<string, unknown> }) =>
      Effect.sync(() => Object.assign(metadata, next)),
  } as unknown as Pick<Session.Interface, "get" | "setMetadata">
  const goals = {
    get: () => Effect.succeed({ status: "active", objective: "Current work" }),
    evidence: () => Effect.succeed([]),
  } as unknown as ReturnType<typeof RayaGoal.make>
  const tool = goalTools(goals, sessions).get
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const def = yield* (yield* tool).init()
      return yield* def.execute(
        {},
        {
          sessionID: id,
          messageID: MessageID.ascending(),
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    }).pipe(
      Effect.provideService(Truncate.Service, {
        output: (text) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface),
      Effect.provideService(
        Agent.Service,
        Agent.Service.of({ get: () => Effect.succeed({ name: "auto" }) } as unknown as Agent.Interface),
      ),
    ),
  )
  expect(response.metadata.status).toBe("active")
  expect(RayaChief.phase(metadata)).toBe("goal")
})
