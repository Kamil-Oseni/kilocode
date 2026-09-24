import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider" // kilocode_change
import { KiloTask } from "../kilocode/tool/task" // kilocode_change
import { KiloTaskBackgroundProcess } from "../kilocode/tool/task-background-process" // kilocode_change
import { KiloCostPropagation } from "../kilocode/session/cost-propagation" // kilocode_change
import { KiloSessionProcessor } from "../kilocode/session/processor" // kilocode_change
import { KiloSession } from "../kilocode/session" // kilocode_change
import { resumeHint } from "../kilocode/task-resume" // kilocode_change
import { errorMessage } from "@/util/error" // kilocode_change
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as SandboxPolicy from "@/kilocode/sandbox/policy" // kilocode_change
import { Database } from "@opencode-ai/core/database/database"
import { Permission } from "@/permission" // raya_change - Milestone D auto-routing respects inherited task denies
import { RayaChief } from "@/kilocode/chief" // raya_change - Milestone B enforced Auto decision
import * as GoalChildren from "@/kilocode/goal/children" // kilocode_change - raya_change: goal child reservations
import { Storage } from "@/storage/storage" // kilocode_change - raya_change: durable goal child limit
import { ModelV2 } from "@opencode-ai/core/model" // raya_change - Milestone B preserved target model
import { ProviderV2 } from "@opencode-ai/core/provider" // raya_change - Milestone B preserved target model
import { TaskName } from "@/kilocode/tool/task-name" // kilocode_change - raya_change: durable subagent display identity
import { TaskRepeat } from "@/kilocode/task-repeat" // kilocode_change - reuse failed equivalent children
import { TaskAuthority } from "@/kilocode/tool/task-authority" // kilocode_change - durable Raya child authority
import { Desktop } from "@/kilocode/desktop/service" // kilocode_change - exact Computer Use child grant admission
import { ChiefBranches } from "@/kilocode/chief/branches" // kilocode_change - bind planned Auto branches to child calls
import { ChiefTaskBinding } from "@/kilocode/chief/task-binding" // kilocode_change - saved branch preflight
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan" // kilocode_change - request-bound branch admission
import { ChiefBranchOutcome } from "@/kilocode/chief/outcome" // kilocode_change - exact child terminal receipt
import { Git } from "@/git" // kilocode_change - pin editing branches to the parent HEAD
import { Worktree } from "@/worktree" // kilocode_change - isolated Chief edit workspaces
import { InstanceStore } from "@/project/instance-store" // kilocode_change - run edit children in their worktree
import { InstanceState } from "@/effect/instance-state" // kilocode_change - record the parent directory

export interface TaskPromptOps {
  cancel(sessionID: SessionID, messageID?: MessageID): Effect.Effect<void> // kilocode_change
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Use foreground when you need the result before proceeding; otherwise use background for non-overlapping work, but do not give the final answer until all required background results have arrived.", // kilocode_change
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({
    description: "A short (3-7 words), outcome-specific display name for the delegated task",
  }),
  // raya_change start - Milestone D defaults delegation to Chief auto-selection
  prompt: Schema.optional(Schema.String).annotate({ description: "Legacy task objective; prefer brief.objective" }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description:
      'Optional explicit specialist override. Omit this or pass "auto" to let the Chief select the best-fit subagent.',
  }),
  brief: Schema.optional(
    Schema.Struct({
      objective: Schema.String,
      context: Schema.optional(Schema.String),
      constraints: Schema.optional(Schema.Array(Schema.String)),
      expected_return: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Structured hand-off contract for the isolated subagent" }),
  step_cap: Schema.optional(Schema.Number).annotate({
    description: "Maximum agentic steps for this child (clamped to 1-50; defaults to 12)",
  }),
  // kilocode_change start - raya_change: explicit child authority ceiling
  access: Schema.optional(Schema.Literals(["read", "edit", "computer"])).annotate({
    // kilocode_change
    description:
      'Set "read" for research, "computer" for lease-scoped desktop work without filesystem edits, or "edit" only when the parent policy allows file changes. Omitted keeps legacy task behavior.',
  }),
  branch_id: Schema.optional(Schema.String).annotate({
    description: "Exact branch ID from a saved Auto Chief plan. Required when the active goal has a branch plan.",
  }),
  // kilocode_change end
  // raya_change end
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  // kilocode_change start - surface the resumable task_id when a background subagent fails (#11620)
  const hint = resumeHint(input.sessionID)
  const body = input.state === "error" && !input.text.includes(hint) ? `${input.text}\n${hint}` : input.text
  // kilocode_change end
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    body, // kilocode_change - was input.text
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service // kilocode_change
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service)) // kilocode_change - raya_change: optional outside durable goal contexts
    const desktop = Option.getOrUndefined(yield* Effect.serviceOption(Desktop.Service)) // kilocode_change
    const children = storage ? yield* GoalChildren.make({ storage, sessions }) : undefined // kilocode_change - raya_change
    const branches = storage ? ChiefBranches.make(storage) : undefined // kilocode_change
    // kilocode_change start - optional until Chief edit plans request an isolated workspace
    const git = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
    const worktree = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const store = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    // kilocode_change end

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(new Error("Background subagents require KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"))
      }

      const parent = yield* sessions.get(ctx.sessionID)
      // kilocode_change start - a saved fanout plan is authoritative for this active goal
      const binding = yield* ChiefTaskBinding.load({
        storage,
        sessions,
        branches,
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        metadata: parent.metadata,
        callID: ctx.callID,
        params,
      })
      const plan = binding.plan
      const requestPlan = binding.request // kilocode_change - dormant request-bound plan
      const branch = binding.branch
      // kilocode_change end
      // kilocode_change start - resolve resumed, explicit, or Chief-routed specialists before permission checks
      const chief = ctx.agent === "auto" ? RayaChief.pending(parent.metadata) : undefined
      // kilocode_change start - a direct Chief answer cannot launch a child
      if (chief?.direct) {
        return yield* Effect.fail(
          new Error("Auto Chief selected a direct answer; no subagent is authorized for this request"),
        )
      }
      // kilocode_change end
      const follow = ctx.agent === "auto" ? RayaChief.follow(parent.metadata) : undefined
      const continued = ctx.agent === "auto" && !follow ? RayaChief.continuation(parent.metadata) : undefined
      if (ctx.agent === "auto" && !branch && !follow && !continued) {
        return yield* Effect.fail(new Error("Auto must call chief_route on a new request before delegating with task"))
      }
      const resumed = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      // kilocode_change start - reuse an equivalent failed child instead of spawning replacements
      const repeat = TaskRepeat.guard(ctx.messages, params)
      if (repeat) return yield* Effect.fail(new Error(repeat))
      // kilocode_change end
      if (resumed && resumed.parentID !== ctx.sessionID) {
        return yield* Effect.fail(
          new Error(`Cannot resume session ${params.task_id}: not a child of the current session`),
        )
      }
      const caller = yield* agent.get(ctx.agent)
      const ruleset = Permission.merge(caller.permission, parent.permission ?? [])
      // kilocode_change start - resumed child authority cannot be widened
      const access = TaskAuthority.select({
        requested: branch?.access ?? params.access, // kilocode_change - Chief must request computer access explicitly
        saved: TaskAuthority.read(resumed?.metadata),
        parent: ruleset,
      })
      const computer =
        access === "computer"
          ? yield* Effect.gen(function* () {
              if (!desktop) throw new Error("Computer Use is unavailable in this client")
              const result = yield* desktop.request({
                operation: "authorize",
                sessionID: ctx.sessionID,
                surface: "desktop",
                action: "observe",
                sensitive: false,
              })
              if (result.operation !== "authorize" || result.decision !== "allow" || !result.grantID)
                throw new Error("Computer Use child needs an active parent desktop grant")
              const prior = resumed ? TaskAuthority.proof(resumed.metadata, resumed.id, ctx.sessionID) : undefined
              if (prior && prior.grantID !== result.grantID)
                throw new Error("Computer Use grant changed; the existing child cannot be rebound")
              return result.grantID
            })
          : undefined
      // kilocode_change end
      const candidates = (yield* agent.list()).filter(
        (item) =>
          item.mode !== "primary" &&
          !item.hidden &&
          !item.deprecated &&
          Permission.evaluate(id, item.name, ruleset).action !== "deny",
      )
      const explicit = params.subagent_type && params.subagent_type !== "auto" ? params.subagent_type : undefined
      // kilocode_change start
      const request = branch
        ? [
            branch.name,
            branch.brief.objective,
            branch.brief.context ?? "",
            ...branch.brief.constraints,
            branch.brief.expectedReturn,
          ].join("\n")
        : [
            params.description,
            params.prompt ?? "",
            params.brief?.objective ?? "",
            params.brief?.context ?? "",
            ...(params.brief?.constraints ?? []),
            params.brief?.expected_return ?? "",
          ].join("\n")
      const routed =
        branch?.specialist ??
        chief?.agent ??
        follow?.agent ??
        resumed?.agent ??
        (continued ? RayaChief.route({ request: continued, agents: candidates }).agent : undefined) ??
        explicit ??
        KiloTask.route({ request, agents: candidates }).name
      // kilocode_change end
      const limit = KiloTask.cap(params.step_cap)
      // kilocode_change start - /canvas must survive Auto → designer delegation
      const canvas =
        parent.metadata?.["raya.canvas.command"] === true ||
        /create_canvas|\/canvas\b|live, interactive canvas/i.test(
          [chief?.request, continued, params.prompt, params.brief?.objective].filter(Boolean).join("\n"),
        )
      const canvasRule =
        "You MUST call create_canvas as your first tool. Do NOT write .html/.htm files or open a browser for this artifact."
      const extras = canvas ? [canvasRule] : []
      const handoff = KiloTask.brief({
        prompt: branch?.brief.objective ?? chief?.request ?? continued ?? params.prompt,
        brief: {
          objective:
            branch?.brief.objective ?? chief?.request ?? continued ?? params.brief?.objective ?? params.prompt ?? "",
          context: branch
            ? branch.brief.context
            : chief
              ? [params.brief?.context, chief.needs_plan ? "Plan the approach before execution." : undefined]
                  .filter(Boolean)
                  .join("\n")
              : params.brief?.context,
          expected_return: branch?.brief.expectedReturn ?? params.brief?.expected_return,
          constraints: [...(branch?.brief.constraints ?? params.brief?.constraints ?? []), ...extras],
        },
        cap: limit,
      })
      // kilocode_change end
      let current = parent
      let depth = 0
      while (current.parentID) {
        // kilocode_change start - tolerate pruned or corrupt ancestor rows
        const next = yield* sessions
          .get(current.parentID)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
        if (!next) break
        // kilocode_change end
        depth++
        current = next // kilocode_change
      }
      const nested = cfg.subagent_depth ?? 2 // kilocode_change - specialists may spawn one nested subagent by default
      if (depth >= nested) {
        return yield* Effect.fail(
          new Error(`Subagent depth limit reached (${nested}). Increase "subagent_depth" to allow nested subagents.`),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [routed], // raya_change - authorize the actual Chief-selected specialist
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: routed, // raya_change
          },
        })
      }

      const next = yield* agent.get(routed) // raya_change - explicit override or automatic route
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${routed} is not a valid agent type`))
      }
      // kilocode_change start — reject primary agents; only subagent/all modes allowed
      KiloTask.validate(next, routed)
      // kilocode_change end

      // kilocode_change start - validate the parent message before creating or mutating a child
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      // kilocode_change end

      // kilocode_change start — preserve selected subagent models and refuse unavailable choices before child mutation
      // raya_change start - Auto delegates from the user's selected model, never from Chief's cheap model
      const chiefParent = RayaChief.parent(parent.metadata)
      const parentModel = chiefParent
        ? {
            providerID: ProviderV2.ID.make(chiefParent.providerID),
            modelID: ModelV2.ID.make(chiefParent.modelID),
          }
        : {
            modelID: msg.info.modelID,
            providerID: msg.info.providerID,
          }
      // raya_change end
      const selected = yield* KiloTask.resolveModel({
        name: next.name,
        agent: next,
        config: cfg,
        parent: parentModel, // raya_change - Milestone B preserved user model
        variant: chiefParent?.variant ?? msg.info.variant, // raya_change
        workflow: chief ? undefined : KiloTask.workflow(ctx.extra), // kilocode_change // raya_change
        provider,
      })
      const model = selected.model
      const variant = selected.variant
      // kilocode_change end

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const canTask = depth + 1 < (cfg.subagent_depth ?? 2) // kilocode_change - honor upstream's opt-in depth limit
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      // kilocode_change start - reserve an exact edit workspace before Git mutation or child creation
      const parentDirectory = yield* InstanceState.directory
      const callID = ctx.callID
      const edit =
        branch?.access === "edit" && plan && branches && callID
          ? yield* Effect.gen(function* () {
              if (!git || !worktree || !store)
                return yield* Effect.fail(new Error("Auto Chief editing services are unavailable"))
              const changes = yield* git.status(parentDirectory)
              if (changes.length)
                return yield* Effect.fail(
                  new Error(
                    "Auto Chief editing needs a clean parent worktree; commit or stash local changes before launching this branch",
                  ),
                )
              const head = yield* git.run(["rev-parse", "HEAD"], { cwd: parentDirectory })
              const baseCommit = head.text().trim()
              if (head.exitCode !== 0 || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(baseCommit))
                return yield* Effect.fail(new Error("Auto Chief could not pin the parent Git commit"))
              const info = yield* worktree.plan({ name: `chief-${branch.id}-${ctx.sessionID.slice(-6)}` })
              if (!info.branch) return yield* Effect.fail(new Error("Auto Chief editing requires a named Git branch"))
              const record = {
                goalID: ctx.sessionID,
                goalCreatedAt: plan.goalCreatedAt,
                branchID: branch.id,
                callID,
                directory: info.directory,
                baseCommit,
              }
              const reserved = yield* branches.reserveWorktree({ ...record, name: info.name, branch: info.branch })
              if (reserved.phase !== "reserved")
                return yield* Effect.fail(
                  new Error("Auto Chief worktree creation has an uncertain or completed outcome"),
                )
              yield* worktree
                .createReadyFromInfo(info, undefined, baseCommit)
                .pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit)
                      ? branches
                          .uncertainWorktree(record)
                          .pipe(
                            Effect.catchCause((cause) =>
                              Effect.logWarning("Could not mark Chief worktree uncertain", cause),
                            ),
                          )
                      : Effect.void,
                  ),
                )
              yield* branches.readyWorktree(record)
              return info
            })
          : undefined
      // kilocode_change end

      const session = resumed // raya_change - reuse the child validated before auto-routing
      // kilocode_change start — inherit edit/bash/MCP restrictions from calling agent
      const rules = KiloTask.inherited({ caller, session: parent, mcp: cfg.mcp })
      const childPermission = KiloTask.merge(
        TaskAuthority.rules(access), // kilocode_change - start with a strict read-only tool allowlist
        deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: next,
        }),
        cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*",
          action: "deny" as const,
        })) ?? [],
        KiloTask.permissions(rules, canTask),
        TaskAuthority.denies(access, ruleset), // kilocode_change - parent read denials stay above child allows
      )
      // kilocode_change end
      // kilocode_change start - refresh current parent restrictions when resuming an existing task session
      const fallback = SandboxPolicy.fallback(cfg)
      if (session) {
        yield* SandboxPolicy.inherit(ctx.sessionID, session.id, fallback)
        const permission = KiloTask.merge(session.permission ?? [], childPermission)
        session.permission = permission
        yield* sessions.setPermission({ sessionID: session.id, permission })
      }
      // kilocode_change end
      const platform = KiloSession.resolvePlatform(ctx.sessionID) // kilocode_change - preserve parent attribution across task creation/resume
      // kilocode_change start // raya_change start - reserve before child creation and release every exit path
      const lease = children ? yield* children.claim(ctx.sessionID) : { release: Effect.void }
      // kilocode_change start - reserve before child creation; a crash leaves no replayable request branch
      const requestLedger = requestPlan && storage ? ChiefRequestPlan.make(storage, sessions) : undefined
      if (requestPlan && branch && ctx.callID && requestLedger)
        yield* requestLedger
          .reserve({
            sessionID: ctx.sessionID,
            requestID: requestPlan.identity.requestID,
            revision: requestPlan.identity.revision,
            branchID: branch.id,
            callID: ctx.callID,
          })
          .pipe(Effect.tapError(() => lease.release))
      // kilocode_change end
      // kilocode_change end // raya_change end
      // kilocode_change start - create a child session with inherited Kilo restrictions
      // raya_change start - allocate a durable, collision-safe identity only for a new child
      const selection = branch ? "auto" : explicit && !continued ? "explicit" : "auto"
      const created = yield* TaskName.gate
        .withLock(ctx.sessionID)(
          Effect.gen(function* () {
            if (session) {
              const identity = TaskName.read(session.metadata?.[TaskName.key])
              return { session, displayName: identity?.displayName ?? session.title }
            }
            const siblings = yield* sessions.children(ctx.sessionID)
            const identity = TaskName.allocate({
              description: branch?.name ?? params.description,
              objective: branch?.brief.objective ?? params.brief?.objective,
              prompt: branch?.brief.objective ?? params.prompt,
              specialist: next.name,
              selection,
              parentSessionID: ctx.sessionID,
              parentMessageID: ctx.messageID,
              callID: ctx.callID,
              siblings,
            })
            const create = sessions.create({
              parentID: ctx.sessionID,
              title: identity.displayName,
              agent: next.name,
              metadata: TaskAuthority.save({ [TaskName.key]: identity }, access), // kilocode_change
              platform,
              permission: childPermission,
            })
            const child = yield* edit && store ? store.provide({ directory: edit.directory }, create) : create // kilocode_change
            return { session: child, displayName: identity.displayName }
          }),
        )
        .pipe(Effect.tapError(() => lease.release))
      const nextSession = created.session
      const displayName = created.displayName
      const message = MessageID.ascending() // kilocode_change - bind Chief admission to this exact child input
      // kilocode_change start - admit the exact child under the goal lock before any child execution
      if (branch && plan && branches && ctx.callID)
        yield* branches
          .admit({
            goalID: ctx.sessionID,
            goalCreatedAt: plan.goalCreatedAt,
            branchID: branch.id,
            callID: ctx.callID,
            sessionID: nextSession.id,
            messageID: message,
            access: branch.access,
          })
          .pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.gen(function* () {
                    const saved = yield* branches.read(ctx.sessionID)
                    if (!saved?.branches.some((item) => item.sessionID === nextSession.id))
                      yield* sessions.remove(nextSession.id)
                  }).pipe(
                    Effect.catchCause((cause) => Effect.logWarning("Could not remove unadmitted Chief child", cause)),
                    Effect.ensuring(lease.release.pipe(Effect.orDie)),
                  )
                : Effect.void,
            ),
          )
      // kilocode_change start - bind the reserved request branch to this exact child input
      if (requestPlan && branch && ctx.callID && requestLedger)
        yield* requestLedger
          .admit({
            sessionID: ctx.sessionID,
            requestID: requestPlan.identity.requestID,
            revision: requestPlan.identity.revision,
            branchID: branch.id,
            callID: ctx.callID,
            childID: nextSession.id,
            messageID: message,
          })
          .pipe(Effect.tapError(() => lease.release))
      // kilocode_change end
      // kilocode_change end
      // raya_change end
      // kilocode_change end
      // kilocode_change start - persist a task-specific ceiling consumed by SessionPrompt.runLoop
      const base = TaskAuthority.save(
        {
          ...nextSession.metadata,
          ...(parent.metadata?.["raya.goal.open"] === true ? { "raya.goal.open": true } : {}),
        },
        access,
      )
      const bound = computer
        ? TaskAuthority.bind(base, {
            parentSessionID: ctx.sessionID,
            childSessionID: nextSession.id,
            grantID: computer,
          })
        : base
      yield* sessions
        .setMetadata({
          sessionID: nextSession.id,
          metadata: KiloTask.metadata(bound, params.step_cap), // kilocode_change - retain exact Computer Use delegation
        })
        .pipe(Effect.tapError(() => lease.release))
      // kilocode_change end
      // kilocode_change - mirror only the saved child authority in this task receipt
      const authority = TaskAuthority.read((yield* sessions.get(nextSession.id)).metadata) // kilocode_change
      // kilocode_change start - rebuild in-memory ancestry and inherit confinement after creation/resume
      KiloSession.register({ id: nextSession.id, parentID: ctx.sessionID, platform })
      yield* (
        edit && store
          ? store.provide(
              { directory: edit.directory },
              SandboxPolicy.inherit(ctx.sessionID, nextSession.id, fallback, parentDirectory),
            )
          : SandboxPolicy.inherit(ctx.sessionID, nextSession.id, fallback)
      ).pipe(
        Effect.provideService(Config.Service, config),
        Effect.tapError(() => lease.release),
      ) // kilocode_change
      // kilocode_change end

      // kilocode_change start
      // raya_change start - consume the already logged Chief decision exactly once
      if (chief && !branch) {
        const latest = yield* sessions.get(ctx.sessionID).pipe(Effect.tapError(() => lease.release))
        const clean = Object.fromEntries(
          Object.entries(latest.metadata ?? {}).filter(([key]) => key !== RayaChief.pendingKey),
        )
        yield* sessions
          .setMetadata({
            sessionID: ctx.sessionID,
            // kilocode_change start
            metadata: {
              ...clean,
              [RayaChief.phaseKey]: "goal", // raya_change - reserve the next Auto step for goal verification
            },
            // kilocode_change end
          })
          .pipe(Effect.tapError(() => lease.release))
      }
      // raya_change end
      // kilocode_change end
      const metadata: {
        parentSessionId: SessionID
        sessionId: SessionID
        childMessageID?: MessageID // kilocode_change - older results lack verifiable input lineage
        selectedAgent?: string
        displayName?: string // raya_change - durable identity for compact child monitors
        [TaskAuthority.key]?: { version: 1; access: TaskAuthority.Access } // kilocode_change - verified child authority
        selection?: "auto" | "explicit"
        stepCap?: number
        model: typeof model
        provenance?: typeof selected.provenance // kilocode_change - actual selection, not the Chief proposal
        variant?: string
        background?: boolean
        requestID?: string // kilocode_change - bind a planned Chief start to its saved request
        goalCreatedAt?: number // kilocode_change - bind a planned Chief start to its saved goal
        requestRevision?: string // kilocode_change - exact request-plan revision
      } = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        childMessageID: message, // kilocode_change
        selectedAgent: next.name, // raya_change - expose Chief routing to parent and nested UI
        displayName, // raya_change
        ...(authority ? { [TaskAuthority.key]: { version: 1 as const, access: authority } } : {}), // kilocode_change
        selection, // raya_change
        ...(limit === undefined ? {} : { stepCap: limit }), // kilocode_change // raya_change - keep background metadata JSON-safe
        model,
        ...(selected.provenance === undefined ? {} : { provenance: selected.provenance }), // kilocode_change - retain the selection source without serializing undefined
        ...(variant === undefined ? {} : { variant }), // kilocode_change - optional JSON fields must be absent, not undefined
        ...(runInBackground ? { background: true } : {}),
        ...(branch && plan ? { requestID: plan.requestID, goalCreatedAt: plan.goalCreatedAt } : {}), // kilocode_change
        // kilocode_change start - request-bound lineage without a goal
        ...(branch && requestPlan
          ? { requestID: requestPlan.identity.requestID, requestRevision: requestPlan.identity.revision }
          : {}),
        // kilocode_change end
      }

      yield* ctx
        .metadata({
          title: displayName,
          metadata,
        })
        .pipe(Effect.tapError(() => lease.release))

      const runTask = Effect.fn("TaskTool.runTask")(
        function* () {
          const parts = yield* ops.resolvePromptParts(handoff) // raya_change - structured brief, never raw transcript context
          KiloSessionProcessor.markReviewTelemetry(parts, params.command) // kilocode_change - carry review command into child session telemetry
          const result = yield* ops.prompt({
            messageID: message, // kilocode_change - use the exact child input recorded for this invocation
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            variant, // kilocode_change
            agent: next.name,
            tools: {
              question: false, // kilocode_change - subagents cannot prompt the user directly
              interactive_terminal: false, // kilocode_change - subagents cannot take over the user's terminal
              ...(canTodo ? {} : { todowrite: false }),
              ...(canTask ? {} : { task: false }),
              ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
            },
            parts,
          })
          // kilocode_change start - expose terminal child assistant errors through the task tool boundary,
          // including the resumable task_id so the parent agent can continue the subagent (#11620)
          if (result.info.role === "assistant" && result.info.error) {
            return yield* Effect.fail(new Error(`${errorMessage(result.info.error)}\n${resumeHint(nextSession.id)}`))
          }
          // kilocode_change end
          return result.parts.findLast((item) => item.type === "text")?.text ?? ""
        },
        Effect.ensuring(KiloTaskBackgroundProcess.finish(nextSession.id)),
      ) // kilocode_change - transfer inherited processes when the child run ends

      // kilocode_change start - inject completed background task results into the parent session
      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            ...(branch && ctx.agent === "auto" && RayaChief.request(currentParent.metadata)
              ? { goalObjective: RayaChief.request(currentParent.metadata) }
              : {}), // kilocode_change - Chief background notices continue the saved task phase
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${displayName}`
                      : `Background task failed: ${displayName}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })
      // kilocode_change end

      // kilocode_change start - background tasks propagate only cost accrued by this invocation
      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const withCostPropagation = <A, E, R>(task: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          KiloCostPropagation.childCost(sessions, nextSession.id),
          () => task,
          (costBefore) =>
            Effect.gen(function* () {
              const costAfter = yield* KiloCostPropagation.childCost(sessions, nextSession.id)
              yield* KiloCostPropagation.propagate(sessions, ctx.sessionID, ctx.messageID, costAfter - costBefore).pipe(
                Effect.provideService(Database.Service, database),
              )
            }),
        )

      // kilocode_change start - settle the exact planned child on every terminal path
      const work = () =>
        (edit && store ? store.provide({ directory: edit.directory }, runTask()) : runTask()).pipe(
          Effect.onExit((exit) =>
            branch && plan && branches && ctx.callID
              ? ChiefBranchOutcome.record({
                  branches,
                  goalID: ctx.sessionID,
                  goalCreatedAt: plan.goalCreatedAt,
                  branchID: branch.id,
                  callID: ctx.callID,
                  sessionID: nextSession.id,
                  exit,
                })
              : branch && requestPlan && requestLedger && ctx.callID
                ? ChiefBranchOutcome.request({
                    ledger: requestLedger,
                    sessionID: ctx.sessionID,
                    requestID: requestPlan.identity.requestID,
                    revision: requestPlan.identity.revision,
                    branchID: branch.id,
                    callID: ctx.callID,
                    childID: nextSession.id,
                    messageID: message,
                    exit,
                  })
                : Effect.void,
          ),
          Effect.ensuring(lease.release.pipe(Effect.orDie)),
        )
      // kilocode_change end
      const backgroundRun = withCostPropagation(
        work().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id, message))),
      ) // kilocode_change
      // kilocode_change end

      // kilocode_change start - retain the exact parent invocation for every admitted task run
      const origin = ctx.callID
        ? {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            childSessionID: nextSession.id,
            childMessageID: message,
          }
        : undefined
      // kilocode_change end

      if (
        yield* background
          .extend({
            origin, // kilocode_change
            id: nextSession.id,
            // kilocode_change - extended background work also propagates its cost
            run: withCostPropagation(work().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id, message)))), // kilocode_change
          })
          .pipe(Effect.tapError(() => lease.release))
      ) {
        return {
          title: displayName,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const foregroundCost = runInBackground
        ? undefined
        : yield* KiloCostPropagation.childCost(sessions, nextSession.id) // kilocode_change - snapshot before the foreground job starts
      const info = yield* background
        .start({
          origin, // kilocode_change
          id: nextSession.id,
          type: id,
          title: displayName,
          metadata,
          onPromote: Effect.all([
            ctx.metadata({
              title: displayName,
              metadata: { ...metadata, background: true, jobId: nextSession.id },
            }),
            notify(nextSession.id),
          ]),
          // kilocode_change - only the initial-background start needs its own cost bracket; the
          // foreground/promoted path below is already wrapped by the acquireUseRelease at the bottom of run()
          run: runInBackground
            ? backgroundRun
            : work().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id, message))), // kilocode_change
        })
        .pipe(Effect.tapError(() => lease.release))

      function backgroundResult() {
        return {
          title: displayName,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id, message) // kilocode_change

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        // kilocode_change start - snapshot child cost so we propagate only the delta on resume (#6321)
        Effect.gen(function* () {
          ctx.abort.addEventListener("abort", onAbort)
          return foregroundCost ?? (yield* KiloCostPropagation.childCost(sessions, nextSession.id))
        }),
        // kilocode_change end
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: displayName,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        // kilocode_change start - propagate subagent cost delta to parent on every exit path (#6321)
        (costBefore, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all(
                [cancel, info.revision ? background.cancel(nextSession.id, info.revision) : Effect.void],
                { discard: true },
              ) // kilocode_change
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                ctx.abort.removeEventListener("abort", onAbort)
                const costAfter = yield* KiloCostPropagation.childCost(sessions, nextSession.id).pipe(
                  Effect.catchTag("NotFoundError", () => Effect.succeed(costBefore)),
                )
                yield* KiloCostPropagation.propagate(
                  sessions,
                  ctx.sessionID,
                  ctx.messageID,
                  costAfter - costBefore,
                ).pipe(
                  Effect.provideService(Database.Service, database),
                  Effect.catchTag("NotFoundError", () => Effect.void),
                )
              }),
            ),
            Effect.ensuring(lease.release.pipe(Effect.orDie)), // raya_change - release even when a raced registry entry owns the work
          ),
        // kilocode_change end
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.scoped, Effect.orDie), // kilocode_change - close per-execution bridge resources
    }
  }),
)
