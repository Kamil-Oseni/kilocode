import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import * as Permission from "@/permission"
import type * as Tool from "@/tool/tool"
import { Git } from "@/git"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { Question } from "@/question"
import { SessionID, MessageID } from "@/session/schema"
import { english, scheduleTaskTool } from "@/kilocode/tool/schedule-task"
import { confirm } from "@/kilocode/tool/routine-confirmation"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

test.each([
  ["every Monday at 9am", "0 9 * * 1"],
  ["every Sunday at 12am", "0 0 * * 0"],
  ["every Saturday at 12pm", "0 12 * * 6"],
  ["Weekday mornings", "0 9 * * 1-5"],
  ["every Tuesday at 23:59", "59 23 * * 2"],
])("backend schedule preserves %s", (phrase, expr) => {
  expect(english(phrase)).toEqual({ kind: "cron", expr })
})

test.each([
  "every 2 hours",
  "tomorrow morning",
  "every Monday at 9am except holidays",
  "daily at 25:00",
  "daily at 12:60",
  "daily at 13pm",
  "in 0 minutes",
  "in 9007199254740991 hours",
  "manual tomorrow",
  "when CI fails on main or staging",
])("backend rejects unsupported phrase %s", (phrase) => {
  expect(() => english(phrase)).toThrow()
})

test("documented manual/delay aliases and case-sensitive event filters are preserved", () => {
  expect(english("only when I ask")).toEqual({ kind: "manual" })
  const before = Date.now()
  const schedule = english("once in 2 minutes")
  if (schedule.kind !== "once") throw new Error("Expected one-time schedule")
  expect(schedule.at).toBeGreaterThanOrEqual(before + 120_000)
  expect(schedule.at).toBeLessThanOrEqual(Date.now() + 120_000)
  expect(english("when CI fails on Feature/Fix-123")).toEqual({
    kind: "event",
    source: "ci",
    filter: "Feature/Fix-123",
  })
})

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Permission.node),
    AppNodeBuilder.build(Truncate.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(Git.node),
    Layer.succeed(
      Question.Service,
      Question.Service.of({
        ask: (input) => Effect.succeed(input.questions.map(() => ["raya-option:confirm"])),
        reply: () => Effect.void,
        reject: () => Effect.void,
        list: () => Effect.succeed([]),
        dismissAll: () => Effect.void,
      }),
    ),
  ),
)

const report = {
  destination: "conversation" as const,
  description: "Routine report",
  criteria: [{ id: "evidence", description: "Show the evidence", verification: "Cite the source" }],
}

function assignment(name: string, objective = "Work") {
  return {
    name,
    role: "generalist",
    objective,
    output: report,
    when: "only when I ask",
    capabilities: [] as string[],
    access: "brief" as const,
    tools: [] as string[],
  }
}

it.live(
  "scheduling honors permission policy before persistence and does not reauthorize completed receipts",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const input = {
          storage: yield* Storage.Service,
          database: yield* Database.Service,
          sessions: {
            create: () => Effect.die("must not start"),
            get: () => Effect.die("must not read session"),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          },
        }
        const tool = yield* (yield* scheduleTaskTool(input)).init()
        const requests: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx: Tool.Context = {
          sessionID: SessionID.make("ses_schedule_permission"),
          messageID: MessageID.make("msg_schedule_permission"),
          callID: "permission-review",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (request) =>
            Effect.gen(function* () {
              requests.push(request)
              expect(yield* RayaTask.make(input).list()).toEqual([])
              yield* permission.ask({
                ...request,
                sessionID: ctx.sessionID,
                ruleset: Permission.fromConfig({
                  schedule_task: { "*": "allow", "access:full": "deny", "capability:money": "deny" },
                }),
              })
            }).pipe(Effect.orDie),
        }
        for (const params of [
          { ...assignment("Editing"), access: "full" as const },
          { ...assignment("Records"), capabilities: ["money"] },
        ]) {
          const result = yield* tool
            .execute({ ...params, runNow: true }, { ...ctx, callID: params.name })
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(yield* RayaTask.make(input).list()).toEqual([])
          expect(yield* input.storage.list(["raya", "agent-claims"])).toEqual([])
        }
        expect(requests[0]?.patterns).toEqual(["access:full"])
        expect(requests[1]?.patterns).toEqual(["access:brief", "capability:money"])
        const params = {
          ...assignment("Brief", "Summarize the project"),
          output: {
            destination: "conversation" as const,
            description: "Project summary",
            criteria: [
              { id: "evidence", description: "Identify source files", verification: "Include a path for each finding" },
            ],
          },
        }
        const keyed = { ...ctx, callID: "approved" }
        const accepted = yield* tool.execute(params, keyed)
        expect(accepted.title).toBe("Agent assigned")
        expect(requests[2]?.metadata.output).toEqual(params.output)
        expect(accepted.metadata.output).toEqual(params.output)
        expect(accepted.metadata).toMatchObject({ view: "routines" })
        expect(typeof accepted.metadata.agentID).toBe("string")
        expect(accepted.output).toContain("Acceptance criteria: evidence")
        expect((yield* RayaTask.make(input).list())[0]?.output).toEqual(params.output)
        expect(requests[2]?.metadata).toMatchObject({
          name: "Brief",
          objective: params.objective,
          access: "brief",
          capabilities: [],
          tools: [],
          schedule: { kind: "manual" },
          runNow: false,
        })
        const replay = yield* tool.execute(params, {
          ...keyed,
          ask: () => Effect.die("completed requests must not ask or execute again"),
        })
        expect(replay).toEqual(JSON.parse(JSON.stringify(accepted)))
        expect(yield* RayaTask.make(input).list()).toHaveLength(1)
        expect(yield* permission.list()).toEqual([])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)
it.live(
  "standing workers require an exact in-chat confirmation even when tool permission allows them",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const input = {
          storage: yield* Storage.Service,
          database: yield* Database.Service,
          sessions: {
            create: () => Effect.die("must not start"),
            get: () => Effect.die("must not read session"),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          },
        }
        const tool = yield* (yield* scheduleTaskTool(input)).init()
        const ctx: Tool.Context = {
          sessionID: SessionID.make("ses_schedule_confirm"),
          messageID: MessageID.make("msg_schedule_confirm"),
          callID: "exact-worker",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const params = assignment("Review first", "Summarize a harmless local note")
        const question = (answer: "confirm" | "cancel") =>
          Question.Service.of({
            ask: (input) => {
              expect(input.questions[0]?.question).toContain("Review first")
              expect(input.questions[0]?.question).toContain("questions only")
              return Effect.succeed([[`raya-option:${answer}`]])
            },
            reply: () => Effect.void,
            reject: () => Effect.void,
            list: () => Effect.succeed([]),
            dismissAll: () => Effect.void,
          })
        const denied = yield* tool
          .execute(params, ctx)
          .pipe(Effect.provideService(Question.Service, question("cancel")))
        expect(denied.title).toBe("Routine creation cancelled")
        expect(yield* RayaTask.make(input).list()).toEqual([])
        const repeated = yield* tool
          .execute(params, { ...ctx, callID: "same-user-retry" })
          .pipe(
            Effect.provideService(
              Question.Service,
              Question.Service.of({ ...question("confirm"), ask: () => Effect.die("denial must not ask again") }),
            ),
          )
        expect(repeated.title).toBe("Routine creation cancelled")
        expect(yield* RayaTask.make(input).list()).toEqual([])
        const missing = yield* tool
          .execute(params, { ...ctx, callID: undefined })
          .pipe(Effect.provideService(Question.Service, question("confirm")))
        expect(missing.title).toBe("Routine request needs review")
        expect(missing.output).toContain("stable tool call")
        expect(yield* RayaTask.make(input).list()).toEqual([])
        const next = { ...ctx, messageID: MessageID.make("msg_schedule_confirm_next"), callID: "new-user-request" }
        const approved = yield* tool
          .execute(params, next)
          .pipe(Effect.provideService(Question.Service, question("confirm")))
        expect(approved.title).toBe("Agent assigned")
        expect((yield* RayaTask.make(input).list()).map((item) => item.name)).toEqual([params.name])
        const replay = yield* tool.execute(params, next).pipe(
          Effect.provideService(
            Question.Service,
            Question.Service.of({
              ...question("confirm"),
              ask: () => Effect.die("approved plan must not ask again"),
            }),
          ),
        )
        expect(replay).toEqual(approved)
        expect(yield* RayaTask.make(input).list()).toHaveLength(1)
        const delay = { ...assignment("Short delay"), when: "in 2 minutes" }
        const delayed = { ...ctx, messageID: MessageID.make("msg_schedule_delay"), callID: "relative-delay" }
        const firstDelay = yield* tool.execute(delay, delayed)
        expect(firstDelay.title).toBe("Agent assigned")
        yield* Effect.sleep("20 millis")
        const changed = yield* tool.execute(delay, delayed)
        expect(changed).toEqual(JSON.parse(JSON.stringify(firstDelay)))
        expect(yield* RayaTask.make(input).list()).toHaveLength(2)
        const review = { ...ctx, messageID: MessageID.make("msg_schedule_drift"), callID: "drift-before-save" }
        expect(
          yield* confirm(input.storage, review, "schedule_task", { schedule: { kind: "once", at: 100 } }, "Run once?"),
        ).toBe(true)
        const shifted = yield* confirm(
          input.storage,
          review,
          "schedule_task",
          { schedule: { kind: "once", at: 101 } },
          "Run once?",
        ).pipe(Effect.exit)
        expect(Exit.isFailure(shifted)).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)

it.live(
  "actual schedule tool rejects invalid input without saving or starting a routine",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const input = {
          storage: yield* Storage.Service,
          database: yield* Database.Service,
          sessions: {
            create: () => Effect.die("must not start"),
            get: () => Effect.die("must not read session"),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          },
        }
        const info = yield* scheduleTaskTool(input)
        const tool = yield* info.init()
        const ctx = {
          sessionID: SessionID.make("ses_schedule"),
          messageID: MessageID.make("msg_schedule"),
          callID: "validation",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const incomplete = yield* Schema.decodeUnknownEffect(tool.parameters)({
          name: "Incomplete",
          objective: "Work",
          when: "only when I ask",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(incomplete)).toBe(true)
        const duplicate = yield* Schema.decodeUnknownEffect(tool.parameters)({
          ...assignment("Duplicate scope"),
          tools: ["read", "read"],
        }).pipe(Effect.exit)
        expect(Exit.isFailure(duplicate)).toBe(true)
        expect(yield* RayaTask.make(input).list()).toEqual([])
        for (const params of [
          { ...assignment("No schedule"), when: undefined },
          { ...assignment("Two schedules"), cron: "0 9 * * 1" },
        ]) {
          const rejected = yield* tool.execute(params, ctx)
          expect(rejected.title).toBe("Agent not created")
          expect(rejected.output).toContain("either a plain-English schedule")
          expect(yield* RayaTask.make(input).list()).toEqual([])
        }
        const result = yield* tool.execute({ ...assignment("Invalid"), when: "every 2 hours", runNow: true }, ctx)
        expect(result.title).toBe("Agent not created")
        expect(result.output).toContain("not supported")
        expect(yield* RayaTask.make(input).list()).toEqual([])
        for (const timezone of [undefined, "", "Not/AZone"]) {
          const rejected = yield* tool.execute({ ...assignment("No zone"), when: "every Monday at 9am", timezone }, ctx)
          expect(rejected.title).toBe("Agent not created")
          expect(rejected.output).toContain("timezone")
          expect(yield* RayaTask.make(input).list()).toEqual([])
        }
        const accepted = yield* tool.execute(
          { ...assignment("Monday"), when: "every Monday at 9am", timezone: "America/Toronto" },
          { ...ctx, callID: "monday" },
        )
        expect(accepted.title).toBe("Agent assigned")
        const saved = (yield* RayaTask.make(input).list())[0]
        expect(saved?.schedule).toEqual({ kind: "cron", expr: "0 9 * * 1", tz: "America/Toronto" })
        expect(saved?.access).toBe("brief")
        expect(saved?.tools).toEqual([])
        expect(accepted.output).toContain("Workspace access: read/notify")
        expect(accepted.output).toContain("Tool scope: questions only")
        expect(accepted.output).toContain("timezone America/Toronto")
        expect(accepted.output).toContain("Enabled")
        expect(accepted.output).toContain("backend must be running")
        expect(accepted.metadata).toMatchObject({ schedule: saved?.schedule, enabled: true })
        const explicit = yield* tool.execute(
          {
            ...assignment("UTC"),
            role: "coder",
            when: undefined,
            cron: "0 9 * * 1",
            timezone: "UTC",
            access: "full",
            tools: ["read", "browser_*"],
          },
          { ...ctx, callID: "utc" },
        )
        expect(explicit.metadata).toMatchObject({ schedule: { kind: "cron", expr: "0 9 * * 1", tz: "UTC" } })
        expect(explicit.metadata).toMatchObject({ access: "full" })
        expect(explicit.metadata).toMatchObject({ tools: ["read", "browser_*"] })
        expect(explicit.output).toContain("Workspace access: editing allowed")
        expect(explicit.output).toContain("Tool scope: read, browser_*")
        expect((yield* RayaTask.make(input).list()).find((agent) => agent.name === "UTC")?.access).toBe("full")
        expect((yield* RayaTask.make(input).list()).find((agent) => agent.name === "UTC")?.tools).toEqual([
          "read",
          "browser_*",
        ])
        const rejected = yield* tool.execute({ ...assignment("Delay"), when: "in 2 minutes", timezone: "UTC" }, ctx)
        expect(rejected.title).toBe("Agent not created")
        expect(yield* RayaTask.make(input).list()).toHaveLength(2)
        const uncertain = yield* tool.execute(
          { ...assignment("Interrupted", "Original work"), runNow: true },
          { ...ctx, callID: "interrupted" },
        )
        expect(uncertain.title).toBe("Routine saved; startup needs review")
        expect(uncertain.output).toContain("do not create a replacement")
        expect(uncertain.metadata).toMatchObject({ view: "routines", startup: "review" })
        expect(typeof uncertain.metadata.agentID).toBe("string")
        const roster = yield* RayaTask.make(input).list()
        expect(roster).toHaveLength(3)
        const evidence = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ agentID: Schema.String, runID: Schema.String }),
        )(uncertain.metadata).pipe(Effect.orDie)
        const interrupted = roster.find((agent) => agent.name === "Interrupted")
        expect(interrupted?.id).toBe(evidence.agentID)
        if (!interrupted) throw new Error("Missing saved startup identity")
        expect((yield* RayaTaskSnapshot.make(input).get(evidence.runID)).objective).toContain("Original work")
        expect((yield* RayaTaskRunner.make(input).fire(interrupted.id).pipe(Effect.flip))._tag).toBe(
          "RayaTask.GuardError",
        )
        const cancel = yield* scheduleTaskTool({
          ...input,
          sessions: { ...input.sessions, create: () => Effect.interrupt },
        })
        const cancelled = yield* (yield* cancel.init())
          .execute({ ...assignment("Cancelled"), runNow: true }, { ...ctx, callID: "cancel" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause)).toBe(true)
        expect((yield* RayaTask.make(input).list()).some((agent) => agent.name === "Cancelled")).toBe(true)
        const retry = yield* tool.execute({ ...assignment("Cancelled"), runNow: true }, { ...ctx, callID: "cancel" })
        expect(retry.title).toBe("Routine request needs review")
        expect((yield* RayaTask.make(input).list()).filter((agent) => agent.name === "Cancelled")).toHaveLength(1)
        const params = { ...assignment("Deduplicated"), when: "in 2 minutes" }
        const keyed = { ...ctx, callID: "create-once" }
        const first = yield* tool.execute(params, keyed)
        const count = (yield* RayaTask.make(input).list()).length
        const fresh = yield* (yield* scheduleTaskTool(input)).init()
        const replay = yield* fresh.execute({ ...params }, keyed)
        expect(replay).toEqual(JSON.parse(JSON.stringify(first)))
        expect((yield* RayaTask.make(input).list()).length).toBe(count)
        const changed = yield* fresh.execute({ ...params, objective: "Changed" }, keyed)
        expect(changed.title).toBe("Routine request needs review")
        expect((yield* RayaTask.make(input).list()).length).toBe(count)
        const raced = yield* Effect.all(
          [fresh.execute(params, { ...ctx, callID: "race" }), fresh.execute(params, { ...ctx, callID: "race" })],
          { concurrency: 2 },
        )
        expect(raced.some((result) => result.title === "Agent assigned")).toBe(true)
        expect((yield* RayaTask.make(input).list()).length).toBe(count + 1)
        yield* fresh.execute(params, { ...keyed, sessionID: SessionID.make("ses_other") })
        expect((yield* RayaTask.make(input).list()).length).toBe(count + 2)
        const broken = yield* (yield* scheduleTaskTool({
          ...input,
          storage: {
            ...input.storage,
            replace: (key, value) =>
              key[1] === "agent-requests" ? Effect.die("receipt response lost") : input.storage.replace(key, value),
          },
        })).init()
        const lost = yield* broken.execute(params, { ...ctx, callID: "lost" }).pipe(Effect.exit)
        expect(Exit.isFailure(lost)).toBe(true)
        expect((yield* RayaTask.make(input).list()).length).toBe(count + 3)
        const pending = yield* fresh.execute(params, { ...ctx, callID: "lost" })
        expect(pending.title).toBe("Routine request needs review")
        expect((yield* RayaTask.make(input).list()).length).toBe(count + 3)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Storage.layerFromDir(path.join(directory, "storage")),
            Database.layerFromPath(path.join(directory, "queue.sqlite")),
          ),
        ),
      ),
    ),
  30_000,
)
