import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
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
export const GoalCreatePayload = RayaGoal.Create // raya_change - Milestone A goal API contracts
export const GoalUpdatePayload = RayaGoal.Control // raya_change - Milestone A goal API contracts
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
  selfHeal: `${root}/self-heal`, // raya_change - global structured feedback backlog
  selfHealItem: `${root}/self-heal/:itemID`, // raya_change
  browserList: `${root}/browser`, // raya_change - Milestone F browser host API
  browserReply: `${root}/browser/:requestID/reply`, // raya_change - Milestone F browser host API
  browserReject: `${root}/browser/:requestID/reject`, // raya_change - Milestone F browser host API
  canvasList: `${root}/canvas`, // raya_change - Milestone E canvas host API
  canvasReply: `${root}/canvas/:requestID/reply`, // raya_change - Milestone E canvas host API
  canvasReject: `${root}/canvas/:requestID/reject`, // raya_change - Milestone E canvas host API
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
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.update",
            summary: "Control or revise a session goal",
            description: "Pause, resume, or revise a goal without cancelling its current model turn.",
          }),
        ),
        HttpApiEndpoint.delete("goalClear", KilocodePaths.goal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Goal cleared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.goal.clear",
            summary: "Clear a session goal",
            description: "Remove the durable goal state for a session.",
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
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.selfHeal.update",
            summary: "Update self-heal feedback",
            description: "Move an item through queued, active, blocked, and verified states with evidence.",
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
