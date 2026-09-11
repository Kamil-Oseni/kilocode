import { Schema } from "effect"
import { UploadChunk } from "@/kilocode/browser/upload-schema"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { InvalidRequestError } from "@/server/routes/instance/httpapi/errors"
import { ProviderUsage } from "@opencode-ai/schema/kilocode/provider-usage"
import { AnacondaDesktopApi } from "./anaconda-desktop"
import {
  Failure as AgentManagerFailure,
  Request as AgentManagerRequest,
  RequestID as AgentManagerRequestID,
  Result as AgentManagerResult,
} from "@/kilocode/agent-manager/protocol"
import {
  Failure as NotebookFailure,
  Request as NotebookRequest,
  RequestID as NotebookRequestID,
  Result as NotebookResult,
} from "@/kilocode/notebook/protocol"
import { ModelUsage } from "@/kilocode/session/model-usage"
import { ProjectUsage } from "@/kilocode/session/project-usage" // raya_change - historical project usage
import { SessionID } from "@/session/schema"
import { CommandFiles } from "@/kilocode/command-files"
import { RayaGoal } from "@/kilocode/goal" // raya_change - Milestone A goal API contracts
import { RayaTask } from "@/kilocode/task"
import {
  Draft as InboxDraft,
  Item as InboxItem,
  Page as InboxPage,
  Read as InboxRead,
  Record as InboxRecord,
  Send as InboxSend,
} from "@/kilocode/task/inbox"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { Template as AgentTemplate } from "@/kilocode/task/templates"
import { RayaCheckpoint } from "@/kilocode/checkpoint" // raya_change - named workspace checkpoints
import { RayaDesignSystem } from "@/kilocode/design-system" // raya_change - owner design-system lock
import { RayaSelfHeal } from "@/kilocode/self-heal" // raya_change - global feedback backlog contracts
// raya_change start - Milestone F browser API contracts
import {
  Failure as BrowserFailure,
  Request as BrowserRequest,
  RequestID as BrowserRequestID,
  Result as BrowserResult,
} from "@/kilocode/browser/protocol"
// raya_change end
// raya_change start - Milestone E canvas API contracts
import {
  Failure as CanvasFailure,
  Request as CanvasRequest,
  RequestID as CanvasRequestID,
  Result as CanvasResult,
} from "@/kilocode/canvas/protocol"
// raya_change end

const root = "/kilocode"
const Scope = Schema.Literals(["global", "project"])

export const BackgroundJobInfo = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const BackgroundJobsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: SessionID,
})

export const ProjectUsageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  range: Schema.optional(ProjectUsage.Range),
}) // raya_change - bounded historical usage query

export const RemoveSkillPayload = Schema.Struct({
  location: Schema.String,
})

export const RemoveCommandPayload = Schema.Struct({
  location: Schema.String,
})

export const RemoveAgentPayload = Schema.Struct({
  name: Schema.String,
  scope: Schema.optional(Scope),
})

export const NotebookReplyPayload = Schema.Struct({ result: NotebookResult })
export const NotebookRejectPayload = Schema.Struct({ error: NotebookFailure })
export const AgentManagerReplyPayload = Schema.Struct({ result: AgentManagerResult })
export const AgentManagerRejectPayload = Schema.Struct({ error: AgentManagerFailure })
export const TaskCreatePayload = RayaTask.Create
export const TaskUpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  output: Schema.optional(RayaTask.Output),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  memoryScope: Schema.optional(Schema.Literals(["role", "project", "session"])),
  schedule: Schema.optional(RayaTask.Schedule),
  expectedSchedule: Schema.optional(RayaTask.Schedule),
  expectedAccess: Schema.optional(Schema.Literals(["brief", "full", "unset"])),
  expectedOutput: Schema.optional(Schema.Union([RayaTask.Output, Schema.Literal("unset")])),
  expectedScheduleVersion: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
  avatar: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  plan: Schema.optional(Schema.String),
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, id: Schema.String })),
  mode: Schema.optional(Schema.String),
  dir: Schema.optional(Schema.String),
  access: Schema.optional(Schema.Literals(["full", "brief"])),
  tools: Schema.optional(Schema.Array(Schema.String)),
  note: Schema.optional(Schema.String),
})
export const TaskEventPayload = Schema.Struct({
  source: Schema.String,
  filter: Schema.optional(Schema.String),
})
export const GoalCreatePayload = RayaGoal.Create // raya_change - Milestone A goal API contracts
export const GoalUpdatePayload = RayaGoal.Control // raya_change - Milestone A goal API contracts
export const CheckpointCreatePayload = RayaCheckpoint.CreatePayload // raya_change - named workspace checkpoints
export const DesignSystemSetPayload = RayaDesignSystem.SetPayload // raya_change - owner design-system lock
export const SelfHealCreatePayload = RayaSelfHeal.Create // raya_change
export const SelfHealUpdatePayload = RayaSelfHeal.Update // raya_change
export const BrowserReplyPayload = Schema.Struct({ result: BrowserResult }) // raya_change - Milestone F
export const BrowserRejectPayload = Schema.Struct({ error: BrowserFailure }) // raya_change - Milestone F
export const CanvasReplyPayload = Schema.Struct({ result: CanvasResult }) // raya_change - Milestone E
export const CanvasRejectPayload = Schema.Struct({ error: CanvasFailure }) // raya_change - Milestone E

export const KilocodePaths = {
  heapSnapshot: `${root}/heap/snapshot`,
  commandFiles: `${root}/command/files`,
  removeCommand: `${root}/command/remove`,
  removeSkill: `${root}/skill/remove`,
  removeAgent: `${root}/agent/remove`,
  providerUsage: `${root}/provider-usage`,
  providerUsageRefresh: `${root}/provider-usage/refresh`,
  projectUsage: `${root}/usage`, // raya_change - model token and cost history
  notebookList: `${root}/notebook`,
  notebookReply: `${root}/notebook/:requestID/reply`,
  notebookReject: `${root}/notebook/:requestID/reject`,
  agentManagerList: `${root}/agent-manager`,
  agentManagerReply: `${root}/agent-manager/:requestID/reply`,
  agentManagerReject: `${root}/agent-manager/:requestID/reject`,
  sessionModelUsage: `/session/:sessionID/model-usage`,
  backgroundJobs: `${root}/background-jobs`,
  backgroundJobCancel: `${root}/background-jobs/:jobID/cancel`,
  goal: `/session/:sessionID/goal`, // raya_change - Milestone A session-scoped goal API
  goalDiscard: `/session/:sessionID/goal/discard`, // raya_change - reliable workspace rollback
  goalStop: `/session/:sessionID/goal/stop`,
  checkpoint: `/session/:sessionID/checkpoint`, // raya_change - named workspace checkpoints
  checkpointItem: `/session/:sessionID/checkpoint/:checkpointID`, // raya_change - jump to / remove a named checkpoint
  designSystem: `${root}/design-system`, // raya_change - owner design-system lock
  selfHeal: `${root}/self-heal`, // raya_change - global structured feedback backlog
  selfHealItem: `${root}/self-heal/:itemID`, // raya_change
  browserList: `${root}/browser`, // raya_change - Milestone F browser host API
  browserUploadChunk: `${root}/browser/uploads/:uploadID/files/:fileID/chunk`,
  browserUploadRelease: `${root}/browser/uploads/:uploadID/files/:fileID/release`,
  browserReply: `${root}/browser/:requestID/reply`, // raya_change - Milestone F browser host API
  browserReject: `${root}/browser/:requestID/reject`, // raya_change - Milestone F browser host API
  canvasList: `${root}/canvas`, // raya_change - Milestone E canvas host API
  canvasReply: `${root}/canvas/:requestID/reply`, // raya_change - Milestone E canvas host API
  canvasReject: `${root}/canvas/:requestID/reject`, // raya_change - Milestone E canvas host API
  agents: `${root}/agent`,
  agentForecast: `${root}/agent-forecast`,
  agentItem: `${root}/agent/:agentID`,
  agentRun: `${root}/agent/:agentID/run`,
  agentRuns: `${root}/agent/:agentID/runs`,
  agentArchive: `${root}/agent-archive`,
  agentSnapshot: `${root}/agent/:agentID/runs/:runID/snapshot`,
  agentTemplates: `${root}/agent-templates`,
  agentEvent: `${root}/agent-event`,
  agentInbox: `${root}/agent-inbox`,
  agentInboxItem: `${root}/agent/:agentID/inbox`,
  agentInboxRead: `${root}/agent/:agentID/inbox/read`,
  agentInboxDraft: `${root}/agent/:agentID/inbox/draft`,
} as const

export const KilocodeApi = HttpApi.make("kilocode")
  .add(
    HttpApiGroup.make("kilocode")
      .add(
        HttpApiEndpoint.post("heapSnapshot", KilocodePaths.heapSnapshot, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.String, "Heap snapshot file path"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.heap.snapshot",
            summary: "Write heap snapshot",
            description: "Write a heap snapshot for the CLI process to the log directory.",
          }),
        ),
        HttpApiEndpoint.get("commandFiles", KilocodePaths.commandFiles, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(CommandFiles.Info), "Command files"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.commandFiles",
            summary: "List command files",
            description: "List commands with editable file locations for settings clients.",
          }),
        ),
        HttpApiEndpoint.post("removeCommand", KilocodePaths.removeCommand, {
          query: WorkspaceRoutingQuery,
          payload: RemoveCommandPayload,
          success: described(Schema.Boolean, "Command removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeCommand",
            summary: "Remove a command",
            description: "Remove a command by deleting its markdown file from disk and clearing it from cache.",
          }),
        ),
        HttpApiEndpoint.post("removeSkill", KilocodePaths.removeSkill, {
          query: WorkspaceRoutingQuery,
          payload: RemoveSkillPayload,
          success: described(Schema.Boolean, "Skill removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeSkill",
            summary: "Remove a skill",
            description: "Remove a skill by deleting its manifest from disk and clearing it from cache.",
          }),
        ),
        HttpApiEndpoint.post("removeAgent", KilocodePaths.removeAgent, {
          query: WorkspaceRoutingQuery,
          payload: RemoveAgentPayload,
          success: described(Schema.Boolean, "Agent removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeAgent",
            summary: "Remove a custom agent",
            description:
              "Remove a custom (non-native) agent from one writable configuration scope, or every writable scope when omitted, and dispose cached instance state.",
          }),
        ),
        HttpApiEndpoint.get("providerUsage", KilocodePaths.providerUsage, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderUsage.Info, "Current provider usage"),
          error: HttpApiError.ServiceUnavailable,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.providerUsage.get",
            summary: "Get provider usage",
            description: "Get cache-aware, secret-free provider plan usage and personal billing status.",
          }),
        ),
        HttpApiEndpoint.post("providerUsageRefresh", KilocodePaths.providerUsageRefresh, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderUsage.Info, "Refreshed provider usage"),
          error: HttpApiError.ServiceUnavailable,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.providerUsage.refresh",
            summary: "Refresh provider usage",
            description: "Refresh provider plan usage while coalescing concurrent source requests.",
          }),
        ),
        HttpApiEndpoint.get("projectUsage", KilocodePaths.projectUsage, {
          query: ProjectUsageQuery,
          success: described(ProjectUsage.Info, "Project model token and cost history"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.projectUsage",
            summary: "Get project model usage",
            description: "Aggregate settled model tokens and costs for the routed project over a UTC rolling range.",
          }),
        ),
        HttpApiEndpoint.get("notebookList", KilocodePaths.notebookList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(NotebookRequest), "Pending notebook host requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.notebook.list",
            summary: "List pending notebook requests",
            description: "List pending native notebook requests for the routed workspace.",
          }),
        ),
        HttpApiEndpoint.post("notebookReply", KilocodePaths.notebookReply, {
          params: { requestID: NotebookRequestID },
          query: WorkspaceRoutingQuery,
          payload: NotebookReplyPayload,
          success: described(Schema.Boolean, "Notebook reply accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.notebook.reply",
            summary: "Reply to a notebook request",
            description: "Complete a pending native notebook request with a structured result.",
          }),
        ),
        HttpApiEndpoint.post("notebookReject", KilocodePaths.notebookReject, {
          params: { requestID: NotebookRequestID },
          query: WorkspaceRoutingQuery,
          payload: NotebookRejectPayload,
          success: described(Schema.Boolean, "Notebook rejection accepted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.notebook.reject",
            summary: "Reject a notebook request",
            description: "Complete a pending native notebook request with a structured host error.",
          }),
        ),
        // raya_change start - Milestone F browser host API
        HttpApiEndpoint.post("browserUploadChunk", KilocodePaths.browserUploadChunk, {
          params: { uploadID: Schema.String, fileID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            sessionID: SessionID,
            offset: Schema.Number.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
          }),
          success: UploadChunk,
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.browser.uploadChunk",
            summary: "Read an authorized staged upload chunk",
            description: "Read at most one MiB from a task-bound upload file reference; no arbitrary path is accepted.",
          }),
        ),
        HttpApiEndpoint.post("browserUploadRelease", KilocodePaths.browserUploadRelease, {
          params: { uploadID: Schema.String, fileID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ sessionID: SessionID }),
          success: Schema.Boolean,
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.browser.uploadRelease",
            summary: "Release staged upload bytes",
            description: "Remove the source staging bytes after verified host staging or cancellation.",
          }),
        ),
        HttpApiEndpoint.get("browserList", KilocodePaths.browserList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(BrowserRequest), "Pending browser host requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.browser.list",
            summary: "List pending browser requests",
            description: "List pending shared-browser requests for the routed workspace.",
          }),
        ),
        HttpApiEndpoint.post("browserReply", KilocodePaths.browserReply, {
          params: { requestID: BrowserRequestID },
          query: WorkspaceRoutingQuery,
          payload: BrowserReplyPayload,
          success: described(Schema.Boolean, "Browser reply accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.browser.reply",
            summary: "Reply to a browser request",
            description: "Complete a pending shared-browser request with a structured result.",
          }),
        ),
        HttpApiEndpoint.post("browserReject", KilocodePaths.browserReject, {
          params: { requestID: BrowserRequestID },
          query: WorkspaceRoutingQuery,
          payload: BrowserRejectPayload,
          success: described(Schema.Boolean, "Browser rejection accepted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.browser.reject",
            summary: "Reject a browser request",
            description: "Complete a pending shared-browser request with a structured host error.",
          }),
        ),
        // raya_change end
        // raya_change start - Milestone E canvas host API
        HttpApiEndpoint.get("canvasList", KilocodePaths.canvasList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(CanvasRequest), "Pending canvas host requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.canvas.list",
            summary: "List pending canvas requests",
            description: "List pending live-canvas requests for the routed workspace.",
          }),
        ),
        HttpApiEndpoint.post("canvasReply", KilocodePaths.canvasReply, {
          params: { requestID: CanvasRequestID },
          query: WorkspaceRoutingQuery,
          payload: CanvasReplyPayload,
          success: described(Schema.Boolean, "Canvas reply accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.canvas.reply",
            summary: "Reply to a canvas request",
            description: "Complete a pending live-canvas request with its render status.",
          }),
        ),
        HttpApiEndpoint.post("canvasReject", KilocodePaths.canvasReject, {
          params: { requestID: CanvasRequestID },
          query: WorkspaceRoutingQuery,
          payload: CanvasRejectPayload,
          success: described(Schema.Boolean, "Canvas rejection accepted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.canvas.reject",
            summary: "Reject a canvas request",
            description: "Complete a pending live-canvas request with a host error.",
          }),
        ),
        // raya_change end
        HttpApiEndpoint.get("agentManagerList", KilocodePaths.agentManagerList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(AgentManagerRequest), "Pending Agent Manager host requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentManager.list",
            summary: "List pending Agent Manager requests",
            description: "List pending native Agent Manager orchestration requests for the routed workspace.",
          }),
        ),
        HttpApiEndpoint.post("agentManagerReply", KilocodePaths.agentManagerReply, {
          params: { requestID: AgentManagerRequestID },
          query: WorkspaceRoutingQuery,
          payload: AgentManagerReplyPayload,
          success: described(Schema.Boolean, "Agent Manager reply accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentManager.reply",
            summary: "Reply to an Agent Manager request",
            description: "Complete a pending Agent Manager orchestration request with a structured result.",
          }),
        ),
        HttpApiEndpoint.post("agentManagerReject", KilocodePaths.agentManagerReject, {
          params: { requestID: AgentManagerRequestID },
          query: WorkspaceRoutingQuery,
          payload: AgentManagerRejectPayload,
          success: described(Schema.Boolean, "Agent Manager rejection accepted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentManager.reject",
            summary: "Reject an Agent Manager request",
            description: "Complete a pending Agent Manager orchestration request with a structured host error.",
          }),
        ),
        HttpApiEndpoint.get("sessionModelUsage", KilocodePaths.sessionModelUsage, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ModelUsage.Info, "Model usage for a session tree"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.sessionModelUsage",
            summary: "Get session model usage",
            description: "Get token usage and direct cost by model for the complete top-level session tree.",
          }),
        ),
        HttpApiEndpoint.get("backgroundJobs", KilocodePaths.backgroundJobs, {
          query: BackgroundJobsQuery,
          success: described(Schema.Array(BackgroundJobInfo), "Background jobs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.backgroundJobs",
            summary: "List background jobs",
            description: "List background subagent jobs owned by one parent session.",
          }),
        ),
        HttpApiEndpoint.post("backgroundJobCancel", KilocodePaths.backgroundJobCancel, {
          params: { jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Background job cancelled"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.backgroundJob.cancel",
            summary: "Cancel background job",
            description: "Cancel one background subagent job and its session tree.",
          }),
        ),
        // raya_change start - Milestone A session-scoped goal API
        HttpApiEndpoint.post("goalCreate", KilocodePaths.goal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: GoalCreatePayload,
          success: described(RayaGoal.State, "Created goal"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.create",
            summary: "Create a session goal",
            description: "Arm one durable goal for a session.",
          }),
        ),
        HttpApiEndpoint.get("goalGet", KilocodePaths.goal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(RayaGoal.State, "Current goal"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.get",
            summary: "Get a session goal",
            description: "Get the durable goal state for a session.",
          }),
        ),
        HttpApiEndpoint.patch("goalUpdate", KilocodePaths.goal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: GoalUpdatePayload,
          success: described(RayaGoal.State, "Updated goal"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, HttpApiError.Conflict],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.update",
            summary: "Control or revise a session goal",
            description: "Pause, resume, or revise a goal without cancelling its current model turn.",
          }),
        ),
        HttpApiEndpoint.delete("goalClear", KilocodePaths.goal, {
          params: { sessionID: SessionID },
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            expectedIntent: RayaGoal.Control.fields.expectedIntent,
          }),
          success: described(Schema.Boolean, "Goal cleared"),
          error: [HttpApiError.Conflict],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.clear",
            summary: "Clear a session goal",
            description:
              "Remove goal tracking. A reviewed control revision also requests cancellation of its matching owned worker; the boolean only confirms tracking removal.",
          }),
        ),
        HttpApiEndpoint.get("goalStopResult", KilocodePaths.goalStop, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(RayaGoal.Stop, "Latest saved goal stop result"),
          error: [HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.stopResult",
            summary: "Read the latest goal stop result",
            description:
              "Read the latest saved stop receipt for this session without changing tracking or cancelling work.",
          }),
        ),
        HttpApiEndpoint.post("goalStop", KilocodePaths.goalStop, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            expectedIntent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          }),
          success: described(RayaGoal.Stop, "Saved goal stop result"),
          error: [HttpApiError.Conflict],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.stop",
            summary: "Stop a reviewed goal and retrieve its saved result",
            description:
              "Retry with the same intent to retrieve the saved result without cancelling a replacement worker. A cleared phase confirms tracking removal but leaves the worker outcome unconfirmed.",
          }),
        ),
        HttpApiEndpoint.post("goalDiscard", KilocodePaths.goalDiscard, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Goal workspace restored and state cleared"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.discard",
            summary: "Discard a session goal",
            description:
              "Restore the goal's workspace checkpoint, including files created by child sessions, then clear it.",
          }),
        ),
        // raya_change start - named workspace checkpoints
        HttpApiEndpoint.get("checkpointList", KilocodePaths.checkpoint, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(RayaCheckpoint.List, "Named checkpoints for the session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.checkpoint.list",
            summary: "List session checkpoints",
            description: "List the named workspace checkpoints saved for a session, newest first.",
          }),
        ),
        HttpApiEndpoint.post("checkpointCreate", KilocodePaths.checkpoint, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CheckpointCreatePayload,
          success: described(RayaCheckpoint.Info, "Created checkpoint"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.checkpoint.create",
            summary: "Create a named checkpoint",
            description: "Capture the current workspace as a named checkpoint the user can jump back to.",
          }),
        ),
        HttpApiEndpoint.post("checkpointJump", KilocodePaths.checkpointItem, {
          params: { sessionID: SessionID, checkpointID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workspace restored to the checkpoint"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.checkpoint.jump",
            summary: "Jump to a checkpoint",
            description: "Restore the workspace to a previously named checkpoint.",
          }),
        ),
        HttpApiEndpoint.delete("checkpointRemove", KilocodePaths.checkpointItem, {
          params: { sessionID: SessionID, checkpointID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Checkpoint removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.checkpoint.remove",
            summary: "Remove a checkpoint",
            description: "Delete a named checkpoint without touching the workspace.",
          }),
        ),
        // raya_change end
        HttpApiEndpoint.post("agentForecast", KilocodePaths.agentForecast, {
          query: WorkspaceRoutingQuery,
          payload: RayaTask.Proposal,
          success: described(RayaTask.Forecast, "Normalized schedule and upcoming occurrences"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.forecast",
            summary: "Preview a routine schedule",
            description:
              "Validate a schedule and calculate up to three upcoming occurrences without creating a routine.",
          }),
        ),
        HttpApiEndpoint.get("agentList", KilocodePaths.agents, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(RayaTask.Agent), "Assigned agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.list",
            summary: "List assigned agents",
            description: "List persistent role-based agents and their standing jobs.",
          }),
        ),
        HttpApiEndpoint.get("agentArchive", KilocodePaths.agentArchive, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
            agentID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
          }),
          success: described(RayaTask.ArchivePage, "Removed routine page"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.archive",
            summary: "List retained routine definitions",
            description:
              "Read up to 50 final definitions saved during successful routine removal, newest capture first. Pass next as cursor to continue, or agentID for a single retained definition. Excludes routines still in the roster. New removals appear on refresh. Does not restore or run work; earlier removals without an archive record are not reconstructed.",
          }),
        ),
        HttpApiEndpoint.post("agentCreate", KilocodePaths.agents, {
          query: WorkspaceRoutingQuery,
          payload: TaskCreatePayload,
          success: described(RayaTask.Agent, "Created agent"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.create",
            summary: "Create an assigned agent",
            description: "Create a named agent with a role, standing job, and schedule.",
          }),
        ),
        HttpApiEndpoint.patch("agentUpdate", KilocodePaths.agentItem, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: TaskUpdatePayload,
          success: described(RayaTask.Agent, "Updated agent"),
          error: [InvalidRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.update",
            summary: "Update an assigned agent",
            description: "Edit a standing job, schedule, or enabled flag.",
          }),
        ),
        HttpApiEndpoint.delete("agentRemove", KilocodePaths.agentItem, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Removed"),
          error: [InvalidRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.remove",
            summary: "Remove an assigned agent",
            description:
              "Remove an idle routine from the roster. Preserve run history, role memory and sessions. Unfinished runs or unresolved startup prevent removal; disabling prevents future launches without stopping a run.",
          }),
        ),
        HttpApiEndpoint.post("agentRun", KilocodePaths.agentRun, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(RayaTask.Run, "Started run"),
          error: [InvalidRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.run",
            summary: "Run an assigned agent now",
            description: "Start one background goal run for the agent without waiting for its schedule.",
          }),
        ),
        HttpApiEndpoint.get("agentRuns", KilocodePaths.agentRuns, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(RayaTask.Run), "Run history"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.runs",
            summary: "List agent runs",
            description: "Bounded run history with outcome and cost.",
          }),
        ),
        HttpApiEndpoint.get("agentSnapshot", KilocodePaths.agentSnapshot, {
          params: { agentID: Schema.String, runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(RayaTaskSnapshot.Info, "Original startup instructions"),
          error: [HttpApiError.NotFound, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.snapshot",
            summary: "Read original routine startup instructions",
            description:
              "Read the immutable selected definition and resolved objective for a routine run, including retained snapshots after routine removal. The saved routine and run identities must match the request. Does not create or resume work.",
          }),
        ),
        HttpApiEndpoint.get("agentTemplates", KilocodePaths.agentTemplates, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(AgentTemplate), "Starter role templates"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.templates",
            summary: "List agent templates",
            description: "Starter roles for assigning a useful agent in two clicks.",
          }),
        ),
        HttpApiEndpoint.post("agentEvent", KilocodePaths.agentEvent, {
          query: WorkspaceRoutingQuery,
          payload: TaskEventPayload,
          success: described(Schema.Array(RayaTask.Run), "Started runs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.event",
            summary: "Fire event-triggered agents",
            description: "Start background runs for assigned agents whose event schedule matches this source.",
          }),
        ),
        HttpApiEndpoint.get("agentInbox", KilocodePaths.agentInbox, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(InboxItem), "Routine inbox summaries"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.inbox",
            summary: "List routine inbox conversations",
            description:
              "List roster workers with unread counts, latest message, draft and operational state. Does not load full transcripts.",
          }),
        ),
        HttpApiEndpoint.get("agentInboxPage", KilocodePaths.agentInboxItem, {
          params: { agentID: Schema.String },
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
            limit: Schema.optional(
              Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
            ),
          }),
          success: described(InboxPage, "Routine conversation page"),
          error: [InvalidRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.inbox.page",
            summary: "List messages in a routine conversation",
            description: "Return up to 50 persisted inbox messages, newest page first, without starting work.",
          }),
        ),
        HttpApiEndpoint.post("agentInboxSend", KilocodePaths.agentInboxItem, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: InboxSend,
          success: described(InboxRecord, "Persisted user message"),
          error: [InvalidRequestError, HttpApiError.NotFound, HttpApiError.Conflict],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.inbox.send",
            summary: "Persist one user follow-up in a routine conversation",
            description:
              "Admit one idempotent user message into the selected worker conversation. Does not rewrite the recurring assignment or start a run.",
          }),
        ),
        HttpApiEndpoint.post("agentInboxRead", KilocodePaths.agentInboxRead, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: InboxRead,
          success: described(InboxRead, "Advanced read position"),
          error: [InvalidRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.inbox.read",
            summary: "Advance routine inbox read position",
            description: "Persist a conversation read cursor that survives webview reload. Read position only advances.",
          }),
        ),
        HttpApiEndpoint.post("agentInboxDraft", KilocodePaths.agentInboxDraft, {
          params: { agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: InboxDraft,
          success: described(InboxDraft, "Saved draft"),
          error: [InvalidRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.routine.inbox.draft",
            summary: "Save a per-conversation inbox draft",
            description: "Replace or clear the draft for one roster worker. Drafts are not messages and do not admit work.",
          }),
        ),
        // raya_change start - owner design-system lock
        HttpApiEndpoint.get("designSystemGet", KilocodePaths.designSystem, {
          query: WorkspaceRoutingQuery,
          success: described(RayaDesignSystem.Info, "Current design-system lock state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.designSystem.get",
            summary: "Get design-system lock",
            description: "Get whether an owner-approved design system is locked, and its optional source.",
          }),
        ),
        HttpApiEndpoint.post("designSystemSet", KilocodePaths.designSystem, {
          query: WorkspaceRoutingQuery,
          payload: DesignSystemSetPayload,
          success: described(RayaDesignSystem.Info, "Updated design-system lock state"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.designSystem.set",
            summary: "Set design-system lock",
            description: "Enable or disable the owner design-system lock and record its optional source.",
          }),
        ),
        // raya_change end
        HttpApiEndpoint.post("selfHealCreate", KilocodePaths.selfHeal, {
          query: WorkspaceRoutingQuery,
          payload: SelfHealCreatePayload,
          success: described(RayaSelfHeal.Item, "Triaged self-heal feedback"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.create",
            summary: "Capture self-heal feedback",
            description: "Classify, deduplicate, and persist one globally visible Raya feedback item.",
          }),
        ),
        HttpApiEndpoint.get("selfHealOutcome", `${KilocodePaths.selfHealItem}/repair`, {
          params: { itemID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: RayaSelfHeal.Repair,
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.outcome",
            summary: "Read a retained repair attempt",
            description: "Read the durable repair journal even when its original backlog item is unavailable.",
          }),
        ),
        HttpApiEndpoint.post("selfHealAdmit", `${KilocodePaths.selfHealItem}/repair`, {
          params: { itemID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: RayaSelfHeal.RepairAdmission,
          success: RayaSelfHeal.RepairGranted,
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.admit",
            summary: "Reserve one repair attempt",
            description:
              "Retain exclusive repair ownership and report existing or conflicting attempts without replay.",
          }),
        ),
        HttpApiEndpoint.post("selfHealPrepare", `${KilocodePaths.selfHealItem}/repair/worktree`, {
          params: { itemID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: RayaSelfHeal.RepairPrepare,
          success: RayaSelfHeal.Repair,
          error: HttpApiError.Conflict,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.prepare",
            summary: "Prepare the owned repair checkout",
            description:
              "Reserve and create one exact-commit worktree, retaining its identity when creation is uncertain.",
          }),
        ),
        HttpApiEndpoint.post("selfHealAdvance", `${KilocodePaths.selfHealItem}/repair/step`, {
          params: { itemID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: RayaSelfHeal.RepairAdvance,
          success: RayaSelfHeal.Repair,
          error: HttpApiError.Conflict,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.advance",
            summary: "Advance the owned repair startup",
            description:
              "Record each startup boundary once; retain unknown dispatch outcomes without automatic replay.",
          }),
        ),
        HttpApiEndpoint.get("selfHealList", KilocodePaths.selfHeal, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(RayaSelfHeal.Item), "Global self-heal backlog"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.list",
            summary: "List self-heal feedback",
            description: "List durable feedback across Raya sessions and workspaces.",
          }),
        ),
        HttpApiEndpoint.get("selfHealGet", KilocodePaths.selfHealItem, {
          params: { itemID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(RayaSelfHeal.Item, "Self-heal feedback item"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.get",
            summary: "Get self-heal feedback",
            description: "Get one durable feedback item and its verification evidence.",
          }),
        ),
        HttpApiEndpoint.patch("selfHealUpdate", KilocodePaths.selfHealItem, {
          params: { itemID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SelfHealUpdatePayload,
          success: described(RayaSelfHeal.Item, "Updated self-heal feedback"),
          error: [HttpApiError.NotFound, HttpApiError.Conflict],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.update",
            summary: "Update self-heal feedback",
            description:
              "Update triage and diagnostic evidence. Tested completion is derived only from an authoritative linked-goal receipt; delivery claims are rejected.",
          }),
        ),
        // raya_change end
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "kilocode",
          description: "Kilo-specific routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .addHttpApi(AnacondaDesktopApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
