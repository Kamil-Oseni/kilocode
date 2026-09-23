/**
 * Background agent strip for the task header.
 *
 * Sits in the same slot as the to-do strip: one line while collapsed, hidden
 * entirely when no background agent runs. It is the stable place to find async
 * sub-agents once the task card has scrolled out of view.
 *
 * Rows open the sub-agent through `openSubagent`, the same path the task card
 * uses, so Agent Manager keeps showing them in its right-hand inspector and the
 * sidebar keeps opening an editor tab.
 */

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount, createEffect, on } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { getToolInfo } from "@kilocode/kilo-ui/message-part"
import type { BackgroundJobInfo } from "../../types/messages"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { costLabel } from "../../context/accounting"
import { useVSCode } from "../../context/vscode"
import { useWorktreeMode } from "../../context/worktree-mode"
import {
  backgroundAgents,
  backgroundAgentActivity,
  backgroundAgentDuration,
  backgroundAgentElapsed,
  backgroundAgentIdentity,
  backgroundAgentUsage,
  backgroundJobAgents,
  foregroundAgent,
  showBackgroundAgent,
  type BackgroundAgent,
} from "./background-agents"
import { openSubagent } from "./open-subagent"
import { loadAgentView, saveAgentView } from "./background-agent-state"
import { agentIcon } from "./task-tool-state"

export const BackgroundAgents: Component<{ readonly?: boolean }> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const vscode = useVSCode()
  const worktree = useWorktreeMode()
  const [open, setOpen] = createSignal(false)
  const [jobs, setJobs] = createSignal<BackgroundJobInfo[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [hidden, setHidden] = createSignal<Set<string>>(new Set())
  const [mounted, setMounted] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  let pending: string | undefined
  let revision = 0

  createEffect(
    on(session.currentSessionID, () => {
      const id = session.currentSessionID()
      const saved = id ? loadAgentView(vscode.getState(), id) : { open: false, hidden: [] }
      setOpen(saved.open)
      setHidden(new Set(saved.hidden))
      setLoaded(false)
      setJobs([])
      pending = undefined
      if (mounted()) requestJobs()
    }),
  )

  const requestJobs = () => {
    const id = session.currentSessionID()
    if (!id || pending) return
    pending = `${id}:${++revision}`
    vscode.postMessage({ type: "requestBackgroundJobs", sessionID: id, requestID: pending })
  }

  onMount(() => {
    setMounted(true)
    const unsub = vscode.onMessage((message) => {
      if (message.type !== "backgroundJobsLoaded") return
      if (message.sessionID !== session.currentSessionID()) return
      if (message.requestID !== pending) return
      pending = undefined
      if (message.error) {
        setJobs([])
        setLoaded(false)
        return
      }
      setJobs(message.jobs)
      setLoaded(true)
    })
    requestJobs()
    const timer = setInterval(requestJobs, 5_000)
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => {
      setMounted(false)
      unsub()
      clearInterval(timer)
      clearInterval(clock)
    })
  })

  const fallback = createMemo(() => {
    const id = session.currentSessionID()
    if (!id) return []
    return backgroundAgents(session.getSessionToolParts(id), session.allStatusMap())
  })

  const agents = createMemo(() => {
    const id = session.currentSessionID()
    if (!id) return []
    if (loaded()) return backgroundJobAgents(jobs(), id, session.scopedPermissions(id), session.scopedQuestions(id))
    return fallback()
  })

  const visible = createMemo(() => agents().filter((agent) => showBackgroundAgent(agent, hidden())))
  const foreground = createMemo(() => {
    const id = session.currentSessionID()
    return id ? foregroundAgent(session.getSessionToolParts(id), session.allStatusMap()) : undefined
  })

  const identity = (agent: BackgroundAgent) =>
    backgroundAgentIdentity(agent, language.t("task.backgroundAgents.untitled"))

  const label = (agent: BackgroundAgent) => identity(agent).name

  const status = (agent: BackgroundAgent) => language.t(`task.backgroundAgents.status.${agent.status}`)

  const summary = createMemo(() => {
    const running = visible().filter((agent) => agent.status === "running").length
    const total = visible().length
    if (total === 0 && foreground()) return language.t("task.backgroundAgents.foreground")
    if (total === 1) return `${label(visible()[0]!)} · ${status(visible()[0]!)}`
    if (running === total) return language.t("task.backgroundAgents.running.many", { count: String(total) })
    return language.t("task.backgroundAgents.summary", { running: String(running), total: String(total) })
  })

  const waiting = createMemo(() => visible().filter((agent) => agent.permission || agent.question).length)

  const save = (id: string, next: { open: boolean; hidden: Set<string> }) =>
    vscode.setState(saveAgentView(vscode.getState(), id, { open: next.open, hidden: [...next.hidden] }))

  const toggle = () => {
    const id = session.currentSessionID()
    if (!id) return
    const next = !open()
    setOpen(next)
    save(id, { open: next, hidden: hidden() })
  }

  const icon = (agent: BackgroundAgent) => {
    if (agent.status === "completed") return "circle-check" as const
    if (agent.status === "cancelled") return "circle-ban-sign" as const
    if (agent.status === "error") return "warning" as const
    return undefined
  }

  const openAgent = (agent: BackgroundAgent) =>
    openSubagent({
      sessionID: agent.id,
      title: label(agent),
      parentSessionID: session.currentSessionID(),
      agent: agent.agent,
      worktree: !!worktree,
      post: vscode.postMessage,
    })

  const cancelAgent = (event: MouseEvent, agent: BackgroundAgent) => {
    event.stopPropagation()
    if (agent.status !== "running") return
    const id = session.currentSessionID()
    if (!id) return
    pending = `${id}:${++revision}`
    vscode.postMessage({ type: "cancelBackgroundJob", jobID: agent.jobID, sessionID: id, requestID: pending })
  }

  const background = () => {
    const id = session.currentSessionID()
    if (id) vscode.postMessage({ type: "backgroundSubagents", sessionID: id })
  }

  const hideFinished = () => {
    const id = session.currentSessionID()
    if (!id) return
    const next = new Set(
      agents()
        .filter((agent) => agent.status !== "running")
        .map((agent) => agent.jobID),
    )
    setHidden(next)
    save(id, { open: open(), hidden: next })
  }

  return (
    <Show when={visible().length > 0 || (!props.readonly && foreground())}>
      <div data-component="task-header-agents">
        <div data-slot="task-header-agents-toolbar">
          <Show when={visible().length > 0}>
            <button
              data-slot="task-header-todos-trigger"
              onClick={toggle}
              aria-expanded={open()}
              aria-label={waiting() > 0 ? language.t("task.backgroundAgents.waiting") : undefined}
            >
              <Show
                when={waiting() > 0}
                fallback={
                  <Icon name={visible().length === 1 ? agentIcon(visible()[0]?.agent) : "subagent"} size="small" />
                }
              >
                <Icon name="warning" size="small" />
              </Show>
              <span data-slot="task-header-todos-summary">
                <Show when={waiting() > 0} fallback={summary()}>
                  {language.t("task.backgroundAgents.waiting")}
                </Show>
              </span>
              <Icon
                name="chevron-down"
                size="small"
                data-slot="task-header-todos-arrow"
                data-open={open() ? "" : undefined}
              />
            </button>
          </Show>
          <Show when={!props.readonly && foreground()}>
            <Button
              variant="ghost"
              size="small"
              aria-label={language.t("task.backgroundAgents.continueInBackground")}
              onClick={background}
            >
              {language.t("task.backgroundAgents.continueInBackground")}
            </Button>
          </Show>
          <Show when={!props.readonly && visible().some((agent) => agent.status !== "running")}>
            <Button
              icon="close-small"
              variant="ghost"
              size="small"
              aria-label={language.t("task.backgroundAgents.clearFinished")}
              onClick={hideFinished}
            >
              <span data-slot="task-header-agent-action-label">
                {language.t("task.backgroundAgents.clearFinished")}
              </span>
            </Button>
          </Show>
        </div>
        <Show when={open()}>
          <div data-slot="task-header-todos-list">
            <Show when={visible().some((agent) => agent.permission || agent.question)}>
              <div data-slot="task-header-agent-attention">
                <Icon name="warning" size="small" />
                <span>{language.t("task.backgroundAgents.waiting")}</span>
              </div>
            </Show>
            <For each={visible()}>
              {(agent) => {
                const activity = createMemo(() => backgroundAgentActivity(session.getSessionToolParts(agent.id)))
                const detail = createMemo(() => {
                  if (agent.error) return agent.error
                  const part = activity()
                  if (!part) return undefined
                  const info = getToolInfo(part.tool, part.state.input)
                  return info.subtitle ? `${info.title}: ${info.subtitle}` : info.title
                })
                const elapsed = createMemo(() => backgroundAgentElapsed(agent, now()))
                const usage = createMemo(() => backgroundAgentUsage(session.modelUsage()?.sessionUsage, agent.id))
                const cost = createMemo(() => {
                  const item = usage()
                  if (!item) return undefined
                  return {
                    brief: costLabel(item, language.locale(), true),
                    detail: costLabel(item, language.locale()),
                  }
                })
                const started = () =>
                  agent.startedAt > 0 && Number.isFinite(agent.startedAt)
                    ? new Date(agent.startedAt).toLocaleString(language.locale())
                    : undefined
                return (
                  <div data-slot="task-header-agent" data-status={agent.status}>
                    <Show when={icon(agent)} fallback={<Spinner />}>
                      {(name) => <Icon name={name()} size="small" data-slot="task-header-agent-status" />}
                    </Show>
                    <button
                      data-slot="task-header-agent-main"
                      title={`${language.t("task.backgroundAgents.open")}: ${label(agent)}`}
                      aria-label={`${language.t("task.backgroundAgents.open")}: ${label(agent)}, ${status(agent)}`}
                      onClick={() => openAgent(agent)}
                    >
                      <span data-slot="task-header-agent-primary">
                        <Icon name={agentIcon(agent.agent)} size="small" data-slot="task-header-agent-role-icon" />
                        <span data-slot="task-header-agent-label" dir="auto">
                          {label(agent)}
                        </span>
                        <span data-slot="task-header-agent-status-label">{status(agent)}</span>
                      </span>
                      <span data-slot="task-header-agent-secondary">
                        <Show when={identity(agent).task}>
                          {(task) => (
                            <span data-slot="task-header-agent-activity" dir="auto">
                              {task()}
                            </span>
                          )}
                        </Show>
                        <Show when={agent.status === "running" && detail()}>
                          {(value) => (
                            <span data-slot="task-header-agent-detail" dir="auto">
                              {value()}
                            </span>
                          )}
                        </Show>
                        <Show when={agent.status === "completed"}>
                          <span data-slot="task-header-agent-report">
                            {language.t("task.backgroundAgents.viewReport")}
                          </span>
                        </Show>
                        <Show when={agent.status === "error" && detail()}>
                          {(value) => (
                            <span data-slot="task-header-agent-detail" dir="auto">
                              {value()}
                            </span>
                          )}
                        </Show>
                        <Show when={elapsed() !== undefined}>
                          <span data-slot="task-header-agent-elapsed" title={started()}>
                            {backgroundAgentDuration(elapsed()!)}
                          </span>
                        </Show>
                        <Show when={cost()}>
                          {(value) => (
                            <span
                              data-slot="task-header-agent-cost"
                              title={`${value().detail}. Recorded model usage for this agent.`}
                            >
                              {value().brief}
                            </span>
                          )}
                        </Show>
                        <Show when={agent.permission || agent.question}>
                          <span data-slot="task-header-agent-attention-label">
                            {language.t("task.backgroundAgents.needsInput")}
                          </span>
                        </Show>
                      </span>
                    </button>
                    <Show when={!props.readonly && agent.status === "running"}>
                      <Button
                        icon="stop"
                        variant="ghost"
                        size="small"
                        aria-label={`${language.t("task.backgroundAgents.cancel")}: ${label(agent)}`}
                        onClick={(event: MouseEvent) => cancelAgent(event, agent)}
                      >
                        <span data-slot="task-header-agent-action-label">
                          {language.t("task.backgroundAgents.cancel")}
                        </span>
                      </Button>
                    </Show>
                    <Show when={!props.readonly && agent.status !== "running"}>
                      <Button
                        icon="close-small"
                        variant="ghost"
                        size="small"
                        aria-label={`${language.t("task.backgroundAgents.dismiss")}: ${label(agent)}`}
                        onClick={(event: MouseEvent) => {
                          event.stopPropagation()
                          const id = session.currentSessionID()
                          if (!id) return
                          const next = new Set(hidden()).add(agent.jobID)
                          setHidden(next)
                          save(id, { open: open(), hidden: next })
                        }}
                      >
                        <span data-slot="task-header-agent-action-label">
                          {language.t("task.backgroundAgents.dismiss")}
                        </span>
                      </Button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
