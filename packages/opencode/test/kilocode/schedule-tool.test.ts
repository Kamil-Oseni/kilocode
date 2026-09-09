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
import { SessionID, MessageID } from "@/session/schema"
import { english, scheduleTaskTool } from "@/kilocode/tool/schedule-task"
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
  ),
)
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
          { name: "Editing", objective: "Work", access: "full" as const },
          { name: "Records", objective: "Work", capabilities: ["money"] },
        ]) {
          const result = yield* tool.execute({ ...params, runNow: true }, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(yield* RayaTask.make(input).list()).toEqual([])
          expect(yield* input.storage.list(["raya", "agent-claims"])).toEqual([])
        }
        expect(requests[0]?.patterns).toEqual(["access:full"])
        expect(requests[1]?.patterns).toEqual(["access:brief", "capability:money"])
        const params = {
          name: "Brief",
          objective: "Summarize the project",
          when: "manual",
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
        expect(accepted.output).toContain("Acceptance criteria: evidence")
        expect((yield* RayaTask.make(input).list())[0]?.output).toEqual(params.output)
        expect(requests[2]?.metadata).toMatchObject({
          name: "Brief",
          objective: params.objective,
          access: "brief",
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
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const result = yield* tool.execute(
          { name: "Invalid", objective: "Work", when: "every 2 hours", runNow: true },
          ctx,
        )
        expect(result.title).toBe("Agent not created")
        expect(result.output).toContain("not supported")
        expect(yield* RayaTask.make(input).list()).toEqual([])
        for (const timezone of [undefined, "", "Not/AZone"]) {
          const rejected = yield* tool.execute(
            { name: "No zone", objective: "Work", when: "every Monday at 9am", timezone },
            ctx,
          )
          expect(rejected.title).toBe("Agent not created")
          expect(rejected.output).toContain("timezone")
          expect(yield* RayaTask.make(input).list()).toEqual([])
        }
        const accepted = yield* tool.execute(
          { name: "Monday", objective: "Work", when: "every Monday at 9am", timezone: "America/Toronto" },
          ctx,
        )
        expect(accepted.title).toBe("Agent assigned")
        const saved = (yield* RayaTask.make(input).list())[0]
        expect(saved?.schedule).toEqual({ kind: "cron", expr: "0 9 * * 1", tz: "America/Toronto" })
        expect(saved?.access).toBe("brief")
        expect(accepted.output).toContain("Workspace access: read/notify")
        expect(accepted.output).toContain("timezone America/Toronto")
        expect(accepted.output).toContain("Enabled")
        expect(accepted.output).toContain("backend must be running")
        expect(accepted.metadata).toMatchObject({ schedule: saved?.schedule, enabled: true })
        const explicit = yield* tool.execute(
          { name: "UTC", role: "coder", objective: "Work", cron: "0 9 * * 1", timezone: "UTC", access: "full" },
          ctx,
        )
        expect(explicit.metadata).toMatchObject({ schedule: { kind: "cron", expr: "0 9 * * 1", tz: "UTC" } })
        expect(explicit.metadata).toMatchObject({ access: "full" })
        expect(explicit.output).toContain("Workspace access: editing allowed")
        expect((yield* RayaTask.make(input).list()).find((agent) => agent.name === "UTC")?.access).toBe("full")
        const rejected = yield* tool.execute(
          { name: "Delay", objective: "Work", when: "in 2 minutes", timezone: "UTC" },
          ctx,
        )
        expect(rejected.title).toBe("Agent not created")
        expect(yield* RayaTask.make(input).list()).toHaveLength(2)
        const uncertain = yield* tool.execute(
          { name: "Interrupted", objective: "Original work", when: "manual", runNow: true },
          ctx,
        )
        expect(uncertain.title).toBe("Routine saved; startup needs review")
        expect(uncertain.output).toContain("do not create a replacement")
        expect(uncertain.metadata).toMatchObject({ startup: "review" })
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
          .execute({ name: "Cancelled", objective: "Work", runNow: true }, { ...ctx, callID: "cancel" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause)).toBe(true)
        expect((yield* RayaTask.make(input).list()).some((agent) => agent.name === "Cancelled")).toBe(true)
        const retry = yield* tool.execute(
          { name: "Cancelled", objective: "Work", runNow: true },
          { ...ctx, callID: "cancel" },
        )
        expect(retry.title).toBe("Routine request needs review")
        expect((yield* RayaTask.make(input).list()).filter((agent) => agent.name === "Cancelled")).toHaveLength(1)
        const params = { name: "Deduplicated", objective: "Work", when: "in 2 minutes" }
        const keyed = { ...ctx, callID: "create-once" }
        const first = yield* tool.execute(params, keyed)
        const count = (yield* RayaTask.make(input).list()).length
        const fresh = yield* (yield* scheduleTaskTool(input)).init()
        const replay = yield* fresh.execute(
          { when: params.when, objective: params.objective, name: params.name },
          keyed,
        )
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
