import { Effect } from "effect"
import { UploadStage } from "@/kilocode/browser/upload-stage"
import { Database } from "@opencode-ai/core/database/database"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as KiloAgent from "@/kilocode/agent"
import { CommandFiles } from "@/kilocode/command-files"
import * as KiloSkill from "@/kilocode/skill-remove"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { HeapSnapshot } from "@/kilocode/cli/heap-snapshot"
import type { RequestID as AgentManagerRequestID } from "@/kilocode/agent-manager/protocol"
import { AgentManager } from "@/kilocode/agent-manager/service"
import type { RequestID as NotebookRequestID } from "@/kilocode/notebook/protocol"
import { Notebook } from "@/kilocode/notebook/service"
import { ModelUsage } from "@/kilocode/session/model-usage"
import { ProjectUsage } from "@/kilocode/session/project-usage" // raya_change - historical project usage
import { ProviderUsage } from "@opencode-ai/core/kilocode/provider-usage"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { InstanceStore } from "@/project/instance-store"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { InvalidRequestError } from "@/server/routes/instance/httpapi/errors"
import { Skill } from "@/skill"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session" // raya_change - Milestone A goal session validation
import { Snapshot } from "@/snapshot" // raya_change - durable goal workspace checkpoints
import { Storage } from "@/storage/storage" // raya_change - Milestone A durable goal storage
import { RayaGoal } from "@/kilocode/goal" // raya_change - Milestone A goal operations
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { templates as agentTemplates } from "@/kilocode/task/templates"
import { RayaCheckpoint } from "@/kilocode/checkpoint" // raya_change - named workspace checkpoints
import { RayaDesignSystem } from "@/kilocode/design-system" // raya_change - owner design-system lock
import { RayaGoalContinuation } from "@/kilocode/goal/continuation" // raya_change - Milestone A resume behavior
import { RayaSelfHeal } from "@/kilocode/self-heal" // raya_change - global feedback backlog
import type { RequestID as BrowserRequestID } from "@/kilocode/browser/protocol" // raya_change - Milestone F
import { Browser } from "@/kilocode/browser/service" // raya_change - Milestone F browser bridge
import type { RequestID as CanvasRequestID } from "@/kilocode/canvas/protocol" // raya_change - Milestone E
import { Canvas } from "@/kilocode/canvas/service" // raya_change - Milestone E canvas bridge
import {
  AgentManagerRejectPayload,
  AgentManagerReplyPayload,
  NotebookRejectPayload,
  NotebookReplyPayload,
  RemoveAgentPayload,
  RemoveCommandPayload,
  RemoveSkillPayload,
  BackgroundJobInfo,
  BackgroundJobsQuery,
  ProjectUsageQuery, // raya_change - historical project usage
  GoalCreatePayload, // raya_change - Milestone A goal API
  GoalUpdatePayload, // raya_change - Milestone A goal API
  CheckpointCreatePayload, // raya_change - named workspace checkpoints
  TaskCreatePayload,
  TaskUpdatePayload,
  TaskEventPayload,
  DesignSystemSetPayload, // raya_change - owner design-system lock
  SelfHealCreatePayload, // raya_change
  SelfHealUpdatePayload, // raya_change
  BrowserReplyPayload, // raya_change - Milestone F browser API
  BrowserRejectPayload, // raya_change - Milestone F browser API
  CanvasReplyPayload, // raya_change - Milestone E canvas API
  CanvasRejectPayload, // raya_change - Milestone E canvas API
} from "../groups/kilocode"

export const kilocodeHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilocode", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const commands = yield* Command.Service
    const skills = yield* Skill.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const manager = yield* AgentManager.Service
    const notebook = yield* Notebook.Service
    const browser = yield* Browser.Service // raya_change - Milestone F browser bridge
    const canvas = yield* Canvas.Service // raya_change - Milestone E canvas bridge
    const background = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const workers = yield* TaskWorker.Service
    const snapshots = yield* Snapshot.Service // raya_change - goal rollback survives child sessions
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.Service // raya_change - Milestone A goal state and evidence
    const storage = yield* Storage.Service // raya_change - Milestone A durable goal storage
    const goals = RayaGoal.make({ storage, sessions }) // raya_change - Milestone A goal operations
    const database = yield* Database.Service
    const runner = RayaTaskRunner.make({
      storage,
      sessions,
      database,
      halt: (sessionID) => runState.cancel(sessionID),
    })
    const inbox = RayaTaskInbox.make(database)
    const errands = RayaTaskDelegation.make(database)
    const checkpoints = RayaCheckpoint.make({ storage, snapshots }) // raya_change - named workspace checkpoints
    const designSystem = RayaDesignSystem.make({ storage }) // raya_change - owner design-system lock
    const healing = RayaSelfHeal.make(storage) // raya_change - one backlog shared across sessions and projects

    // Location-scoped services, keyed by the request's directory and workspace.
    const located = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({
              directory: AbsolutePath.make((yield* InstanceState.context).directory),
              workspaceID: yield* WorkspaceRef,
            }),
          ),
        ),
      )
    })

    const heapSnapshot = Effect.fn("KilocodeHttpApi.heapSnapshot")(function* () {
      return yield* Effect.sync(() => HeapSnapshot.write())
    })

    const commandFiles = Effect.fn("KilocodeHttpApi.commandFiles")(function* () {
      const instance = yield* InstanceState.context
      const dirs = yield* config.directories()
      const items = yield* commands.list()
      return yield* Effect.tryPromise({
        try: () => CommandFiles.discover({ commands: items, directories: dirs, directory: instance.directory }),
        catch: (err) => err,
      }).pipe(Effect.catch((err) => Effect.die(err)))
    })

    const removeCommand = Effect.fn("KilocodeHttpApi.removeCommand")(function* (ctx: {
      payload: typeof RemoveCommandPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const dirs = yield* config.directories()
      const items = yield* commands.list()
      const entries = yield* Effect.tryPromise({
        try: () => CommandFiles.discover({ commands: items, directories: dirs, directory: instance.directory }),
        catch: (err) => err,
      }).pipe(Effect.catch((err) => Effect.die(err)))
      yield* Effect.tryPromise({
        try: () => CommandFiles.remove(ctx.payload.location, entries),
        catch: () => new HttpApiError.BadRequest({}),
      })
      yield* store.dispose(instance)
      return true
    })

    const removeSkill = Effect.fn("KilocodeHttpApi.removeSkill")(function* (ctx: {
      payload: typeof RemoveSkillPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const entries = yield* skills.all()
      yield* Effect.tryPromise({
        try: () => KiloSkill.remove(ctx.payload.location, entries),
        catch: () => new HttpApiError.BadRequest({}),
      })
      yield* store.dispose(instance)
      return true
    })

    const removeAgent = Effect.fn("KilocodeHttpApi.removeAgent")(function* (ctx: {
      payload: typeof RemoveAgentPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const agent = yield* agents.get(ctx.payload.name)
      const dirs = yield* config.directories()
      yield* Effect.tryPromise({
        try: () =>
          KiloAgent.remove({
            name: ctx.payload.name,
            agent,
            dirs,
            directory: instance.directory,
            worktree: instance.worktree,
            scope: ctx.payload.scope,
          }),
        catch: (err) => err,
      }).pipe(
        Effect.catch((err) => {
          if (KiloAgent.RemoveError.isInstance(err))
            return Effect.fail(new InvalidRequestError({ message: err.data.message }))
          return Effect.die(err)
        }),
      )
      yield* store.dispose(instance)
      return true
    })

    const providerUsage = Effect.fn("KilocodeHttpApi.providerUsage")(function* () {
      return yield* located(ProviderUsage.Service.use((usage) => usage.get())).pipe(
        Effect.mapError(() => new HttpApiError.ServiceUnavailable({})),
      )
    })

    const providerUsageRefresh = Effect.fn("KilocodeHttpApi.providerUsageRefresh")(function* () {
      return yield* located(ProviderUsage.Service.use((usage) => usage.refresh())).pipe(
        Effect.mapError(() => new HttpApiError.ServiceUnavailable({})),
      )
    })

    const projectUsage = Effect.fn("KilocodeHttpApi.projectUsage")(function* (ctx: {
      query: typeof ProjectUsageQuery.Type
    }) {
      const project = (yield* InstanceState.context).project.id
      return yield* located(ProjectUsage.get(project, ctx.query.range ?? "all"))
    }) // raya_change - aggregate existing settled step records without a second write path

    const notebookList = Effect.fn("KilocodeHttpApi.notebookList")(function* () {
      return yield* notebook.list()
    })

    const notebookReply = Effect.fn("KilocodeHttpApi.notebookReply")(function* (ctx: {
      params: { requestID: NotebookRequestID }
      payload: typeof NotebookReplyPayload.Type
    }) {
      yield* notebook.reply({ requestID: ctx.params.requestID, result: ctx.payload.result }).pipe(
        Effect.catchTag("Notebook.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("Notebook.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return true
    })

    const notebookReject = Effect.fn("KilocodeHttpApi.notebookReject")(function* (ctx: {
      params: { requestID: NotebookRequestID }
      payload: typeof NotebookRejectPayload.Type
    }) {
      yield* notebook
        .reject({ requestID: ctx.params.requestID, error: ctx.payload.error })
        .pipe(Effect.catchTag("Notebook.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      return true
    })

    // raya_change start - Milestone F browser host API
    const browserUploadChunk = Effect.fn("KilocodeHttpApi.browserUploadChunk")(function* (ctx: {
      params: { uploadID: string; fileID: string }
      payload: { sessionID: string; offset: number }
    }) {
      const instance = yield* InstanceState.context
      return yield* Effect.tryPromise({
        try: () =>
          new UploadStage().chunk(
            { uploadID: ctx.params.uploadID, sessionID: ctx.payload.sessionID, directory: instance.directory },
            ctx.params.fileID,
            ctx.payload.offset,
          ),
        catch: () => new HttpApiError.BadRequest({}),
      })
    })
    const browserUploadRelease = Effect.fn("KilocodeHttpApi.browserUploadRelease")(function* (ctx: {
      params: { uploadID: string; fileID: string }
      payload: { sessionID: string }
    }) {
      const instance = yield* InstanceState.context
      yield* Effect.tryPromise({
        try: () =>
          new UploadStage().release(
            { uploadID: ctx.params.uploadID, sessionID: ctx.payload.sessionID, directory: instance.directory },
            ctx.params.fileID,
          ),
        catch: () => new HttpApiError.BadRequest({}),
      })
      return true
    })
    const browserList = Effect.fn("KilocodeHttpApi.browserList")(function* () {
      return yield* browser.list()
    })

    const browserReply = Effect.fn("KilocodeHttpApi.browserReply")(function* (ctx: {
      params: { requestID: BrowserRequestID }
      payload: typeof BrowserReplyPayload.Type
    }) {
      yield* browser.reply({ requestID: ctx.params.requestID, result: ctx.payload.result }).pipe(
        Effect.catchTag("Browser.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("Browser.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return true
    })

    const browserReject = Effect.fn("KilocodeHttpApi.browserReject")(function* (ctx: {
      params: { requestID: BrowserRequestID }
      payload: typeof BrowserRejectPayload.Type
    }) {
      yield* browser
        .reject({ requestID: ctx.params.requestID, error: ctx.payload.error })
        .pipe(Effect.catchTag("Browser.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      return true
    })
    // raya_change end

    // raya_change start - Milestone E canvas host API
    const canvasList = Effect.fn("KilocodeHttpApi.canvasList")(function* () {
      return yield* canvas.list()
    })

    const canvasReply = Effect.fn("KilocodeHttpApi.canvasReply")(function* (ctx: {
      params: { requestID: CanvasRequestID }
      payload: typeof CanvasReplyPayload.Type
    }) {
      yield* canvas.reply({ requestID: ctx.params.requestID, result: ctx.payload.result }).pipe(
        Effect.catchTag("Canvas.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("Canvas.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return true
    })

    const canvasReject = Effect.fn("KilocodeHttpApi.canvasReject")(function* (ctx: {
      params: { requestID: CanvasRequestID }
      payload: typeof CanvasRejectPayload.Type
    }) {
      yield* canvas
        .reject({ requestID: ctx.params.requestID, error: ctx.payload.error })
        .pipe(Effect.catchTag("Canvas.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      return true
    })
    // raya_change end

    const agentManagerList = Effect.fn("KilocodeHttpApi.agentManagerList")(function* () {
      return yield* manager.list()
    })

    const agentManagerReply = Effect.fn("KilocodeHttpApi.agentManagerReply")(function* (ctx: {
      params: { requestID: AgentManagerRequestID }
      payload: typeof AgentManagerReplyPayload.Type
    }) {
      yield* manager.reply({ requestID: ctx.params.requestID, result: ctx.payload.result }).pipe(
        Effect.catchTag("AgentManager.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("AgentManager.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return true
    })

    const agentManagerReject = Effect.fn("KilocodeHttpApi.agentManagerReject")(function* (ctx: {
      params: { requestID: AgentManagerRequestID }
      payload: typeof AgentManagerRejectPayload.Type
    }) {
      yield* manager
        .reject({ requestID: ctx.params.requestID, error: ctx.payload.error })
        .pipe(Effect.catchTag("AgentManager.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      return true
    })

    const sessionModelUsage = Effect.fn("KilocodeHttpApi.sessionModelUsage")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const usage = yield* ModelUsage.get(ctx.params.sessionID)
      if (!usage) return yield* new HttpApiError.NotFound({})
      return usage
    })

    const backgroundJobs = Effect.fn("KilocodeHttpApi.backgroundJobs")(function* (ctx: {
      query: typeof BackgroundJobsQuery.Type
    }) {
      return (yield* background.list())
        .filter((job) => job.metadata?.parentSessionId === ctx.query.sessionID)
        .map((job) => ({
          id: job.id,
          type: job.type,
          title: job.title,
          status: job.status,
          started_at: job.started_at,
          completed_at: job.completed_at,
          error: job.error,
          metadata: job.metadata,
        })) satisfies (typeof BackgroundJobInfo.Type)[]
    })

    const backgroundJobCancel = Effect.fn("KilocodeHttpApi.backgroundJobCancel")(function* (ctx: {
      params: { jobID: string }
    }) {
      const job = yield* background.get(ctx.params.jobID)
      if (!job) return yield* new HttpApiError.NotFound({})
      const sessionID = SessionID.make(typeof job.metadata?.sessionId === "string" ? job.metadata.sessionId : job.id)
      yield* runState.cancel(sessionID)
      return true
    })

    // raya_change start - Milestone A session-scoped goal API
    const goalCreate = Effect.fn("KilocodeHttpApi.goalCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof GoalCreatePayload.Type
    }) {
      yield* sessions
        .get(ctx.params.sessionID)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      const checkpoint = yield* snapshots.track({
        sessionID: ctx.params.sessionID,
      })
      return yield* goals
        .create(ctx.params.sessionID, ctx.payload.objective, ctx.payload.messageID, checkpoint, ctx.payload.selfHealID)
        .pipe(
          Effect.catchTag("RayaGoal.ExistsError", () =>
            // Steer the live goal. The client still sends the user prompt, so do
            // not also resume a continuation here — that double-starts a turn.
            goals.revise(ctx.params.sessionID, ctx.payload.objective),
          ),
          Effect.catchTag("RayaGoal.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("RayaGoal.AuditError", () => Effect.fail(new HttpApiError.BadRequest({}))),
        )
    })

    const goalGet = Effect.fn("KilocodeHttpApi.goalGet")(function* (ctx: { params: { sessionID: SessionID } }) {
      const goal = yield* goals.get(ctx.params.sessionID)
      if (!goal) return yield* new HttpApiError.NotFound({})
      return goal
    })

    const goalUpdate = Effect.fn("KilocodeHttpApi.goalUpdate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof GoalUpdatePayload.Type
    }) {
      const result = yield* goals.edit(ctx.params.sessionID, ctx.payload).pipe(
        Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaGoal.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaGoal.AuditError", (err) =>
          Effect.fail(err.conflict ? new HttpApiError.Conflict({}) : new HttpApiError.BadRequest({})),
        ),
      )
      const prior = result.prior
      const goal = result.state
      if (
        goal.status === "active" &&
        (prior.status === "paused" ||
          prior.status === "blocked" ||
          ctx.payload.objective !== undefined ||
          ctx.payload.criteria !== undefined)
      ) {
        // Steer persists immediately. Resume only when idle so we do not collide
        // with the current model turn (that collision aborted task JSON).
        yield* runState.assertNotBusy(ctx.params.sessionID).pipe(
          Effect.andThen(
            RayaGoalContinuation.resume({
              database,
              sessionID: ctx.params.sessionID,
              storage,
              sessions,
            }).pipe(Effect.ignore, Effect.forkDetach),
          ),
          Effect.catch(() => Effect.void),
        )
      }
      return goal
    })

    const goalClear = Effect.fn("KilocodeHttpApi.goalClear")(function* (ctx: {
      params: { sessionID: SessionID }
      query: { expectedIntent?: string }
    }) {
      yield* (
        ctx.query.expectedIntent === undefined
          ? goals.clear(ctx.params.sessionID)
          : goals
              .stop(ctx.params.sessionID, ctx.query.expectedIntent, runState, background, workers)
              .pipe(Effect.asVoid)
      ).pipe(Effect.catchTag("RayaGoal.AuditError", () => Effect.fail(new HttpApiError.Conflict({}))))
      return true
    })

    const goalStop = (ctx: { params: { sessionID: SessionID }; payload: { expectedIntent: string } }) =>
      goals
        .stop(ctx.params.sessionID, ctx.payload.expectedIntent, runState, background, workers)
        .pipe(Effect.catchTag("RayaGoal.AuditError", () => Effect.fail(new HttpApiError.Conflict({}))))

    const goalStopResult = Effect.fn("KilocodeHttpApi.goalStopResult")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const receipt = yield* goals.stopResult(ctx.params.sessionID)
      if (!receipt) return yield* new HttpApiError.NotFound({})
      return receipt
    })

    const goalDiscard = Effect.fn("KilocodeHttpApi.goalDiscard")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* runState
        .assertNotBusy(ctx.params.sessionID)
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      const goal = yield* goals.get(ctx.params.sessionID)
      if (!goal) return yield* new HttpApiError.NotFound({})
      if (!goal.startSnapshot) return yield* new HttpApiError.BadRequest({})
      const patch = yield* snapshots.patch(goal.startSnapshot)
      yield* snapshots.revert([patch])
      yield* goals.clear(ctx.params.sessionID)
      return true
    })

    // raya_change start - named workspace checkpoints
    const checkpointList = Effect.fn("KilocodeHttpApi.checkpointList")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      return yield* checkpoints.list(ctx.params.sessionID)
    })

    const checkpointCreate = Effect.fn("KilocodeHttpApi.checkpointCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CheckpointCreatePayload.Type
    }) {
      const info = yield* checkpoints.create(ctx.params.sessionID, ctx.payload.name)
      if (!info) return yield* new HttpApiError.BadRequest({})
      return info
    })

    const checkpointJump = Effect.fn("KilocodeHttpApi.checkpointJump")(function* (ctx: {
      params: { sessionID: SessionID; checkpointID: string }
    }) {
      const ok = yield* checkpoints.jump(ctx.params.sessionID, ctx.params.checkpointID)
      if (!ok) return yield* new HttpApiError.NotFound({})
      return true
    })

    const checkpointRemove = Effect.fn("KilocodeHttpApi.checkpointRemove")(function* (ctx: {
      params: { sessionID: SessionID; checkpointID: string }
    }) {
      return yield* checkpoints.remove(ctx.params.sessionID, ctx.params.checkpointID)
    })
    // raya_change end

    const agentForecast = Effect.fn("KilocodeHttpApi.agentForecast")(function* (ctx: { payload: RayaTask.Proposal }) {
      return yield* RayaTask.forecast(ctx.payload).pipe(
        Effect.catchTag("RayaTask.GuardError", (err) =>
          Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
        ),
      )
    })
    const agentList = Effect.fn("KilocodeHttpApi.agentList")(function* () {
      return yield* runner.preview(Date.now())
    })
    const agentCreate = Effect.fn("KilocodeHttpApi.agentCreate")(function* (ctx: {
      payload: typeof TaskCreatePayload.Type
    }) {
      return yield* runner.tasks
        .create(ctx.payload)
        .pipe(
          Effect.catchTag("RayaTask.GuardError", (err) =>
            Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
          ),
        )
    })
    const agentUpdate = Effect.fn("KilocodeHttpApi.agentUpdate")(function* (ctx: {
      params: { agentID: string }
      payload: typeof TaskUpdatePayload.Type
    }) {
      return yield* runner.tasks.update(ctx.params.agentID, ctx.payload).pipe(
        Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaTask.GuardError", (err) =>
          Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
        ),
      )
    })
    const agentRun = Effect.fn("KilocodeHttpApi.agentRun")(function* (ctx: { params: { agentID: string } }) {
      return yield* runner.fire(ctx.params.agentID).pipe(
        Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaTask.GuardError", (err) =>
          Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
        ),
      )
    })
    const agentRuns = Effect.fn("KilocodeHttpApi.agentRuns")(function* (ctx: { params: { agentID: string } }) {
      return yield* runner.tasks.runsFor(ctx.params.agentID)
    })
    const agentSnapshot = Effect.fn("KilocodeHttpApi.agentSnapshot")(function* (ctx: {
      params: { agentID: string; runID: string }
    }) {
      const snapshot = yield* RayaTaskSnapshot.make({ storage })
        .find(ctx.params.runID)
        .pipe(
          Effect.catchTag("RayaTaskSnapshot.Invalid", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
        )
      if (!snapshot || snapshot.agentID !== ctx.params.agentID) return yield* new HttpApiError.NotFound({})
      return snapshot
    })
    const agentRemove = Effect.fn("KilocodeHttpApi.agentRemove")(function* (ctx: { params: { agentID: string } }) {
      return yield* runner.tasks.remove(ctx.params.agentID).pipe(
        Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaTask.GuardError", (err) =>
          Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
        ),
      )
    })
    const agentTemplateList = Effect.fn("KilocodeHttpApi.agentTemplates")(function* () {
      return agentTemplates
    })
    const agentEvent = Effect.fn("KilocodeHttpApi.agentEvent")(function* (ctx: {
      payload: typeof TaskEventPayload.Type
    }) {
      return yield* runner.announce(ctx.payload.source, ctx.payload.filter)
    })
    const owned = (id: string) =>
      runner.tasks.get(id).pipe(Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
    const agentInbox = Effect.fn("KilocodeHttpApi.agentInbox")(function* () {
      const agents = yield* runner.preview(Date.now())
      const runs = new Map<string, RayaTask.Run | undefined>()
      for (const agent of agents) {
        const history = yield* runner.tasks.runsFor(agent.id)
        runs.set(agent.id, history.at(-1))
      }
      return yield* inbox.summaries(agents, runs)
    })
    const agentInboxPage = Effect.fn("KilocodeHttpApi.agentInboxPage")(function* (ctx: {
      params: { agentID: string }
      query: { cursor?: string; limit?: number }
    }) {
      yield* owned(ctx.params.agentID)
      return yield* inbox.page(ctx.params.agentID, ctx.query.cursor, ctx.query.limit ?? 50).pipe(
        Effect.catchTag("RayaTaskInbox.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
    })
    const agentInboxSend = Effect.fn("KilocodeHttpApi.agentInboxSend")(function* (ctx: {
      params: { agentID: string }
      payload: { source: string; body: string }
    }) {
      yield* owned(ctx.params.agentID)
      const admitted = yield* inbox
        .admit({ agentID: ctx.params.agentID, source: ctx.payload.source, kind: "user", body: ctx.payload.body })
        .pipe(
          Effect.catchTag("RayaTaskInbox.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
          Effect.catchTag("RayaTaskInbox.Conflict", () => Effect.fail(new HttpApiError.Conflict({}))),
        )
      if (admitted.record.sessionID && !admitted.created) return admitted.record
      const run = yield* runner.ask(ctx.params.agentID, admitted.record.body).pipe(
        Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaTask.GuardError", (err) =>
          Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
        ),
      )
      return yield* inbox.attach(ctx.params.agentID, admitted.record.source, run.sessionID).pipe(
        Effect.catchTag("RayaTaskInbox.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
        Effect.catchTag("RayaTaskInbox.Conflict", () => Effect.fail(new HttpApiError.Conflict({}))),
      )
    })
    const agentInboxRead = Effect.fn("KilocodeHttpApi.agentInboxRead")(function* (ctx: {
      params: { agentID: string }
      payload: { at: number }
    }) {
      yield* owned(ctx.params.agentID)
      const at = yield* inbox.read(ctx.params.agentID, ctx.payload.at).pipe(
        Effect.catchTag("RayaTaskInbox.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
      return { at }
    })
    const agentInboxDraft = Effect.fn("KilocodeHttpApi.agentInboxDraft")(function* (ctx: {
      params: { agentID: string }
      payload: { draft: string | null }
    }) {
      yield* owned(ctx.params.agentID)
      const draft = yield* inbox.draft(ctx.params.agentID, ctx.payload.draft).pipe(
        Effect.catchTag("RayaTaskInbox.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
      return { draft }
    })
    const agentDelegate = Effect.fn("KilocodeHttpApi.agentDelegate")(function* (ctx: {
      params: { agentID: string }
      payload: { source: string; senderID: string; recipientID: string; objective: string; parentRunID?: string }
    }) {
      yield* owned(ctx.params.agentID)
      yield* owned(ctx.payload.recipientID)
      return yield* runner
        .delegate({ ...ctx.payload, senderID: ctx.params.agentID })
        .pipe(
          Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("RayaTask.GuardError", (err) =>
            Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
          ),
          Effect.catchTag("RayaTaskDelegation.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
          Effect.catchTag("RayaTaskDelegation.Conflict", () => Effect.fail(new HttpApiError.Conflict({}))),
        )
    })
    const agentDelegateGet = Effect.fn("KilocodeHttpApi.agentDelegateGet")(function* (ctx: {
      params: { agentID: string; id: string }
    }) {
      yield* owned(ctx.params.agentID)
      const row = yield* errands.get(ctx.params.id).pipe(
        Effect.catchTag("RayaTaskDelegation.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
      if (row.senderID !== ctx.params.agentID && row.recipientID !== ctx.params.agentID)
        return yield* new HttpApiError.NotFound({})
      return row
    })
    const agentDelegateChain = Effect.fn("KilocodeHttpApi.agentDelegateChain")(function* (ctx: {
      params: { agentID: string; id: string }
    }) {
      yield* owned(ctx.params.agentID)
      const found = yield* errands.tree(ctx.params.id).pipe(
        Effect.catchTag("RayaTaskDelegation.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
      if (found.record.senderID !== ctx.params.agentID && found.record.recipientID !== ctx.params.agentID)
        return yield* new HttpApiError.NotFound({})
      return found
    })
    const agentDelegateCancel = Effect.fn("KilocodeHttpApi.agentDelegateCancel")(function* (ctx: {
      params: { agentID: string; id: string }
    }) {
      yield* owned(ctx.params.agentID)
      const row = yield* errands.get(ctx.params.id).pipe(
        Effect.catchTag("RayaTaskDelegation.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
      if (row.senderID !== ctx.params.agentID && row.recipientID !== ctx.params.agentID)
        return yield* new HttpApiError.NotFound({})
      return yield* runner.stop(ctx.params.id).pipe(
        Effect.catchTag("RayaTask.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("RayaTask.GuardError", (err) =>
          Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
        ),
        Effect.catchTag("RayaTaskDelegation.Invalid", (err) => Effect.fail(new InvalidRequestError({ message: err.message }))),
      )
    })

    // raya_change start - owner design-system lock
    const designSystemGet = Effect.fn("KilocodeHttpApi.designSystemGet")(function* () {
      return yield* designSystem.get()
    })

    const designSystemSet = Effect.fn("KilocodeHttpApi.designSystemSet")(function* (ctx: {
      payload: typeof DesignSystemSetPayload.Type
    }) {
      return yield* designSystem.set(ctx.payload)
    })
    // raya_change end

    const selfHealCreate = Effect.fn("KilocodeHttpApi.selfHealCreate")(function* (ctx: {
      payload: typeof SelfHealCreatePayload.Type
    }) {
      return yield* healing
        .create(ctx.payload)
        .pipe(Effect.catchTag("RayaSelfHeal.InputError", () => Effect.fail(new HttpApiError.BadRequest({}))))
    })

    const selfHealOutcome = Effect.fn(function* (ctx: { params: { itemID: string } }) {
      const outcome = yield* healing.outcome(ctx.params.itemID)
      if (!outcome) return yield* new HttpApiError.NotFound({})
      return outcome
    })
    const selfHealAdmit = Effect.fn(function* (ctx: {
      params: { itemID: string }
      payload: typeof RayaSelfHeal.RepairAdmission.Type
    }) {
      const result = yield* healing.admit(ctx.params.itemID, ctx.payload)
      if (!result) return yield* new HttpApiError.NotFound({})
      return result
    })
    const selfHealPrepare = Effect.fn(function* (ctx: {
      params: { itemID: string }
      payload: typeof RayaSelfHeal.RepairPrepare.Type
    }) {
      return yield* healing
        .prepare(ctx.params.itemID, ctx.payload)
        .pipe(Effect.catchTag("SelfHeal.RepairConflict", () => Effect.fail(new HttpApiError.Conflict({}))))
    })
    const selfHealAdvance = Effect.fn(function* (ctx: {
      params: { itemID: string }
      payload: typeof RayaSelfHeal.RepairAdvance.Type
    }) {
      return yield* healing
        .advance(ctx.params.itemID, ctx.payload)
        .pipe(Effect.catchTag("SelfHeal.RepairConflict", () => Effect.fail(new HttpApiError.Conflict({}))))
    })
    const selfHealList = Effect.fn("KilocodeHttpApi.selfHealList")(function* () {
      return yield* healing.list()
    })

    const selfHealGet = Effect.fn("KilocodeHttpApi.selfHealGet")(function* (ctx: { params: { itemID: string } }) {
      const item = yield* healing.get(ctx.params.itemID)
      if (!item) return yield* new HttpApiError.NotFound({})
      return item
    })

    const selfHealUpdate = Effect.fn("KilocodeHttpApi.selfHealUpdate")(function* (ctx: {
      params: { itemID: string }
      payload: typeof SelfHealUpdatePayload.Type
    }) {
      const item = yield* healing
        .update(ctx.params.itemID, ctx.payload)
        .pipe(Effect.catchTag("RayaSelfHeal.InputError", () => Effect.fail(new HttpApiError.Conflict({}))))
      if (!item) return yield* new HttpApiError.NotFound({})
      return item
    })
    // raya_change end

    return (
      handlers
        .handle("heapSnapshot", heapSnapshot)
        .handle("commandFiles", commandFiles)
        .handle("removeCommand", removeCommand)
        .handle("removeSkill", removeSkill)
        .handle("removeAgent", removeAgent)
        .handle("providerUsage", providerUsage)
        .handle("providerUsageRefresh", providerUsageRefresh)
        .handle("projectUsage", projectUsage)
        .handle("notebookList", notebookList)
        .handle("notebookReply", notebookReply)
        .handle("notebookReject", notebookReject)
        // raya_change start - Milestone F browser host API
        .handle("browserList", browserList)
        .handle("browserUploadChunk", browserUploadChunk)
        .handle("browserUploadRelease", browserUploadRelease)
        .handle("browserReply", browserReply)
        .handle("browserReject", browserReject)
        // raya_change end
        // raya_change start - Milestone E canvas host API
        .handle("canvasList", canvasList)
        .handle("canvasReply", canvasReply)
        .handle("canvasReject", canvasReject)
        // raya_change end
        .handle("agentManagerList", agentManagerList)
        .handle("agentManagerReply", agentManagerReply)
        .handle("agentManagerReject", agentManagerReject)
        .handle("sessionModelUsage", sessionModelUsage)
        .handle("backgroundJobs", backgroundJobs)
        .handle("backgroundJobCancel", backgroundJobCancel)
        // raya_change start - Milestone A session-scoped goal API
        .handle("goalCreate", goalCreate)
        .handle("goalGet", goalGet)
        .handle("goalUpdate", goalUpdate)
        .handle("goalClear", goalClear)
        .handle("goalStop", goalStop)
        .handle("goalStopResult", goalStopResult)
        .handle("goalDiscard", goalDiscard)
        .handle("checkpointList", checkpointList)
        .handle("checkpointCreate", checkpointCreate)
        .handle("checkpointJump", checkpointJump)
        .handle("checkpointRemove", checkpointRemove)
        .handle("agentForecast", agentForecast)
        .handle("agentList", agentList)
        .handle("agentArchive", (ctx) =>
          runner.tasks
            .page(ctx.query)
            .pipe(
              Effect.catchTag("RayaTask.GuardError", (err) =>
                Effect.fail(new InvalidRequestError({ message: err.message, kind: err.kind, field: err.field })),
              ),
            ),
        )
        .handle("agentCreate", agentCreate)
        .handle("agentUpdate", agentUpdate)
        .handle("agentRemove", agentRemove)
        .handle("agentRun", agentRun)
        .handle("agentRuns", agentRuns)
        .handle("agentSnapshot", agentSnapshot)
        .handle("agentTemplates", agentTemplateList)
        .handle("agentEvent", agentEvent)
        .handle("agentInbox", agentInbox)
        .handle("agentInboxPage", agentInboxPage)
        .handle("agentInboxSend", agentInboxSend)
        .handle("agentInboxRead", agentInboxRead)
        .handle("agentInboxDraft", agentInboxDraft)
        .handle("agentDelegate", agentDelegate)
        .handle("agentDelegateGet", agentDelegateGet)
        .handle("agentDelegateChain", agentDelegateChain)
        .handle("agentDelegateCancel", agentDelegateCancel)
        .handle("designSystemGet", designSystemGet)
        .handle("designSystemSet", designSystemSet)
        .handle("selfHealCreate", selfHealCreate)
        .handle("selfHealAdmit", selfHealAdmit)
        .handle("selfHealOutcome", selfHealOutcome)
        .handle("selfHealAdvance", selfHealAdvance)
        .handle("selfHealPrepare", selfHealPrepare)
        .handle("selfHealList", selfHealList)
        .handle("selfHealGet", selfHealGet)
        .handle("selfHealUpdate", selfHealUpdate)
    )
    // raya_change end
  }),
)
