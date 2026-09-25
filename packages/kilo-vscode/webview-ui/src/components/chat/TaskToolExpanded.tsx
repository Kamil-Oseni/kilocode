/**
 * TaskToolExpanded component
 * Registers a custom "task" renderer. The parent transcript shows one compact
 * named activity line; details and child tool calls open on request.
 *
 * Call registerExpandedTaskTool() once at app startup to activate.
 */

import { Component, createEffect, createMemo, createSignal, Index, Show, on, onCleanup } from "solid-js"
import { ToolRegistry, ToolProps, getToolInfo } from "@kilocode/kilo-ui/message-part"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import { useLanguage } from "../../context/language"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import { createAutoScroll } from "@kilocode/kilo-ui/hooks"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { useWorktreeMode } from "../../context/worktree-mode"
import { childID } from "../../context/session-utils"
import { openSubagent } from "./open-subagent"
import {
  agentIcon,
  taskAccess,
  taskAccessLabel,
  taskAgent,
  taskModel,
  taskResult,
  taskRunning,
  taskStatus,
  taskVisible,
} from "./task-tool-state" // raya_change
import { chiefReceipt, type ChiefPart } from "./chief-activity"
import { TaskToolBody } from "./TaskToolBody"

const TaskToolRenderer: Component<ToolProps> = (props) => {
  const i18n = useI18n()
  const language = useLanguage()
  const session = useSession()
  const vscode = useVSCode()
  const worktree = useWorktreeMode()

  // raya_change start - Milestone D show the Chief-selected specialist in the nested thread
  const taskMetadata = () => {
    const part = props.partMetadata as { selectedAgent?: string; selection?: string; displayName?: string } | undefined
    const state = props.metadata as { selectedAgent?: string; selection?: string; displayName?: string } | undefined
    return taskAgent(props.input, part, state)
  }
  const selectedAgent = () => taskMetadata().agent
  const access = createMemo(() => taskAccess(props.partMetadata, props.metadata))
  // raya_change end

  const childSessionId = () =>
    childID({
      type: "tool",
      tool: props.tool,
      metadata: props.partMetadata as { sessionId?: string } | undefined,
      state: { metadata: props.metadata as { sessionId?: string } },
    })

  const running = createMemo(() => taskRunning(props.status))
  const [open, setOpen] = createSignal(!!props.forceOpen)
  createEffect(() => {
    if (props.forceOpen) setOpen(true)
  })

  let synced: string | undefined
  createEffect(() => {
    const id = taskVisible(open(), childSessionId())
    if (synced === id) return
    if (synced) session.unsyncSession(synced)
    synced = id
    if (!id) return
    session.syncSession(id)
  })
  onCleanup(() => {
    if (synced) session.unsyncSession(synced)
  })

  const started = createMemo(() => {
    const id = session.currentSessionID()
    if (!id) return
    const parts = session.getSessionToolParts(id) as ChiefPart[]
    const part = parts.find((item) => item.id === props.partID)
    if (!part) return
    return chiefReceipt(part, parts)?.find((event) => event.status === "Started")
  })
  const title = createMemo(
    () => started()?.name ?? taskMetadata().displayName ?? i18n.t("ui.tool.agent", { type: selectedAgent() }),
  ) // raya_change

  const description = createMemo(() => {
    return taskMetadata().description // raya_change - distinguish automatic Chief routing from explicit overrides
  })
  const brief = createMemo(() => (started() || taskMetadata().displayName ? undefined : description()))
  const status = createMemo(() => taskStatus(props.status, props.output) ?? (started() ? "Started" : undefined))

  // All tool parts from the child session — the compact summary list
  const childToolParts = createMemo(() => {
    const id = childSessionId()
    if (!id) return []
    return session.getSessionToolParts(id)
  })

  const childToolCount = createMemo(() => {
    const id = childSessionId()
    return id ? session.getSessionToolCount(id) : 0
  })

  // raya_change - keep running children focused on live tools, then reveal the synthesized final result
  const result = createMemo(() => taskResult(props.output, running() ? childSessionId() : undefined))

  createEffect((prev: string | undefined) => {
    const id = taskVisible(open(), childSessionId())
    if (prev && prev !== id) vscode.postMessage({ type: "streamSessionVisible", sessionID: prev, visible: false })
    if (id && id !== prev) vscode.postMessage({ type: "streamSessionVisible", sessionID: id, visible: true })
    return id
  })

  onCleanup(() => {
    const id = taskVisible(open(), childSessionId())
    if (id) vscode.postMessage({ type: "streamSessionVisible", sessionID: id, visible: false })
  })

  const autoScroll = createAutoScroll({
    working: running,
  })
  let view: HTMLDivElement | undefined
  let body: HTMLDivElement | undefined
  const viewport = (el: HTMLDivElement) => {
    view = el
    autoScroll.scrollRef(running() ? el : undefined)
    if (!running()) el.scrollTop = 0
  }
  const content = (el: HTMLDivElement) => {
    body = el
    autoScroll.contentRef(running() ? el : undefined)
  }

  createEffect(
    on(running, (active) => {
      autoScroll.scrollRef(active ? view : undefined)
      autoScroll.contentRef(active ? body : undefined)
    }),
  )

  const openInTab = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation()
    const id = childSessionId()
    if (!id) return
    openSubagent({
      sessionID: id,
      title: title(),
      parentSessionID: session.currentSessionID(),
      agent: selectedAgent(),
      worktree: !!worktree,
      post: vscode.postMessage,
    })
  }

  return (
    <div class="task-agent-activity" data-status={props.status}>
      <div class="task-agent-activity__line">
        <Icon name={agentIcon(selectedAgent())} size="small" aria-hidden="true" />
        <Show when={childSessionId()} fallback={<span class="task-agent-name">{title()}</span>}>
          <button
            type="button"
            class="task-agent-name"
            onClick={openInTab}
            aria-label={`Open ${title()}'s read-only chat`}
          >
            {title()}
          </button>
        </Show>
        <Show when={status() || brief() || access()}>
          <span class="task-agent-activity__status">
            {status() ?? brief()}
            <Show when={access()}>{(value) => <> · {taskAccessLabel(value())}</>}</Show>
          </span>
        </Show>
        <button
          type="button"
          class="task-agent-activity__expand"
          aria-label={open() ? `Hide ${title()} activity` : `Show ${title()} activity`}
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="chevron-right" size="small" aria-hidden="true" />
        </button>
      </div>
      <Show when={open()}>
        <div ref={viewport} onScroll={autoScroll.handleScroll} data-component="tool-output" data-scrollable>
          <TaskToolBody
            contentRef={content}
            running={running()}
            count={childToolCount()}
            label={language.t(childToolCount() === 1 ? "task.subagent.actions.one" : "task.subagent.actions.many", {
              count: String(childToolCount()),
            })}
            report={result() ? <Markdown text={result()!} /> : undefined}
            starting={
              <div data-slot="task-tool-item" data-state="starting">
                <span data-slot="task-tool-title">{language.t("session.messages.taskStarting")}</span>
              </div>
            }
            actions={
              <Index each={childToolParts()}>
                {(item) => {
                  const info = createMemo(() => getToolInfo(item().tool, item().state?.input))
                  const subtitle = createMemo(() => {
                    if (info().subtitle) return info().subtitle
                    const state = item().state as { status: string; title?: string }
                    if (state.status === "completed" || state.status === "running") return state.title
                    return undefined
                  })
                  return (
                    <div data-slot="task-tool-item" data-status={item().state.status}>
                      <Icon name={info().icon} size="small" />
                      <span data-slot="task-tool-text">
                        <span data-slot="task-tool-title">{info().title}</span>
                        <Show when={subtitle()}>
                          <span data-slot="task-tool-subtitle">{subtitle()}</span>
                        </Show>
                      </span>
                    </div>
                  )
                }}
              </Index>
            }
            model={taskModel(props.partMetadata, props.metadata)}
            modelLabel={language.t("task.subagent.modelDetails")}
          />
        </div>
      </Show>
    </div>
  )
}

/**
 * Override the upstream "task" tool registration with the v1.0.25-style renderer.
 * Must be called once at app startup.
 */
export function registerExpandedTaskTool() {
  ToolRegistry.register({
    name: "task",
    render: TaskToolRenderer,
  })
}
