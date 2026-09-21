/**
 * VS Code-specific tool registry overrides.
 * Wraps upstream tool renderers to inject VS Code sidebar preferences
 * (e.g. expanded by default) without duplicating render logic.
 *
 * Call registerVscodeToolOverrides() once at app startup, after the
 * upstream tool registrations have run (i.e. after importing message-part).
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BasicTool, GenericTool } from "@kilocode/kilo-ui/basic-tool"
import { Button } from "@kilocode/kilo-ui/button"
import { ToolRegistry, type ToolProps } from "@kilocode/kilo-ui/message-part"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { editReview } from "./edit-review"
import { EditReviewChrome } from "./EditReviewChrome"
import { note, targets, type Kind } from "./review-files"
import { routineAction, routineTarget, routineTitle } from "./routine-result"
import {
  TodoProposalCard,
  type TodoProposal,
  type TodoProposalIssue,
  type TodoProposalLink,
  type TodoProposalState,
  type TodoProposalSubtask,
} from "../todo/TodoProposalCard"

/** Tools that should be open by default in the VS Code sidebar. */
const DEFAULT_OPEN_TOOLS = ["bash"]
/** File-mutating tools that get the inline review chrome (Undo/Keep + navigator). */
const REVIEW_TOOLS = ["edit", "write", "apply_patch", "multiedit"]
const ROUTINE_TOOLS = ["schedule_task", "create_organization", "update_routine", "update_organization"]
const PROPOSAL = /^proposal_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUBTODO = /^subtodo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TODO = /^todo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[a-f0-9]{64}$/
const ESTIMATE = 525_600
const PRIORITY = new Set(["low", "medium", "high", "urgent"])
const SUBTASK_STATUS = new Set(["open", "completed"])
const registered = new Set<string>()

const TITLE: Record<string, string> = {
  start: "Start background process",
  list: "List background processes",
  status: "Check background process",
  logs: "View background logs",
  stop: "Stop background process",
  restart: "Restart background process",
}
const STRUCTURED_ACTIONS = new Set(["start", "status", "stop", "restart"])
const STRUCTURED_KEYS = new Set(["id", "status", "pid", "cwd", "command", "last_output"])
const LABEL: Record<string, string> = {
  command: "Command",
  id: "Process id",
  last_output: "Last output",
  pid: "PID",
  status: "Status",
  cwd: "Cwd",
}

function text(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function action(input: Record<string, unknown>) {
  const value = text(input.action)
  if (!value) return "status"
  return value
}

function ready(input: Record<string, unknown>) {
  const value = input.ready
  if (!value || typeof value !== "object") return []
  const data = value as Record<string, unknown>
  return [text(data.port) ? ["Ports", text(data.port)!] : undefined].filter((item): item is [string, string] => !!item)
}

function structured(raw: string | undefined, enabled: boolean) {
  if (!enabled) return { rows: [], output: output(raw) }

  const lines = raw?.trimEnd().split("\n") ?? []
  const rows = lines.flatMap((line): [string, string][] => {
    const match = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!match || !STRUCTURED_KEYS.has(match[1])) return []
    const text = match[2].trim()
    if (!text) return []
    return [[match[1], text]]
  })
  const rest = lines.filter((line) => {
    const match = line.match(/^([a-z_]+):\s*(.*)$/)
    return !match || !STRUCTURED_KEYS.has(match[1])
  })

  return {
    rows: rows.map((row): [string, string] => [LABEL[row[0]] ?? row[0], row[1]]),
    output: output(rest.join("\n")),
  }
}

function find(rows: [string, string][], label: string) {
  return rows.find((row) => row[0] === label)?.[1]
}

function output(text?: string) {
  const value = text?.trimEnd()
  if (!value?.trim()) return undefined
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optional(value: unknown, check: (item: unknown) => boolean) {
  return value === undefined || value === null || check(value)
}

function link(value: unknown): value is TodoProposalLink {
  if (!record(value)) return false
  if (value.kind !== "chat" && value.kind !== "routine" && value.kind !== "goal" && value.kind !== "session")
    return false
  return typeof value.id === "string" && value.id.trim().length > 0 && value.id.length <= 500
}

function links(value: unknown) {
  if (!Array.isArray(value) || value.length > 50 || !value.every(link)) return false
  return new Set(value.map((item) => `${item.kind}:${item.id}`)).size === value.length
}

function subtask(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (value.kind !== "new" && value.kind !== "existing") return false
  if (typeof value.id !== "string" || !SUBTODO.test(value.id)) return false
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 500) return false
  if (value.kind === "existing" && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)) return false
  if (value.status !== undefined && (typeof value.status !== "string" || !SUBTASK_STATUS.has(value.status)))
    return false
  if (!optional(value.notes, (item) => typeof item === "string" && item.length <= 10_000)) return false
  if (!optional(value.priority, (item) => typeof item === "string" && PRIORITY.has(item))) return false
  if (
    !optional(
      value.estimateMinutes,
      (item) => Number.isSafeInteger(item) && Number(item) > 0 && Number(item) <= ESTIMATE,
    )
  )
    return false
  if (!optional(value.dueAt, (item) => typeof item === "number" && Number.isFinite(item))) return false
  if (!optional(value.links, links)) return false
  return true
}

function flatten(value: Record<string, unknown>): TodoProposalSubtask {
  return {
    id: String(value.id),
    title: String(value.title).trim(),
    ...(value.status === undefined ? {} : { status: value.status as TodoProposalSubtask["status"] }),
    ...(value.notes === undefined ? {} : { notes: value.notes as string | null }),
    ...(value.priority === undefined ? {} : { priority: value.priority as TodoProposalSubtask["priority"] }),
    ...(value.estimateMinutes === undefined ? {} : { estimateMinutes: value.estimateMinutes as number | null }),
    ...(value.dueAt === undefined ? {} : { dueAt: value.dueAt as number | null }),
    ...(value.links === undefined ? {} : { links: value.links as TodoProposalSubtask["links"] }),
  }
}

function source(value: unknown) {
  if (!record(value)) return false
  return ["sessionID", "messageID", "callID"].every((key) => {
    const item = value[key]
    return typeof item === "string" && item.length > 0 && item.length <= 256
  })
}

function target(value: unknown) {
  if (!record(value) || typeof value.todoID !== "string" || !TODO.test(value.todoID)) return false
  if (value.kind === "new") return value.baseRevision === 0
  if (value.kind !== "existing") return false
  return Number.isSafeInteger(value.baseRevision) && Number(value.baseRevision) >= 1
}

function validChanges(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.length > 500))
    return false
  if (!optional(value.detail, (item) => typeof item === "string" && item.length <= 10_000)) return false
  if (!optional(value.priority, (item) => typeof item === "string" && PRIORITY.has(item))) return false
  if (
    !optional(
      value.estimateMinutes,
      (item) => Number.isSafeInteger(item) && Number(item) > 0 && Number(item) <= ESTIMATE,
    )
  )
    return false
  if (!optional(value.dueAt, (item) => typeof item === "number" && Number.isFinite(item))) return false
  if (!optional(value.reminderAt, (item) => typeof item === "number" && Number.isFinite(item))) return false
  if (!optional(value.links, links)) return false
  if (
    value.subtasks !== undefined &&
    (!Array.isArray(value.subtasks) || value.subtasks.length > 100 || !value.subtasks.every(subtask))
  )
    return false
  return true
}

function changes(id: string, value: unknown): TodoProposal | undefined {
  if (!validChanges(value)) return
  const tasks = Array.isArray(value.subtasks) ? value.subtasks : undefined
  return {
    id,
    title: typeof value.title === "string" ? value.title.trim() : "Update this Todo",
    ...(value.detail === undefined ? {} : { detail: typeof value.detail === "string" ? value.detail : null }),
    ...(value.priority === undefined ? {} : { priority: value.priority as TodoProposal["priority"] }),
    ...(value.estimateMinutes === undefined ? {} : { estimateMinutes: value.estimateMinutes as number | null }),
    ...(value.dueAt === undefined ? {} : { dueAt: value.dueAt as number | null }),
    ...(value.reminderAt === undefined ? {} : { reminderAt: value.reminderAt as number | null }),
    ...(value.links === undefined ? {} : { links: value.links as TodoProposal["links"] }),
    ...(tasks ? { subtasks: tasks.map(flatten) } : {}),
  }
}

function identity(props: ToolProps) {
  if (props.tool !== "personal_todo" || props.status !== "completed") return
  if (props.input.action !== "propose") return
  if (
    props.metadata.view !== "personal-todo-proposal" ||
    props.metadata.action !== "propose" ||
    props.metadata.status !== "complete"
  )
    return
  const proposalID = props.metadata.proposalID
  const digest = props.metadata.digest
  if (typeof proposalID !== "string" || !PROPOSAL.test(proposalID)) return
  if (typeof digest !== "string" || !DIGEST.test(digest)) return
  return { proposalID, digest }
}

function json(value: string | undefined) {
  if (!value) return
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return undefined
  }
}

function todoProposal(props: ToolProps) {
  const expected = identity(props)
  if (!expected) return
  const proposalID = expected.proposalID
  const digest = expected.digest
  const parsed = json(props.output)
  if (!record(parsed) || parsed.status !== "complete" || !record(parsed.proposal)) return
  const raw = parsed.proposal
  if (raw.version !== 1 || raw.id !== proposalID || raw.digest !== digest) return
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return
  if (!source(raw.source) || !target(raw.target)) return
  const proposal = changes(proposalID, raw.changes)
  if (!proposal) return
  return { proposal, digest }
}

function lifecycle(value: unknown, id: string, digest: string) {
  if (!record(value) || !["open", "pending", "applied", "rejected"].includes(String(value.state))) return
  if (!record(value.proposal)) return
  const raw = value.proposal
  if (raw.version !== 1 || raw.id !== id || raw.digest !== digest) return
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return
  if (!source(raw.source) || !target(raw.target)) return
  const proposal = changes(id, raw.changes)
  if (!proposal) return
  return { proposal, state: value.state as TodoProposalState }
}

function failure(kind: string, message: string): TodoProposalIssue | undefined {
  if (kind === "stale") return { kind, message }
  if (kind === "conflict") return { kind, message }
  if (kind === "offline") return { kind, message }
  if (kind === "error") return { kind, message }
  return undefined
}

function proposalTool(upstream?: Component<ToolProps>): Component<ToolProps> {
  return (props) => {
    const vscode = useVSCode()
    const value = createMemo(() => todoProposal(props))
    const [proposal, setProposal] = createSignal<TodoProposal>()
    const [state, setState] = createSignal<TodoProposalState>("open")
    const [busy, setBusy] = createSignal<"apply" | "reject">()
    const [issue, setIssue] = createSignal<TodoProposalIssue>()
    const [retry, setRetry] = createSignal<"apply" | "reject">()
    const [pending, setPending] = createSignal<{ id: string; action: "apply" | "reject" }>()

    createEffect(() => {
      const current = value()
      if (!current || proposal()) return
      setProposal(current.proposal)
    })

    const mutate = (action: "apply" | "reject") => {
      const current = value()
      if (!current || busy()) return
      const id = crypto.randomUUID()
      setBusy(action)
      setIssue(undefined)
      setRetry(undefined)
      setPending({ id, action })
      vscode.postMessage({
        type: action === "apply" ? "personalTodoProposalApply" : "personalTodoProposalReject",
        requestID: id,
        proposalID: current.proposal.id,
        digest: current.digest,
      })
    }

    // One correlated response state machine keeps acknowledgement-loss handling explicit.
    // eslint-disable-next-line complexity
    const off = vscode.onMessage((message) => {
      const request = pending()
      const current = value()
      if (!request || !current || message.type !== "personalTodoProposalResult") return
      if (
        message.requestID !== request.id ||
        message.proposalID !== current.proposal.id ||
        message.operation !== request.action
      )
        return
      setPending(undefined)
      setBusy(undefined)
      const item = "item" in message ? lifecycle(message.item, current.proposal.id, current.digest) : undefined
      if (message.kind === "applied" || message.kind === "rejected") {
        if (!item || item.state !== message.kind) {
          setIssue({ kind: "error", message: "Raya returned an invalid Todo proposal result." })
          return
        }
        setProposal(item.proposal)
        setState(item.state)
        setIssue(undefined)
        setRetry(undefined)
        return
      }
      if (item) {
        setProposal(item.proposal)
        setState(item.state)
      }
      if (message.kind === "uncertain") {
        setIssue({ kind: "uncertain", message: message.message })
        setRetry(item && (item.state === "open" || item.state === "pending") ? request.action : undefined)
        return
      }
      if ("message" in message) {
        const issue = failure(message.kind, message.message)
        if (issue) {
          setIssue(issue)
          if (message.kind === "offline") setRetry(request.action)
          return
        }
      }
      if (message.kind === "loaded" || message.kind === "listed") {
        setIssue({ kind: "error", message: "Raya returned an unrelated Todo proposal result." })
        return
      }
      setIssue({ kind: "error", message: "Raya returned an unexpected Todo proposal result." })
    })
    onCleanup(off)

    const edit = () => {
      const current = value()
      if (!current) return
      window.dispatchEvent(
        new CustomEvent("raya:open-todo-proposal", {
          detail: { id: current.proposal.id, digest: current.digest },
        }),
      )
    }
    const again = () => {
      const action = retry()
      if (action) mutate(action)
    }

    return (
      <Show
        when={value()}
        fallback={
          upstream ? (
            <Dynamic component={upstream} {...props} />
          ) : (
            <GenericTool tool={props.tool} status={props.status} input={props.input} hideDetails={props.hideDetails} />
          )
        }
      >
        {(current) => (
          <TodoProposalCard
            proposal={proposal() ?? current().proposal}
            state={state()}
            busy={busy()}
            issue={issue()}
            decisionDisabled={issue() !== undefined}
            onApply={() => mutate("apply")}
            onEdit={edit}
            onReject={() => mutate("reject")}
            onRetry={retry() ? again : undefined}
          />
        )}
      </Show>
    )
  }
}

function expanded(status?: string, open?: boolean) {
  if (open !== undefined) return open
  return status === "pending" || status === "running" || status === "completed"
}

function RoutineResultTool(props: ToolProps) {
  const target = createMemo(() => routineTarget(props.status, props.metadata))
  return (
    <BasicTool
      {...props}
      icon="task"
      trigger={{ title: routineTitle(props.tool), subtitle: text(props.metadata.requestStatus), args: [] }}
      defaultOpen={props.defaultOpen ?? true}
    >
      <Show when={output(props.output)}>
        {(value) => (
          <div data-component="tool-output" data-variant="preview">
            <p>{value()}</p>
          </div>
        )}
      </Show>
      <Show when={target()}>
        {(value) => (
          <Button
            variant="secondary"
            size="small"
            onClick={() => window.dispatchEvent(new CustomEvent("raya:open-routines", { detail: value() }))}
          >
            {routineAction(props.tool)}
          </Button>
        )}
      </Show>
    </BasicTool>
  )
}

function BackgroundProcessTool(props: ToolProps) {
  const act = createMemo(() => action(props.input))
  const title = createMemo(() => TITLE[act()] ?? "Background process")
  const data = createMemo(() => structured(props.output, props.status === "completed" && STRUCTURED_ACTIONS.has(act())))
  const id = createMemo(() => find(data().rows, "Process id") ?? text(props.metadata.processID) ?? text(props.input.id))
  const status = createMemo(() => find(data().rows, "Status") ?? text(props.metadata.status))
  const command = createMemo(() => find(data().rows, "Command") ?? text(props.input.command))
  const cwd = createMemo(() => find(data().rows, "Cwd") ?? text(props.input.cwd))
  const rows = createMemo(() =>
    [
      command() ? ["Command", command()!] : undefined,
      text(props.input.description) ? ["Description", text(props.input.description)!] : undefined,
      id() ? ["Process id", id()!] : undefined,
      status() ? ["Status", status()!] : undefined,
      cwd() ? ["Cwd", cwd()!] : undefined,
      !cwd() && text(props.input.workdir) ? ["Workdir", text(props.input.workdir)!] : undefined,
      ...ready(props.input),
      ...data().rows.filter((row) => !["Command", "Process id", "Status", "Cwd"].includes(row[0])),
    ].filter((item): item is [string, string] => !!item),
  )

  return (
    <BasicTool
      {...props}
      icon="terminal"
      trigger={{
        title: title(),
        subtitle: command() ?? text(props.input.description) ?? id(),
        args: [],
      }}
      defaultOpen={expanded(props.status, props.defaultOpen)}
      allowPendingToggle
    >
      <Show when={rows().length > 0 || data().output}>
        <div data-component="background-process-details">
          <Show when={rows().length > 0}>
            <div data-component="background-process-fields">
              <For each={rows()}>
                {(row) => (
                  <div data-slot="background-process-field">
                    <span data-slot="background-process-label">{row[0]}</span>
                    <span data-slot="background-process-value">{row[1]}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={data().output}>
            {(value) => (
              <div data-component="tool-output" data-variant="preview" data-scrollable>
                <pre data-slot="background-process-output">{value()}</pre>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </BasicTool>
  )
}

function MultiEditTool(props: ToolProps) {
  const files = createMemo(() => targets("multiedit", props.input, props.metadata))
  const subtitle = createMemo(() => {
    const count = files().length
    return count ? `${count} ${count === 1 ? "file" : "files"}` : undefined
  })

  return (
    <BasicTool
      {...props}
      icon="edit"
      trigger={{ title: "Edit files", subtitle: subtitle(), args: [] }}
      defaultOpen={expanded(props.status, props.defaultOpen)}
      allowPendingToggle
    >
      <Show when={output(props.output)}>
        {(value) => (
          <div
            data-component="tool-output"
            data-variant="preview"
            data-scrollable
            tabIndex={0}
            aria-label="Multi-edit result"
          >
            <pre data-slot="multiedit-output">{value()}</pre>
          </div>
        )}
      </Show>
    </BasicTool>
  )
}

// raya_change - wrap file-mutating renderers with inline review chrome: a hued
// block plus rounded Undo/Keep pills and an "N of M" navigator to step between
// unaccepted edits, matching the Cursor-style review affordance the user asked
// for. apply_patch and multiedit keep every file, including deletions and
// renames, so those changes stay reviewable when no editor tab is open. Both
// file-wide actions use the chat coordinator's acknowledged backend request. The
// chrome only appears once the edit has completed.
function FileReview(props: { file: string; kind: Kind; status: string; path?: boolean; children?: JSX.Element }) {
  const session = useSession()
  const vscode = useVSCode()
  let ref: HTMLDivElement | undefined

  const sid = () => session.currentSessionID() ?? ""
  const show = () => props.status === "completed" && !!props.file && !!sid() && !editReview.isKept(sid(), props.file)
  const nav = () => {
    const list = editReview.pending(sid())
    return { index: list.indexOf(props.file), total: list.length }
  }

  createEffect(() => {
    if (!ref || !props.file || !sid()) return
    const dispose = editReview.register({ session: sid(), file: props.file, el: ref })
    onCleanup(dispose)
  })

  const undo = () => {
    if (!sid() || !props.file) return
    editReview.request(sid(), props.file, "undo")
  }
  const keep = () => editReview.request(sid(), props.file, "keep")
  const open = () => {
    if (!props.file) return
    vscode.postMessage({ type: "openFile", filePath: props.file, sessionID: sid() || undefined })
  }
  const step = (delta: number) => {
    const list = editReview.pending(sid())
    if (list.length === 0) return
    const at = list.indexOf(props.file)
    const next = list[(at + delta + list.length) % list.length]
    if (next) editReview.focus(sid(), next)
  }

  return (
    <EditReviewChrome
      setRef={(el) => {
        ref = el
      }}
      status={props.kind}
      note={note(props.kind)}
      pending={show()}
      busy={editReview.busy(sid())}
      nav={nav()}
      onUndo={undo}
      onKeep={keep}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    >
      <Show when={props.path || props.kind === "deleted" || props.kind === "renamed"}>
        <Button
          variant="ghost"
          size="small"
          data-slot="edit-review-file"
          aria-label={`Open ${props.file} in the editor`}
          onClick={open}
        >
          {props.file}
        </Button>
      </Show>
      {props.children}
    </EditReviewChrome>
  )
}

function reviewed(name: string, upstream: Component<ToolProps>): Component<ToolProps> {
  return (props) => {
    const items = () => targets(name, props.input, props.metadata)
    const first = () => items()[0]
    return (
      <Show when={items().length > 0} fallback={<Dynamic component={upstream} {...props} />}>
        <Show
          when={items().length === 1 && first()}
          fallback={
            <>
              <Dynamic component={upstream} {...props} />
              <Show when={props.status === "completed"}>
                <div data-component="edit-review-files" role="list" aria-label="Files to review">
                  <For each={items()}>
                    {(item) => (
                      <div role="listitem">
                        <FileReview file={item.file} kind={item.kind} status={props.status ?? ""} path />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          }
        >
          {(item) => (
            <FileReview file={item().file} kind={item().kind} status={props.status ?? ""}>
              <Dynamic component={upstream} {...props} />
            </FileReview>
          )}
        </Show>
      </Show>
    )
  }
}

export function registerVscodeToolOverrides() {
  if (!ToolRegistry.render("multiedit")) ToolRegistry.register({ name: "multiedit", render: MultiEditTool })

  for (const name of REVIEW_TOOLS) {
    if (registered.has(name)) continue
    const upstream = ToolRegistry.render(name)
    if (!upstream) continue
    ToolRegistry.register({ name, render: reviewed(name, upstream) })
    registered.add(name)
  }

  if (!registered.has("background_process")) {
    ToolRegistry.register({
      name: "background_process",
      render: BackgroundProcessTool,
    })
    registered.add("background_process")
  }

  if (!registered.has("personal_todo")) {
    ToolRegistry.register({ name: "personal_todo", render: proposalTool(ToolRegistry.render("personal_todo")) })
    registered.add("personal_todo")
  }

  for (const name of ROUTINE_TOOLS) {
    if (registered.has(name)) continue
    ToolRegistry.register({ name, render: RoutineResultTool })
    registered.add(name)
  }

  for (const name of DEFAULT_OPEN_TOOLS) {
    if (registered.has(name)) continue
    const upstream = ToolRegistry.render(name)
    if (!upstream) continue

    ToolRegistry.register({
      name,
      render: (props) => <Dynamic component={upstream} {...props} defaultOpen={props.defaultOpen ?? true} />,
    })
    registered.add(name)
  }
}
