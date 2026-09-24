/**
 * TaskToolExpanded component
 * Registers a custom "task" tool renderer with a compact scrollable list of
 * child tool calls. Running tasks open immediately; completed tasks load their
 * child details only when expanded.
 *
 * Call registerExpandedTaskTool() once at app startup to activate.
 */

import { Component, createEffect, createMemo, createSignal, Index, Show, on, onCleanup } from "solid-js"
import { ToolRegistry, ToolProps, getToolInfo } from "@kilocode/kilo-ui/message-part"
import { BasicTool, initialOpen } from "@kilocode/kilo-ui/basic-tool"
import { Icon } from "@kilocode/kilo-ui/icon"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import { useLanguage } from "../../context/language"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import { createAutoScroll } from "@kilocode/kilo-ui/hooks"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { useWorktreeMode } from "../../context/worktree-mode"
import { childID } from "../../context/session-utils"
import { openSubagent } from "./open-subagent"
import { agentIcon, taskAccess, taskAgent, taskModel, taskResult, taskRunning, taskVisible } from "./task-tool-state" // raya_change
import { chiefReceipt, type ChiefPart } from "./chief-activity"

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
  // BasicTool's forceOpen effect only fires onOpenChange on a false->true
  // transition — a virtualized remount that starts with forceOpen already
  // true never transitions, so this local signal must also seed itself from
  // forceOpen directly, or the child list/result below stays hidden even
  // though the accordion itself renders open.
  const [open, setOpen] = createSignal(
    initialOpen({
      tool: props.tool,
      partID: props.partID,
      defaultOpen: running(),
      forceOpen: props.forceOpen,
    }),
  )

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

  const openInTab = (e: MouseEvent) => {
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

  const trigger = () => (
    <div data-slot="basic-tool-tool-info-structured">
      <Icon name={agentIcon(selectedAgent())} size="small" data-slot="task-agent-role-icon" />
      <div data-slot="basic-tool-tool-info-main">
        <span data-slot="basic-tool-tool-title" class="capitalize">
          {title()}
        </span>
        <Show when={started() || description() || access() || childToolCount() > 0}>
          <span data-slot="basic-tool-tool-subtitle">
            {started() ? "Started" : description()}
            <Show when={access()}>
              {(value) => (
                <>
                  {started() || description() ? " · " : ""}
                  {value() === "read" ? "Read only" : "Can edit"}
                </>
              )}
            </Show>
            <Show when={childToolCount() > 0}>
              {started() || description() || access() ? " · " : ""}
              {language.t(childToolCount() === 1 ? "task.subagent.steps.one" : "task.subagent.steps.many", {
                count: String(childToolCount()),
              })}
            </Show>
          </span>
        </Show>
      </div>
      <Show when={childSessionId()}>
        <IconButton
          icon="square-arrow-top-right"
          size="small"
          variant="ghost"
          aria-label={worktree ? "Open sub-agent in panel" : "Open sub-agent in tab"}
          onClick={openInTab}
        />
      </Show>
    </div>
  )

  return (
    <div data-component="tool-part-wrapper">
      <BasicTool
        icon="task"
        status={props.status}
        tool={props.tool}
        partID={props.partID}
        trigger={trigger()}
        defaultOpen={running()}
        forceOpen={props.forceOpen}
        defer
        onOpenChange={setOpen}
      >
        <div ref={viewport} onScroll={autoScroll.handleScroll} data-component="tool-output" data-scrollable>
          <div ref={content} data-component="task-tools">
            <details data-slot="task-model-details">
              <summary>{language.t("task.subagent.modelDetails")}</summary>
              <div data-slot="task-model-selection">{taskModel(props.partMetadata, props.metadata)}</div>
            </details>
            <Show when={running() && childToolCount() === 0}>
              <div data-slot="task-tool-item" data-state="starting">
                <span data-slot="task-tool-title">{language.t("session.messages.taskStarting")}</span>
              </div>
            </Show>
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
            <Show when={result()}>
              {(text) => (
                <div data-slot="task-result" data-after-activity={childToolCount() > 0 ? "" : undefined}>
                  <Markdown text={text()} />
                </div>
              )}
            </Show>
          </div>
        </div>
      </BasicTool>
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
