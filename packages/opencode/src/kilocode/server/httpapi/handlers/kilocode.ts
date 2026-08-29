import { Effect } from "effect"
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
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session" // raya_change - Milestone A goal session validation
import { Snapshot } from "@/snapshot" // raya_change - durable goal workspace checkpoints
import { Storage } from "@/storage/storage" // raya_change - Milestone A durable goal storage
import { RayaGoal } from "@/kilocode/goal" // raya_change - Milestone A goal operations
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
    const snapshots = yield* Snapshot.Service // raya_change - goal rollback survives child sessions
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.Service // raya_change - Milestone A goal state and evidence
    const storage = yield* Storage.Service // raya_change - Milestone A durable goal storage
    const goals = RayaGoal.make({ storage, sessions }) // raya_change - Milestone A goal operations
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
          Effect.catchTag("RayaGoal.ExistsError", () => Effect.fail(new HttpApiError.BadRequest({}))),
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
      const prior = yield* goals.get(ctx.params.sessionID)
      if (!ctx.payload.status && ctx.payload.objective === undefined) {
        return yield* new HttpApiError.BadRequest({})
      }
      const revised =
        ctx.payload.objective === undefined
          ? prior
          : yield* goals.revise(ctx.params.sessionID, ctx.payload.objective).pipe(
              Effect.catchTag("RayaGoal.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
              Effect.catchTag("RayaGoal.AuditError", () => Effect.fail(new HttpApiError.BadRequest({}))),
            )
      const goal = ctx.payload.status
        ? yield* goals.control(ctx.params.sessionID, ctx.payload.status).pipe(
            Effect.catchTag("RayaGoal.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
            Effect.catchTag("RayaGoal.AuditError", () => Effect.fail(new HttpApiError.BadRequest({}))),
          )
        : revised
      if (!goal) return yield* new HttpApiError.NotFound({})
      if ((prior?.status === "paused" || prior?.status === "blocked") && goal.status === "active") {
        yield* RayaGoalContinuation.resume({
          sessionID: ctx.params.sessionID,
          storage,
          sessions,
        }).pipe(Effect.forkDetach)
      }
      return goal
    })

    const goalClear = Effect.fn("KilocodeHttpApi.goalClear")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* goals.clear(ctx.params.sessionID)
      return true
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

    const selfHealCreate = Effect.fn("KilocodeHttpApi.selfHealCreate")(function* (ctx: {
      payload: typeof SelfHealCreatePayload.Type
    }) {
      return yield* healing
        .create(ctx.payload)
        .pipe(Effect.catchTag("RayaSelfHeal.InputError", () => Effect.fail(new HttpApiError.BadRequest({}))))
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
      const item = yield* healing.update(ctx.params.itemID, ctx.payload)
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
        .handle("goalDiscard", goalDiscard)
        .handle("selfHealCreate", selfHealCreate)
        .handle("selfHealList", selfHealList)
        .handle("selfHealGet", selfHealGet)
        .handle("selfHealUpdate", selfHealUpdate)
    )
    // raya_change end
  }),
)
