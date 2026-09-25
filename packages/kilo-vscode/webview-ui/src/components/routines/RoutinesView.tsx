import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Select } from "@kilocode/kilo-ui/select"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useVSCode } from "../../context/vscode"
import { routineFailure } from "../../utils/routine-recovery"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { runPresence } from "../../utils/run-presence"
import type { AgentInfo, ConnectionState, ExtensionMessage } from "../../types/messages"
import { action, select, type Execution } from "./run"
import { compile, initial, populate } from "../../../../src/shared/routine-schedule"
import { ScheduleEditor } from "./ScheduleEditor"
import { RunReview } from "./RunReview"
import { Archive } from "./Archive"
import { AccessReview } from "./AccessReview"
import { OutputEditor } from "./OutputEditor"
import { OutputReview } from "./OutputReview"
import RoutineSetup from "./RoutineSetup"
import { Inbox, status, type Anchor, type Box } from "./Inbox"
import { OrganizationActivity } from "./OrganizationActivity"
import { ReportSetting } from "./ReportSetting"
import { polling } from "./routine-polling"
import { Output } from "../../../../src/shared/routine-output"
import type { RoutinePaths } from "../../../../src/shared/routine-paths"

type Schedule =
  | { kind: "once"; at: number }
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "event"; source: string; filter?: string }
  | { kind: "manual" }

type Agent = {
  id: string
  name: string
  role: string
  objective: string
  output?: Output
  capabilities: string[]
  provisioning?: {
    enabled: boolean
    source: "user" | "chat" | "worker"
    actorID?: string
    changedAt: number
  }
  schedule: Schedule
  scheduleVersion?: number
  enabled: boolean
  note?: string
  nextRun?: number
  execution?: Execution
  access?: "full" | "brief"
  tools?: string[]
  dir?: string
  paths?: RoutinePaths
  mode?: string
  plan?: string
  budget?: number
}

type Run = {
  id: string
  agentID: string
  at: number
  trigger?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["trigger"]
  sessionID: string
  status: "running" | "complete" | "blocked" | "error"
  blockedReason?: string
  outcome?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["outcome"]
}

type Template = {
  id: string
  name: string
  role: string
  objective: string
  capabilities: string[]
  schedule: Schedule
}

type Organization = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]
type Member = Omit<Organization["members"][number], "position">
type Delegation = Omit<Organization["delegations"][number], "position">

type Choice = { key: string; label: string }

type Saved = {
  selected?: Record<string, string>
  organizations?: Record<string, string>
  anchors?: Record<string, Anchor & { at: number }>
}

type ViewState = Record<string, unknown> & { routineInbox?: Saved }

function defaultOutput(): Output {
  return {
    destination: "conversation",
    description: "A clear report in this worker's conversation.",
    criteria: [
      {
        id: `criterion-${crypto.randomUUID()}`,
        description: "The report addresses the standing job and calls out anything that needs attention.",
        verification: "Check the report against the standing job and include supporting evidence when available.",
      },
    ],
  }
}

function basicError(job: string, dir: string, edit: boolean) {
  if (!job.trim()) return "Describe what this worker should do."
  if (!edit && !dir.trim()) return "Choose a workspace folder for this worker."
  return ""
}

function runBudget(value: string) {
  if (!value.trim()) return undefined
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null
  return amount
}

function OrganizationEditor(props: {
  item: Organization
  agents: Agent[]
  saving: boolean
  error?: string
  provisioning?: string
  onClose: () => void
  onSave: (value: {
    name: string
    purpose: string
    policy: string
    budget: string
    members: Member[]
    delegations: Delegation[]
  }) => void
  onArchive: () => void
  onProvision: (agentID: string, enabled: boolean, expected: boolean) => void
}) {
  const [name, setName] = createSignal(props.item.name)
  const [purpose, setPurpose] = createSignal(props.item.purpose ?? "")
  const [policy, setPolicy] = createSignal(props.item.policy ?? "")
  const [budget, setBudget] = createSignal(props.item.budget?.toString() ?? "")
  const [members, setMembers] = createSignal<Member[]>(
    props.item.members.map((item) => ({
      agentID: item.agentID,
      role: item.role,
      ...(item.supervisorID ? { supervisorID: item.supervisorID } : {}),
    })),
  )
  const [delegations, setDelegations] = createSignal<Delegation[]>(
    props.item.delegations.map((item) => ({ senderID: item.senderID, recipientID: item.recipientID })),
  )
  const [candidate, setCandidate] = createSignal("")
  const available = createMemo(() =>
    props.agents.filter((item) => !members().some((member) => member.agentID === item.id)),
  )
  const label = (id: string) => props.agents.find((item) => item.id === id)?.name ?? "Archived worker"
  const provisions = (id: string) =>
    props.agents
      .find((item) => item.id === id)
      ?.capabilities.some((capability) => capability.toLowerCase() === "organization:provision") ?? false
  const provenance = (id: string) => props.agents.find((item) => item.id === id)?.provisioning
  const revise = (id: string, update: Partial<Member>) =>
    setMembers((items) => items.map((item) => (item.agentID === id ? { ...item, ...update } : item)))
  const remove = (id: string) => {
    setMembers((items) =>
      items
        .filter((item) => item.agentID !== id)
        .map((item) => (item.supervisorID === id ? { ...item, supervisorID: undefined } : item)),
    )
    setDelegations((items) => items.filter((item) => item.senderID !== id && item.recipientID !== id))
  }
  const add = () => {
    const agent = props.agents.find((item) => item.id === candidate())
    if (!agent) return
    setMembers((items) => [...items, { agentID: agent.id, role: agent.role }])
    setCandidate("")
  }
  const allowed = (senderID: string, recipientID: string) =>
    delegations().some((item) => item.senderID === senderID && item.recipientID === recipientID)
  const permit = (senderID: string, recipientID: string, on: boolean) =>
    setDelegations((items) =>
      on
        ? [...items, { senderID, recipientID }]
        : items.filter((item) => item.senderID !== senderID || item.recipientID !== recipientID),
    )
  const valid = createMemo(() => !!name().trim() && members().length > 0 && members().every((item) => item.role.trim()))

  return (
    <section class="routines-thread routines-organization-editor" aria-labelledby={`edit-${props.item.id}`}>
      <div class="routines-thread-head">
        <div class="routines-thread-identity">
          <h3 id={`edit-${props.item.id}`}>Organization settings</h3>
          <span>{props.item.name}</span>
        </div>
        <Button variant="ghost" size="small" disabled={props.saving} onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          size="small"
          disabled={props.saving || !valid()}
          onClick={() =>
            props.onSave({
              name: name().trim(),
              purpose: purpose().trim(),
              policy: policy().trim(),
              budget: budget().trim(),
              members: members(),
              delegations: delegations(),
            })
          }
        >
          {props.saving ? "Saving" : "Save"}
        </Button>
      </div>
      <div class="routines-thread-body routines-organization-form">
        <Show when={props.error}>
          <p class="routines-error" role="alert">
            {props.error}
          </p>
        </Show>
        <label class="routines-field">
          Name
          <input value={name()} maxlength={120} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label class="routines-field">
          Purpose
          <textarea
            value={purpose()}
            maxlength={2000}
            rows={3}
            placeholder="What this team owns and reports back"
            onInput={(event) => setPurpose(event.currentTarget.value)}
          />
        </label>
        <details class="routines-organization-disclosure">
          <summary>How this team works</summary>
          <div class="routines-organization-disclosure-body">
            <label class="routines-field">
              Instructions for the team
              <textarea
                value={policy()}
                maxlength={12000}
                rows={5}
                aria-describedby={`policy-help-${props.item.id}`}
                placeholder="Rules every worker must follow when doing organization work"
                onInput={(event) => setPolicy(event.currentTarget.value)}
              />
              <span id={`policy-help-${props.item.id}`} class="routines-hint">
                Shared instructions for this team. Access and permissions are set separately.
              </span>
            </label>
            <label class="routines-field">
              Spending limit ($)
              <input
                value={budget()}
                inputmode="numeric"
                pattern="[0-9]*"
                maxlength={7}
                placeholder="No shared limit"
                aria-describedby={`budget-help-${props.item.id}`}
                onInput={(event) => setBudget(event.currentTarget.value)}
              />
              <span id={`budget-help-${props.item.id}`} class="routines-hint">
                Optional limit for this team's model use.
              </span>
            </label>
          </div>
        </details>

        <section class="routines-organization-section" aria-labelledby={`team-${props.item.id}`}>
          <div class="routines-organization-section-head">
            <div>
              <h4 id={`team-${props.item.id}`}>Team</h4>
              <p>Choose who belongs here and how they work together.</p>
            </div>
          </div>
          <ol class="routines-organization-edit-members">
            <For each={members()}>
              {(member) => (
                <li>
                  <div class="routines-organization-member-summary">
                    <strong>{label(member.agentID)}</strong>
                    <span>{member.role}</span>
                  </div>
                  <details class="routines-organization-member-settings">
                    <summary>Worker settings</summary>
                    <div class="routines-organization-member-fields">
                      <Checkbox
                        checked={provisions(member.agentID)}
                        disabled={props.saving || props.provisioning === member.agentID}
                        onChange={(enabled) => props.onProvision(member.agentID, enabled, provisions(member.agentID))}
                      >
                        Can create workers
                      </Checkbox>
                      <Show when={provenance(member.agentID)}>
                        {(entry) => (
                          <span class="routines-hint">
                            {entry().source === "user"
                              ? "Changed by you"
                              : entry().source === "chat"
                                ? "Changed from chat"
                                : "Changed by " + label(entry().actorID ?? "")}{" "}
                            · {new Date(entry().changedAt).toLocaleString()}
                          </span>
                        )}
                      </Show>
                      <label class="routines-field">
                        Role
                        <input
                          value={member.role}
                          maxlength={120}
                          onInput={(event) => revise(member.agentID, { role: event.currentTarget.value })}
                        />
                      </label>
                      <label class="routines-field">
                        Team lead
                        <select
                          value={member.supervisorID ?? ""}
                          onChange={(event) =>
                            revise(member.agentID, { supervisorID: event.currentTarget.value || undefined })
                          }
                        >
                          <option value="">No supervisor</option>
                          <For each={members().filter((item) => item.agentID !== member.agentID)}>
                            {(item) => <option value={item.agentID}>{label(item.agentID)}</option>}
                          </For>
                        </select>
                      </label>
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={members().length === 1}
                        onClick={() => remove(member.agentID)}
                      >
                        Remove
                      </Button>
                    </div>
                  </details>
                </li>
              )}
            </For>
          </ol>
          <Show when={available().length > 0}>
            <div class="routines-organization-add">
              <label class="routines-field">
                Add worker
                <select value={candidate()} onChange={(event) => setCandidate(event.currentTarget.value)}>
                  <option value="">Choose a worker</option>
                  <For each={available()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                </select>
              </label>
              <Button variant="secondary" size="small" disabled={!candidate()} onClick={add}>
                Add
              </Button>
            </div>
          </Show>
        </section>

        <details class="routines-organization-disclosure">
          <summary>Who can assign work</summary>
          <section class="routines-organization-section" aria-labelledby={`authority-${props.item.id}`}>
            <div class="routines-organization-section-head">
              <div>
                <h4 id={`authority-${props.item.id}`}>Who can hand off work</h4>
                <p>Choose which teammates can pass work to each other.</p>
              </div>
            </div>
            <div class="routines-authority">
              <For each={members()}>
                {(sender) => (
                  <fieldset>
                    <legend>{label(sender.agentID)} can assign work to</legend>
                    <For each={members().filter((item) => item.agentID !== sender.agentID)}>
                      {(recipient) => (
                        <Checkbox
                          checked={allowed(sender.agentID, recipient.agentID)}
                          onChange={(on) => permit(sender.agentID, recipient.agentID, on)}
                        >
                          {label(recipient.agentID)}
                        </Checkbox>
                      )}
                    </For>
                    <Show when={members().length === 1}>
                      <span class="routines-hint">Add another worker to delegate work.</span>
                    </Show>
                  </fieldset>
                )}
              </For>
            </div>
          </section>
        </details>

        <details class="routines-organization-disclosure routines-organization-archive">
          <summary>Archive organization</summary>
          <section
            class="routines-organization-section routines-organization-danger"
            aria-labelledby={`archive-${props.item.id}`}
          >
            <div>
              <h4 id={`archive-${props.item.id}`}>Archive {props.item.name}</h4>
              <p>
                Raya stops every worker and disables its schedules. They will not restart on their own. Chats, work and
                reports stay saved.
              </p>
            </div>
            <Button intent="destructive" scale="compact" pending={props.saving} onClick={props.onArchive}>
              Archive organization
            </Button>
          </section>
        </details>
      </div>
    </section>
  )
}

function scope(value: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
}

function pair(workspace: string, conversation: string) {
  return JSON.stringify([workspace, conversation])
}

const roles = [
  { id: "briefer", label: "Briefer" },
  { id: "reviewer", label: "Reviewer" },
  { id: "accountant", label: "Accountant" },
  { id: "inbox", label: "Inbox" },
  { id: "designer", label: "Designer" },
  { id: "coder", label: "Coder" },
  { id: "generalist", label: "Generalist" },
  { id: "custom", label: "Custom" },
] as const

const chat: Choice = { key: "chat", label: "Same as chat" }

const work = [
  {
    id: "full" as const,
    label: "Full tool access",
    description:
      "Allows editing, shell commands, browser actions, delegation, and external tools unless a saved tool list restricts them. This is not limited to workspace files.",
  },
  {
    id: "brief" as const,
    label: "Read and report",
    description:
      "Read files and resources, search their contents, and report in the run conversation. Shell, browser actions, delegation, and unlisted tool permissions are denied.",
  },
]

function title(agent: AgentInfo) {
  if (agent.displayName) return agent.displayName
  return agent.name
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function whenLabel(schedule: NonNullable<Extract<ExtensionMessage, { type: "routineForecast" }>["schedule"]>) {
  if (schedule.kind === "manual") return "When you ask"
  if (schedule.kind === "once") return new Date(Number(schedule.at)).toLocaleString()
  if (schedule.kind === "event") return `On ${schedule.source}${schedule.filter ? ` (${schedule.filter})` : ""}`
  if (schedule.expr === "0 18 * * 1-5") return "Weekdays at 6pm"
  if (schedule.expr === "0 9 * * 1-5") return "Weekday mornings"
  if (schedule.expr === "0 9 * * *") return "Every morning"
  return schedule.expr
}

function timezone(schedule: NonNullable<Extract<ExtensionMessage, { type: "routineForecast" }>["schedule"]>) {
  return schedule.kind === "cron" ? schedule.tz : undefined
}

function latest(item: Agent, book: Record<string, Run[]>) {
  if (item.execution) return (book[item.id] ?? []).findLast((run) => run.sessionID === item.execution?.sessionID)
  return select(book[item.id] ?? [])
}

function held(item: Agent, book: Record<string, Run[]>) {
  const run = latest(item, book)
  if (!run) return
  if (run.status === "running" || (run.status === "blocked" && run.blockedReason === "waiting on you")) return run.id
}

function live(item: Agent, book: Record<string, Run[]>) {
  const state = item.execution?.state
  return !!held(item, book) || state === "active" || state === "starting"
}

function advice(item: Agent, book: Record<string, Run[]>) {
  if (live(item, book)) {
    return item.enabled
      ? "Existing runs continue. The new schedule applies after unfinished work settles."
      : "Existing runs continue. The new schedule applies after unfinished work settles. This worker stays paused."
  }
  if (item.enabled) return "Existing runs continue. The new schedule applies after unfinished work settles."
  return "This routine is paused. Saving keeps it paused."
}

function roleof(role: string, custom: string) {
  return role === "custom" ? custom.trim() || "custom" : role
}

function grants(money: boolean, messages: boolean) {
  return [money ? "money" : "", messages ? "messages" : ""].filter(Boolean)
}

function known(id: string) {
  return roles.some((item) => item.id === id && item.id !== "custom")
}

function folder(path: string) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  return parts.at(-1) ?? path
}

function others(id: string, roster: Agent[]) {
  return roster.filter((item) => item.id !== id)
}

function identity(item?: Agent) {
  return item?.id
}

function heading(editing: boolean, screen: "roster" | "assign") {
  if (editing) return "Edit schedule"
  if (screen === "assign") return "Assign a routine"
  return "Routines"
}

function tone(on: boolean) {
  return on ? "primary" : "ghost"
}

function showing(screen: "roster" | "assign", agent: boolean, organization: boolean, editing: boolean) {
  return screen === "roster" && (agent || organization || editing)
}

function retreat(editing: boolean, agent: boolean, edit: () => void, worker: () => void, organization: () => void) {
  if (editing) return edit()
  if (agent) return worker()
  return organization()
}

function caption(command: ReturnType<typeof action>, item: Agent) {
  if (command === "review") return "Needs review"
  if (command === "running") return item.execution?.state === "starting" ? "Starting" : "Running"
  if (command === "open")
    return item.execution?.state === "recovery"
      ? item.execution.recovery === "followup"
        ? "Review follow-up"
        : "Review run"
      : "Open run"
  return "Run now"
}

function recovery(item: { agentID: string; runID?: string }, agents: Agent[]) {
  if (!item.runID) return
  const execution = agents.find((agent) => agent.id === item.agentID)?.execution
  if (execution?.state !== "recovery" || execution.runID !== item.runID) return
  return execution.recovery === "followup" ? ("followup" as const) : ("start" as const)
}

function recoveryNote(item: Agent) {
  if (item.execution?.recovery === "followup")
    return "A follow-up may have reached this worker. Review it before more work starts."
  return "Recovery review required before another run can start."
}

function flag(on: boolean) {
  return on ? "true" : undefined
}

function overlay(reviewed: unknown, inspection: unknown) {
  return reviewed || inspection ? "true" : undefined
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase()
}

function recent(time?: number) {
  if (!time) return ""
  const date = new Date(time)
  if (Number.isNaN(date.valueOf())) return ""
  const today = new Date()
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function occupancy(item: Agent, box?: Box) {
  return status(box?.state ?? "scheduled", item.schedule.kind === "manual", item.enabled)
}

function unzoned(item: Agent) {
  return item.schedule.kind === "cron" && !item.schedule.tz?.trim()
}

function blocked(command: ReturnType<typeof action>, access: Agent["access"], canOpen: boolean) {
  if (command === "running" || command === "review") return true
  if (command === "open") return !canOpen
  return access === undefined
}

const Person: Component<{
  item: Agent
  box?: Box
  stale?: string
  picked: boolean
  manage: boolean
  current: boolean
  panel: string
  inspectable: boolean
  canOpen: boolean
  presence: ReturnType<typeof runPresence>
  command: ReturnType<typeof action>
  onChoose: () => void
  onMark: (on: boolean) => void
  onAct: () => void
  onToggle: () => void
  onEdit: () => void
  onAccess: () => void
  onOutput: () => void
  onInspect: () => void
  onRemove: () => void
}> = (props) => {
  const [menu, setMenu] = createSignal(false)
  let row: HTMLLIElement | undefined
  const call = (fn: () => void) => {
    setMenu(false)
    fn()
  }
  return (
    <li
      ref={row}
      class="routines-row"
      data-presence={props.presence}
      data-paused={flag(!props.item.enabled)}
      data-picked={flag(props.picked)}
      data-current={flag(props.current)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !menu()) return
        event.stopPropagation()
        setMenu(false)
        queueMicrotask(() => row?.querySelector<HTMLButtonElement>("[data-routine-options]")?.focus())
      }}
    >
      <Show
        when={props.manage}
        fallback={
          <span class="routines-avatar" data-presence={props.presence} aria-hidden="true">
            {initials(props.item.name)}
          </span>
        }
      >
        <Checkbox hideLabel checked={props.picked} onChange={props.onMark}>
          Select {props.item.name}
        </Checkbox>
      </Show>
      <button
        type="button"
        class="routines-identity"
        data-routine-worker={props.item.id}
        aria-current={flag(props.current)}
        aria-label={`${props.item.name}, ${props.item.role}, ${occupancy(props.item, props.box)}${props.box?.unread ? `, ${props.box.unread} unread` : ""}`}
        onClick={() => call(props.onChoose)}
      >
        <span class="routines-name">{props.item.name}</span>
        <span class="routines-job">{props.box?.latest?.body ?? props.item.objective}</span>
        <Show when={props.stale}>
          <span class="routines-note" role="status">
            History may be stale: {props.stale}
          </span>
        </Show>
        <Show when={props.item.execution?.state === "recovery"}>
          <span class="routines-note">{recoveryNote(props.item)}</span>
        </Show>
        <Show when={unzoned(props.item)}>
          <span class="routines-note">Timezone needs review</span>
        </Show>
      </button>
      <div class="routines-side">
        <span class="routines-time">{recent(props.box?.latest?.time)}</span>
        <Show when={props.box?.unread}>
          {(count) => (
            <span class="routines-unread" aria-label={`${count()} unread`}>
              {count()}
            </span>
          )}
        </Show>
        <IconButton
          icon="settings-gear"
          size="small"
          variant="ghost"
          aria-label={`${props.item.name} options`}
          aria-haspopup="menu"
          aria-expanded={menu()}
          aria-controls={menu() ? `${props.panel}-${props.item.id}-menu` : undefined}
          data-routine-options={props.item.id}
          onClick={() => setMenu((value) => !value)}
        />
        <div id={`${props.panel}-${props.item.id}-menu`} class="routines-menu" role="menu" hidden={!menu()}>
          <Button
            size="small"
            variant="ghost"
            role="menuitem"
            disabled={blocked(props.command, props.item.access, props.canOpen)}
            onClick={() => call(props.onAct)}
          >
            {caption(props.command, props.item)}
          </Button>
          <Button size="small" variant="ghost" role="menuitem" onClick={() => call(props.onToggle)}>
            {props.item.enabled ? "Pause" : "Enable"}
          </Button>
          <Button size="small" variant="ghost" role="menuitem" onClick={() => call(props.onEdit)}>
            Edit schedule
          </Button>
          <Button
            size="small"
            variant="ghost"
            role="menuitem"
            data-routine-access={props.item.id}
            onClick={() => call(props.onAccess)}
          >
            Review access
          </Button>
          <Button
            size="small"
            variant="ghost"
            role="menuitem"
            data-routine-output={props.item.id}
            onClick={() => call(props.onOutput)}
          >
            Edit output
          </Button>
          <Show when={props.inspectable}>
            <Button
              size="small"
              variant="ghost"
              role="menuitem"
              data-routine-instructions={props.item.id}
              onClick={() => call(props.onInspect)}
            >
              Review runs
            </Button>
          </Show>
          <div class="routines-menu-separator" role="separator" />
          <Button size="small" variant="ghost" role="menuitem" onClick={() => call(props.onRemove)}>
            Remove worker
          </Button>
        </div>
      </div>
    </li>
  )
}

interface RoutinesViewProps {
  onBack?: () => void
  onOpenSession?: (id: string) => void
  onAskRaya?: (text: string) => void
  onSubmitPlan?: (text: string) => void
  canSubmitPlan?: boolean
  workspace?: string
  focus?: { nonce: string; organizationID?: string; agentID?: string }
  onFocusConsumed?: () => void
}

const RoutinesView: Component<RoutinesViewProps> = (props) => {
  const vscode = useVSCode()
  const language = useLanguage()
  const session = useSession()
  const dialog = useDialog()
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [organizations, setOrganizations] = createSignal<Organization[]>([])
  const [organization, setOrganization] = createSignal<string>()
  const [organizationError, setOrganizationError] = createSignal("")
  const [organizationsLoaded, setOrganizationsLoaded] = createSignal(false)
  const [editingOrganization, setEditingOrganization] = createSignal<Organization>()
  const [organizationRequest, setOrganizationRequest] = createSignal<{
    id: string
    action: "update" | "archive"
    organizationID: string
  }>()
  const [authorityRequest, setAuthorityRequest] = createSignal<{ id: string; agentID: string }>()
  const provisioning = createMemo(() => authorityRequest()?.agentID)
  const locking = () => !!organizationRequest() || !!authorityRequest()
  const [organizationNotice, setOrganizationNotice] = createSignal("")
  const [workReceipt, setWorkReceipt] = createSignal<{ organizationID: string; id: string; name: string }>()
  const [manage, setManage] = createSignal(false)
  const [templates, setTemplates] = createSignal<Template[]>([])
  const [runs, setRuns] = createSignal<Record<string, Run[]>>({})
  const [inspection, setInspection] = createSignal<{ agentID: string; name: string; runID?: string }>()
  const [reviewed, setReviewed] = createSignal<Agent>()
  const [section, setSection] = createSignal<"access" | "output">("access")
  const panel = createUniqueId()
  let root: HTMLDivElement | undefined
  let focused = ""
  const [error, setError] = createSignal("")
  const [name, setName] = createSignal("")
  const [role, setRole] = createSignal("briefer")
  const [custom, setCustom] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [output, setOutput] = createSignal<Output>(defaultOutput())
  const deliverable = createMemo(() => Output.safeParse(output()).success)
  const [draft, setDraft] = createSignal(initial(Intl.DateTimeFormat().resolvedOptions().timeZone))
  const [editing, setEditing] = createSignal<Agent>()
  const [pending, setPending] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [request, setRequest] = createSignal<{ id: string; key: string }>()
  const [preview, setPreview] = createSignal<Extract<ExtensionMessage, { type: "routineForecast" }>>()
  const key = () => JSON.stringify([draft(), editing()?.id, editing()?.schedule, editing()?.scheduleVersion])
  const confirmed = () => Boolean(preview()?.forecastID) && request()?.key === key()
  const previewing = () => request()?.key === key() && !preview()
  const [money, setMoney] = createSignal(false)
  const [messages, setMessages] = createSignal(false)
  const [plan, setPlan] = createSignal("")
  const [budget, setBudget] = createSignal("")
  const [mode, setMode] = createSignal("chat")
  const [dir, setDir] = createSignal(scope(props.workspace ?? ""))
  const [wait, setWait] = createSignal("")
  const [access, setAccess] = createSignal<"full" | "brief">("brief")
  const [screen, setScreen] = createSignal<"roster" | "assign">("roster")
  const [setup, setSetup] = createSignal<"job" | "schedule" | "budget" | "review">("job")
  const [busy, setBusy] = createSignal<Record<string, true>>({})
  const [picked, setPicked] = createSignal<Record<string, true>>({})
  const [saving, setSaving] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [freshness, setFreshness] = createSignal("Waiting to refresh routines.")
  const [connection, setConnection] = createSignal<ConnectionState>("connected")
  const [stale, setStale] = createSignal<Record<string, string>>({})
  const [boxes, setBoxes] = createSignal<Record<string, Box>>({})
  const [chosen, setChosen] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [idea, setIdea] = createSignal("")
  const [attention, setAttention] = createSignal<"all" | "unread" | "needs">("all")
  const [workspace, setWorkspace] = createSignal(scope(props.workspace ?? ""))
  let correlation = crypto.randomUUID()
  let revision = 0
  let dirty = false
  let hold = false

  createEffect(() => {
    const next = scope(props.workspace ?? "")
    setWorkspace(next)
  })

  const start = () => {
    setEditing()
    setName("")
    setRole("briefer")
    setCustom("")
    setObjective("")
    setOutput(defaultOutput())
    setDraft(initial(Intl.DateTimeFormat().resolvedOptions().timeZone))
    setMoney(false)
    setMessages(false)
    setPlan("")
    setBudget("")
    setMode("chat")
    setDir(workspace())
    setAccess("brief")
    setSetup("job")
    setPreview()
    setRequest()
    setNotice("")
    setError("")
    setScreen("assign")
  }

  const viewState = () => {
    const value = vscode.getState<ViewState>()
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as ViewState
    return value
  }

  const cache = () => {
    const value = viewState().routineInbox
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Saved
    return value
  }

  const update = (saved: Saved) => vscode.setState<ViewState>({ ...viewState(), routineInbox: saved })

  const remember = (agentID?: string) => {
    const dir = workspace()
    if (!dir) return
    const saved = cache()
    const selected = { ...(saved.selected ?? {}) }
    if (agentID) selected[dir] = agentID
    else delete selected[dir]
    update({ ...saved, selected })
  }

  const rememberOrganization = (organizationID?: string) => {
    const dir = workspace()
    if (!dir) return
    const saved = cache()
    const organizations = { ...(saved.organizations ?? {}) }
    if (organizationID) organizations[dir] = organizationID
    else delete organizations[dir]
    update({ ...saved, organizations })
  }

  const stored = () => {
    const dir = workspace()
    if (!dir) return
    const value = cache().selected?.[dir]
    return typeof value === "string" && value ? value : undefined
  }

  const storedOrganization = () => {
    const dir = workspace()
    if (!dir) return
    const value = cache().organizations?.[dir]
    return typeof value === "string" && value ? value : undefined
  }

  const anchor = (conversation?: string) => {
    const dir = workspace()
    if (!dir || !conversation) return
    const value = cache().anchors?.[pair(dir, conversation)]
    if (!value || typeof value.id !== "string" || !Number.isFinite(value.offset)) return
    return { id: value.id, offset: value.offset }
  }

  const saveAnchor = (conversation: string | undefined, value?: Anchor) => {
    const dir = workspace()
    if (!dir || !conversation) return
    const saved = cache()
    const anchors = { ...(saved.anchors ?? {}) }
    const key = pair(dir, conversation)
    if (value && Number.isFinite(value.offset)) anchors[key] = { ...value, at: Date.now() }
    else delete anchors[key]
    const entries = Object.entries(anchors)
      .filter((entry) => {
        const item = entry[1]
        return !!item && typeof item.id === "string" && Number.isFinite(item.offset) && Number.isFinite(item.at)
      })
      .sort((a, b) => b[1].at - a[1].at)
    update({ ...saved, anchors: Object.fromEntries(entries.slice(0, 128)) })
  }

  const choose = (agentID?: string) => {
    setChosen(agentID)
    remember(agentID)
  }

  const chooseOrganization = (organizationID?: string) => {
    choose()
    setPicked({})
    setEditingOrganization()
    setOrganizationNotice("")
    setOrganization(organizationID)
    rememberOrganization(organizationID)
  }

  const leaveOrganization = () => {
    const id = organization()
    setEditingOrganization()
    chooseOrganization()
    queueMicrotask(() => {
      if (organization() || !root?.isConnected) return
      const token = id && typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id
      const button = token
        ? root.querySelector<HTMLElement>(`.routines-organization[data-routine-organization="${token}"]`)
        : undefined
      const target = button ?? root.querySelector<HTMLElement>(".routines-title")
      target?.focus()
    })
  }

  createEffect(() => {
    const target = props.focus
    if (!target || target.nonce === focused || !loaded() || (target.organizationID && !organizationsLoaded())) return
    focused = target.nonce
    props.onFocusConsumed?.()
    if (target.organizationID) {
      const item = organizations().find((entry) => entry.id === target.organizationID)
      if (!item) {
        setError("That organization is no longer in the active list.")
        return
      }
      setEditingOrganization()
      choose()
      chooseOrganization(item.id)
      queueMicrotask(() => root?.querySelector<HTMLElement>(`#organization-${item.id}`)?.focus())
      return
    }
    if (!target.agentID || !agents().some((item) => item.id === target.agentID)) {
      setError("That routine is no longer in the active list.")
      return
    }
    const item = organizations().find((entry) => entry.members.some((member) => member.agentID === target.agentID))
    chooseOrganization(item?.id)
    choose(target.agentID)
    queueMicrotask(() => root?.querySelector<HTMLElement>(".routines-thread-identity strong")?.focus())
  })

  const editOrganization = (item: Organization) => {
    setEditingOrganization(item)
    setOrganizationNotice("")
  }

  const saveOrganization = (value: {
    name: string
    purpose: string
    policy: string
    budget: string
    members: Member[]
    delegations: Delegation[]
  }) => {
    const item = editingOrganization()
    if (!item || organizationRequest()) return
    const id = crypto.randomUUID()
    setOrganizationNotice("")
    setOrganizationRequest({ id, action: "update", organizationID: item.id })
    vscode.postMessage({
      type: "routineOrganizationUpdate",
      requestID: id,
      organizationID: item.id,
      expectedRevision: item.revision,
      ...value,
    })
  }

  const saveProvisioning = (agentID: string, enabled: boolean, expected: boolean) => {
    if (authorityRequest()) return
    const id = crypto.randomUUID()
    setOrganizationNotice("")
    setAuthorityRequest({ id, agentID })
    vscode.postMessage({
      type: "routineProvisioningUpdate",
      requestID: id,
      agentID,
      enabled,
      expected,
    })
  }

  const archiveOrganization = (target?: Organization) => {
    const item = target ?? editingOrganization()
    if (!item || organizationRequest()) return
    dialog.show(() => (
      <Dialog title={`Archive ${item.name}?`} fit>
        <div class="dialog-confirm-body">
          <span>
            Raya will stop every worker and disable its schedules before archiving this organization. Its workers will
            not restart on their own. The organization leaves your active list; chats, work and reports stay saved.
          </span>
          <div class="dialog-confirm-actions">
            <Button intent="secondary" scale="large" onClick={() => dialog.close()} autofocus>
              Keep organization
            </Button>
            <Button
              intent="destructive"
              scale="large"
              onClick={() => {
                const id = crypto.randomUUID()
                setOrganizationNotice("")
                setOrganizationRequest({ id, action: "archive", organizationID: item.id })
                vscode.postMessage({
                  type: "routineOrganizationArchive",
                  requestID: id,
                  organizationID: item.id,
                  expectedRevision: item.revision,
                })
                dialog.close()
              }}
            >
              Archive organization
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const leave = () => {
    const id = chosen()
    choose()
    queueMicrotask(() => {
      if (chosen() || !root?.isConnected) return
      const title = root.querySelector<HTMLElement>(".routines-title")
      if (!id) {
        title?.focus()
        return
      }
      const token = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id
      const button = root.querySelector<HTMLElement>(`.routines-identity[data-routine-worker="${token}"]`)
      const target = button ?? title
      target?.focus()
    })
  }

  const back = () => {
    retreat(
      !!editingOrganization(),
      !!chosen(),
      () => {
        setEditingOrganization()
        setOrganizationNotice("")
      },
      leave,
      leaveOrganization,
    )
  }

  const dismiss = () => {
    const id = reviewed()?.id
    setReviewed(undefined)
    load()
    queueMicrotask(() => {
      if (reviewed() || inspection() || !root?.isConnected) return
      const button = [...(root?.querySelectorAll<HTMLButtonElement>("[data-routine-options]") ?? [])].find(
        (item) => item.dataset.routineOptions === id,
      )
      const target = button ?? root?.querySelector<HTMLElement>(".routines-title")
      target?.focus()
    })
  }

  const inspected = (id: string) => inspection()?.agentID === id
  const close = () => {
    const id = inspection()?.agentID
    setInspection(undefined)
    queueMicrotask(() => {
      if (inspection() || reviewed() || !root?.isConnected) return
      const button = [...root.querySelectorAll<HTMLButtonElement>("[data-routine-options]")].find(
        (item) => item.dataset.routineOptions === id,
      )
      const target = button ?? root.querySelector<HTMLElement>(".routines-title")
      target?.focus()
    })
  }
  const inspect = (item: Agent) => {
    setReviewed(undefined)
    if (inspected(item.id)) return close()
    setInspection({ agentID: item.id, name: item.name, runID: item.execution?.runID ?? latest(item, runs())?.id })
  }
  const inspectable = (item: Agent) => Boolean(item.execution?.runID || runs()[item.id]?.length)
  const review = (item: Agent, section: "access" | "output" = "access") => {
    setInspection(undefined)
    setSection(section)
    setReviewed(item)
  }
  const roster = (items: Agent[]) => {
    setLoaded(true)
    setAgents(items)
    if (reviewed() && section() !== "output" && !items.some((item) => item.id === reviewed()?.id)) dismiss()
    const id = chosen()
    if (id && !items.some((item) => item.id === id)) choose()
    if (!id) {
      const saved = stored()
      if (saved && items.some((item) => item.id === saved)) setChosen(saved)
      else if (saved) remember()
    }
    if (items.some((item) => inspected(item.id))) return
    if (root?.querySelector(".routines-instructions")?.contains(document.activeElement)) return close()
    setInspection(undefined)
  }

  const load = () => {
    if (connection() !== "connected") {
      setRefreshing(false)
      setFreshness("Disconnected. Previously loaded routine information may be stale.")
      return
    }
    if (refreshing()) {
      dirty = true
      return
    }
    setRefreshing(true)
    setFreshness("Refreshing routines and recorded history...")
    vscode.postMessage({ type: "routineList", requestID: correlation, viewID: correlation })
  }

  onMount(() => {
    load()
    if (session.agents().length === 0) vscode.postMessage({ type: "requestAgents" })
    const tick = setInterval(() => {
      if (polling(hold, chosen(), organization())) load()
    }, 4000)
    onCleanup(() => clearInterval(tick))
  })

  const receive = (msg: Extract<ExtensionMessage, { type: "routineForecast" }>) => {
    if (msg.requestID !== request()?.id || request()?.key !== key()) return
    setPreview(msg)
    if (msg.error) setError(routineFailure(msg.error, msg.recovery))
  }

  const updated = (msg: Extract<ExtensionMessage, { type: "routineScheduleUpdated" }>) => {
    if (!pending() || msg.requestID !== pending() || msg.agentID !== editing()?.id) return
    setPending("")
    hold = false
    setSaving(false)
    setPreview(undefined)
    setRequest(undefined)
    if (msg.error) {
      setNotice(routineFailure(msg.error, msg.recovery))
      return
    }
    setEditing(undefined)
    setScreen("roster")
    load()
  }

  const refresh = (msg: ExtensionMessage) => {
    if (msg.type === "connectionState") {
      setConnection(msg.state)
      correlation = crypto.randomUUID()
      revision = 0
      dirty = false
      setRefreshing(false)
      if (msg.state === "connected") load()
      else setFreshness("Disconnected. Previously loaded routine information may be stale.")
    }
    if (msg.type === "workspaceDirectoryChanged") {
      setWorkspace(scope(msg.directory))
      correlation = crypto.randomUUID()
      revision = 0
      dirty = false
      setRefreshing(false)
      setLoaded(false)
      setAgents([])
      setOrganizations([])
      setOrganization()
      setOrganizationError("")
      setOrganizationsLoaded(false)
      setEditingOrganization()
      setOrganizationRequest()
      setOrganizationNotice("")
      setRuns({})
      setStale({})
      setBoxes({})
      setChosen()
      load()
    }
    if (
      (msg.type === "routineState" || msg.type === "routineRuns" || msg.type === "routineInbox") &&
      msg.refreshID !== undefined
    ) {
      if (msg.viewID !== correlation || msg.requestID !== correlation || msg.refreshID < revision) return false
      revision = msg.refreshID
    }
    if (msg.type === "routineState" && msg.refresh) {
      setRefreshing(msg.refresh === "loading")
      if (msg.refresh === "loading") setFreshness("Refreshing routines and recorded history...")
      if (msg.refresh === "complete") setFreshness("Routines and recorded history refreshed.")
      if (msg.refresh === "partial")
        setFreshness("Some history could not be refreshed. Previous history remains visible.")
      if (msg.refresh === "error") setFreshness("Refresh failed. Previously loaded information may be stale.")
      if (msg.refresh !== "loading" && dirty && polling(hold, chosen(), organization())) {
        dirty = false
        load()
      }
    }
    return true
  }

  const history = (msg: Extract<ExtensionMessage, { type: "routineRuns" }>) => {
    if (msg.error) setStale((prior) => ({ ...prior, [msg.agentID]: routineFailure(msg.error, msg.recovery) }))
    if (Array.isArray(msg.runs)) {
      setRuns((prior) => ({ ...prior, [msg.agentID]: msg.runs as Run[] }))
      setStale((prior) => {
        const next = { ...prior }
        delete next[msg.agentID]
        return next
      })
    }
    setBusy((prior) => {
      const next = { ...prior }
      delete next[msg.agentID]
      return next
    })
  }

  const grouped = (msg: Extract<ExtensionMessage, { type: "routineState" }>) => {
    if (msg.organizations) {
      const items = msg.organizations as Organization[]
      setOrganizations(items)
      setOrganizationsLoaded(true)
      setOrganizationError("")
      const current = organization()
      if (current && !items.some((item) => item.id === current)) chooseOrganization()
      if (!current) {
        const saved = storedOrganization()
        if (saved && items.some((item) => item.id === saved)) setOrganization(saved)
        else if (saved) rememberOrganization()
      }
      const editing = editingOrganization()
      if (editing) setEditingOrganization(items.find((item) => item.id === editing.id))
    }
    if (msg.organizationError) setOrganizationError(msg.organizationError)
  }

  const received = (msg: Extract<ExtensionMessage, { type: "routineState" }>) => {
    if (msg.error) {
      if (msg.requestID === correlation) setRefreshing(false)
      setError(routineFailure(msg.error, msg.recovery))
      if (!editing()) {
        hold = false
        setSaving(false)
      }
    }
    if (msg.saved && !msg.error && editing() && saving() && !pending()) {
      setError("")
      hold = false
      setSaving(false)
      setEditing(undefined)
      setScreen("roster")
      load()
    }
    if (msg.saved && !msg.error && !editing()) {
      setError("")
      hold = false
      setSaving(false)
      setScreen("roster")
      setPicked({})
    }
    if (msg.agents) {
      roster(msg.agents as Agent[])
    }
    if (msg.templates) setTemplates(msg.templates as Template[])
    grouped(msg)
  }

  const organizationResult = (
    msg: Extract<ExtensionMessage, { type: "routineOrganizationUpdated" | "routineOrganizationArchived" }>,
  ) => {
    const request = organizationRequest()
    if (!request || msg.requestID !== request.id || msg.organizationID !== request.organizationID) return
    if (request.action === "update" && msg.type !== "routineOrganizationUpdated") return
    if (request.action === "archive" && msg.type !== "routineOrganizationArchived") return
    setOrganizationRequest()
    if (msg.error) {
      if (request.action === "archive" && organization() !== msg.organizationID) chooseOrganization(msg.organizationID)
      setOrganizationNotice(routineFailure(msg.error, msg.recovery))
      load()
      return
    }
    if (msg.type === "routineOrganizationUpdated" && msg.organization) {
      setOrganizations((items) => items.map((entry) => (entry.id === msg.organizationID ? msg.organization! : entry)))
      setEditingOrganization()
      setOrganizationNotice("")
      load()
      return
    }
    if (msg.type === "routineOrganizationArchived") {
      setEditingOrganization()
      if (organization() === msg.organizationID) chooseOrganization()
      load()
    }
  }

  const authorityResult = (msg: Extract<ExtensionMessage, { type: "routineProvisioningUpdated" }>) => {
    const request = authorityRequest()
    if (!request || msg.requestID !== request.id || msg.agentID !== request.agentID) return
    setAuthorityRequest()
    if (msg.error || !msg.agent) {
      setOrganizationNotice(routineFailure(msg.error ?? "Raya could not update this authority.", msg.recovery))
      load()
      return
    }
    setAgents((items) => items.map((item) => (item.id === msg.agentID ? (msg.agent as Agent) : item)))
    setOrganizationNotice("")
  }

  const boxed = (msg: Extract<ExtensionMessage, { type: "routineInbox" }>) => {
    if (msg.error) return
    if (!Array.isArray(msg.items)) return
    const next: Record<string, Box> = {}
    for (const item of msg.items as Box[]) {
      if (item?.agentID) next[item.agentID] = item
    }
    setBoxes(next)
  }

  const unsub = vscode.onMessage((msg: ExtensionMessage) => {
    if (!refresh(msg)) return
    if (msg.type === "routineForecast") receive(msg)
    if (msg.type === "routineScheduleUpdated") updated(msg)
    if (msg.type === "routineState") received(msg)
    if (msg.type === "routineOrganizationUpdated" || msg.type === "routineOrganizationArchived") organizationResult(msg)
    if (msg.type === "routineProvisioningUpdated") authorityResult(msg)
    if (msg.type === "routineInbox") boxed(msg)
    if (msg.type === "folderPickerResult" && msg.requestId === wait() && msg.path) {
      setDir(msg.path)
      setWait("")
    }
    if (msg.type === "routineRuns") history(msg)
    if ((msg.type === "sessionStatus" || msg.type === "sessionTurnClosed") && polling(hold, chosen(), organization()))
      load()
  })
  onCleanup(unsub)

  const picks = createMemo<Choice[]>(() => {
    const extras = session
      .agents()
      .filter((item) => !item.hidden)
      .map((item) => ({ key: item.name, label: title(item) }))
    extras.sort((a, b) => a.label.localeCompare(b.label))
    const list = [chat, ...extras]
    const extra = editing()?.mode?.trim()
    if (extra && extra !== "chat" && !list.some((item) => item.key === extra)) list.push({ key: extra, label: extra })
    return list
  })

  const current = createMemo(() => picks().find((item) => item.key === mode()) ?? chat)

  const pick = (next: string) => {
    setRole(next)
    setMoney(false)
    setMessages(false)
  }

  const consent = () => (role() !== "accountant" || money()) && (role() !== "inbox" || messages())

  const apply = (item: Template) => {
    setEditing(undefined)
    setScreen("assign")
    setName(item.name)
    pick(item.role)
    setObjective(item.objective)
    setOutput(defaultOutput())
    setDraft(populate(item.schedule, draft().zone))
    setSetup("review")
    setDir(workspace())
    setPreview()
    setRequest()
    setError("")
  }

  const moved = () => {
    const item = editing()
    if (!item) return false
    return (
      name().trim() !== item.name ||
      objective().trim() !== item.objective ||
      roleof(role(), custom()) !== item.role ||
      dir().trim() !== (item.dir ?? "") ||
      (current().key === "chat" ? undefined : current().key) !== (item.mode?.trim() || undefined) ||
      plan().trim() !== (item.plan ?? "") ||
      runBudget(budget()) !== item.budget
    )
  }

  const scheduleMoved = () => {
    const item = editing()
    if (!item) return false
    const zone =
      item.schedule.kind === "cron" && !item.schedule.tz?.trim() ? "" : Intl.DateTimeFormat().resolvedOptions().timeZone
    return JSON.stringify(draft()) !== JSON.stringify(populate(item.schedule, zone))
  }

  const caption = () => {
    if (saving()) return "Saving"
    if (previewing()) return "Checking schedule"
    if (!editing()) return confirmed() ? "Assign routine" : "Review schedule"
    if (scheduleMoved() && !confirmed()) return "Review schedule"
    if (confirmed()) return "Confirm changes"
    return "Save assignment"
  }
  const submitHint = () =>
    confirmed()
      ? "The schedule is checked. You can assign this routine now."
      : "Review shows the exact schedule before anything is saved."
  const submitBlocked = () => saving() || previewing()
  const settings = () => !!editing() || setup() === "review"

  const forecast = () => {
    const id = crypto.randomUUID()
    setError("")
    setPreview(undefined)
    setRequest({ id, key: key() })
    try {
      const item = editing()
      vscode.postMessage({
        type: "routineForecast",
        requestID: id,
        schedule: compile(draft()),
        edit: item
          ? {
              agentID: item.id,
              expectedSchedule: item.schedule,
              expectedScheduleVersion: item.scheduleVersion ?? 1,
            }
          : undefined,
      })
    } catch (err) {
      setPreview({
        type: "routineForecast",
        requestID: id,
        error: err instanceof Error ? err.message : "Choose a valid schedule.",
      })
    }
  }

  const persist = (item: Agent) => {
    const named = name().trim()
    const job = objective().trim()
    const part = roleof(role(), custom())
    const dest = dir().trim()
    const limit = runBudget(budget())
    if (limit === null) {
      setError("Enter a per-run model-cost limit above 0 and no more than $1,000,000, or leave it blank.")
      return
    }
    if (!named || !job) {
      setError("Keep a name and standing job.")
      return
    }
    if (!consent()) {
      setError("Choose whether to allow the records this role needs before assigning it.")
      return
    }
    const token = preview()?.forecastID
    const timed = confirmed() && !!token
    if (!moved() && !timed) {
      setError(
        "Preview the schedule before saving, or change the name, role, standing job, write folder, agent, or plan file.",
      )
      return
    }
    setError("")
    setSaving(true)
    hold = true
    if (moved())
      vscode.postMessage({
        type: "routineUpdate",
        agentID: item.id,
        name: named,
        objective: job,
        role: part,
        dir: dest || undefined,
        mode: current().key,
        plan: plan().trim(),
        capabilities: part === "accountant" || part === "inbox" ? grants(money(), messages()) : undefined,
        budget: limit ?? null,
        expectedBudget: item.budget ?? "unset",
      })
    if (!timed) return
    const id = crypto.randomUUID()
    setPending(id)
    setNotice("")
    vscode.postMessage({ type: "routineScheduleUpdate", requestID: id, agentID: item.id, forecastID: token })
  }

  const create = () => {
    const issue = basicError(objective(), dir(), !!editing())
    if (issue) {
      setError(issue)
      return
    }
    const limit = runBudget(budget())
    if (limit === null) {
      setError("Enter a per-run model-cost limit above 0 and no more than $1,000,000, or leave it blank.")
      return
    }
    if (!editing() && !consent()) {
      setError("Choose whether to allow the records this role needs before assigning it.")
      return
    }
    if (!editing() && !deliverable()) {
      setError("Describe the required output and how to verify each criterion before assigning it.")
      return
    }
    const item = editing()
    if (item) {
      if (scheduleMoved() && !confirmed()) {
        forecast()
        return
      }
      persist(item)
      return
    }
    const token = preview()?.forecastID
    if (!confirmed() || !token) {
      forecast()
      return
    }
    setError("")
    setSaving(true)
    hold = true
    const capabilities = grants(money(), messages())
    const chosen = current()
    vscode.postMessage({
      type: "routineCreate",
      name: name() || (role() === "custom" ? custom() : role()),
      role: role() === "custom" ? custom().trim() || "custom" : role(),
      objective: objective(),
      output: output(),
      forecastID: token,
      capabilities,
      plan: plan().trim() || undefined,
      access: access(),
      mode: chosen.key === "chat" ? undefined : chosen.key,
      dir: dir().trim(),
      budget: limit,
    })
  }

  const toggle = (item: Agent) =>
    vscode.postMessage({ type: "routineUpdate", agentID: item.id, enabled: !item.enabled })

  const edit = (item: Agent) => {
    setEditing(item)
    setName(item.name)
    setObjective(item.objective)
    if (known(item.role)) {
      setRole(item.role)
      setCustom("")
    } else {
      setRole("custom")
      setCustom(item.role)
    }
    setDir(item.dir ?? "")
    setMode(item.mode?.trim() || "chat")
    setPlan(item.plan ?? "")
    setBudget(item.budget?.toString() ?? "")
    setMoney(item.capabilities.some((cap) => ["money", "accounting", "books"].includes(cap.toLowerCase())))
    setMessages(item.capabilities.some((cap) => cap.toLowerCase() === "messages"))
    setDraft(
      populate(
        item.schedule,
        item.schedule.kind === "cron" && !item.schedule.tz?.trim()
          ? ""
          : Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    )
    setPreview(undefined)
    setRequest(undefined)
    setNotice("")
    setError("")
    setScreen("assign")
    setSetup("review")
  }

  const cancel = () => {
    setEditing(undefined)
    setNotice("")
    setScreen("roster")
    load()
  }

  const fire = (item: Agent) => {
    if (busy()[item.id]) return
    const last = latest(item, runs())
    if (action(last, false, item.execution) !== "start") return
    setBusy((prior) => ({ ...prior, [item.id]: true }))
    vscode.postMessage({ type: "routineRun", agentID: item.id })
  }

  const open = (item: Agent) => {
    const id = item.execution ? item.execution.sessionID : latest(item, runs())?.sessionID
    if (id) props.onOpenSession?.(id)
  }

  const mark = (id: string, on: boolean) => {
    setPicked((prior) => {
      const next = { ...prior }
      if (on) next[id] = true
      else delete next[id]
      return next
    })
  }

  const currentOrganization = createMemo(() => organizations().find((item) => item.id === organization()))
  const scoped = createMemo(() => {
    const item = currentOrganization()
    if (!item) return agents()
    const ids = new Set(item.members.map((member) => member.agentID))
    return agents().filter((agent) => ids.has(agent.id))
  })
  const selected = createMemo(() => Object.keys(picked()))
  const allOn = createMemo(() => scoped().length > 0 && scoped().every((item) => picked()[item.id]))
  const someOn = createMemo(() => selected().length > 0 && !allOn())

  const markAll = (on: boolean) => {
    if (!on) {
      setPicked({})
      return
    }
    const next: Record<string, true> = {}
    for (const item of scoped()) next[item.id] = true
    setPicked(next)
  }

  const drop = (ids: string[]) => {
    vscode.postMessage({ type: "routineRemove", agentIDs: ids })
    setPicked({})
  }

  const confirm = (ids: string[]) => {
    if (!ids.length) return
    const count = ids.length
    const title = count === 1 ? "Remove this routine?" : `Remove ${count} routines?`
    dialog.show(() => (
      <Dialog title={title} fit>
        <div class="dialog-confirm-body">
          <span>
            Removed routines stop launching work. Definitions, run history, role memory, and chats are retained. Resolve
            unfinished work first; restoration is not available.
          </span>
          <div class="dialog-confirm-actions">
            <Button intent="secondary" scale="large" onClick={() => dialog.close()} autofocus>
              Keep
            </Button>
            <Button
              intent="destructive"
              scale="large"
              onClick={() => {
                drop(ids)
                dialog.close()
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const reports = () =>
    dialog.show(() => (
      <Dialog title="Report settings" fit>
        <div class="routines-global-reports">
          <p>Choose whether eligible Routine workers may send reports to their own conversations.</p>
          <ReportSetting global connected={connection() === "connected"} />
          <div class="dialog-confirm-actions">
            <Button intent="secondary" scale="large" onClick={() => dialog.close()} autofocus>
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    ))

  const state = (item: Agent) => {
    if (item.execution) return item.execution.state === "recovery" ? ("error" as const) : ("working" as const)
    const last = latest(item, runs())
    return runPresence({
      busy: last?.status === "running" || !!busy()[item.id],
      waiting: last?.status === "blocked",
      done: last?.status === "complete",
      error: last?.status === "error",
    })
  }

  const empty = createMemo(() => agents().length === 0)
  const vacant = createMemo(() => empty() && loaded())
  const shown = createMemo(() => {
    const text = query().trim().toLowerCase()
    const filter = attention()
    return scoped().filter((item) => {
      const box = boxes()[item.id]
      if (filter === "unread" && !box?.unread) return false
      if (filter === "needs" && box?.state !== "needs_input" && box?.state !== "failed" && box?.state !== "waiting")
        return false
      if (!text) return true
      const hay = `${item.name} ${item.role} ${item.objective} ${box?.latest?.body ?? ""}`.toLowerCase()
      return hay.includes(text)
    })
  })
  const worker = createMemo(() => agents().find((item) => item.id === chosen()))
  const detail = createMemo(() => showing(screen(), !!chosen(), !!currentOrganization(), !!editingOrganization()))
  const overview = createMemo(() => !chosen() && !currentOrganization() && !editingOrganization())
  const detailLabel = createMemo(() => (chosen() && currentOrganization() ? currentOrganization()!.name : "Routines"))
  const roleOpt = createMemo(() => roles.find((item) => item.id === role()) ?? roles[0])
  const workOpt = createMemo(() => work.find((item) => item.id === access()) ?? work[0])
  const ask = (text: string) => {
    if (props.canSubmitPlan && props.onSubmitPlan) return props.onSubmitPlan(text)
    props.onAskRaya?.(text)
  }
  const begin = () => {
    const text = idea().trim()
    if (!text) return
    ask(
      `Set this up in Routines for me: ${text}\n\nUse Raya's native Routines tools and durable store. Infer sensible details from what I said. Ask one short question at a time only for choices you genuinely cannot infer. Do not ask me about files, databases, schemas, IDs, revisions, or other implementation details. Before saving, give me a short plain-language review of what will happen.`,
    )
  }

  return (
    <div ref={root} class="routines-view history-view" data-detail={flag(detail())}>
      <div class="history-view-header routines-main-header" data-detail={flag(detail())}>
        <Show when={props.onBack}>
          <Button class="routines-exit-back" variant="ghost" size="small" icon="arrow-left" onClick={props.onBack}>
            {language.t("common.goBack")}
          </Button>
        </Show>
        <Show when={detail()}>
          <Button class="routines-detail-back" variant="ghost" size="small" icon="arrow-left" onClick={back}>
            {detailLabel()}
          </Button>
        </Show>
        <h2 class="routines-title" tabIndex={-1}>
          {heading(!!editing(), screen())}
        </h2>
        <Show when={screen() === "assign"}>
          <Button class="routines-header-action" variant="ghost" size="small" disabled={saving()} onClick={cancel}>
            Done
          </Button>
        </Show>
      </div>
      <div class="routines-body" data-pane={screen() === "roster" ? "inbox" : undefined}>
        <Show when={error()}>
          <p class="routines-error" role="alert">
            {error()}
            <Button variant="ghost" size="small" onClick={() => setError("")}>
              Dismiss message
            </Button>
          </p>
        </Show>
        <Show when={screen() === "roster"}>
          <Show when={overview()}>
            <section class="routines-hero" aria-label="Routines overview">
              <div class="routines-hero-copy">
                <span>Raya's workforce</span>
                <h3>Give work a home.</h3>
                <p>
                  Set up a specialist for one standing job, or bring several workers together as a team. Raya helps
                  shape the plan before anyone starts.
                </p>
                <div class="routines-hero-actions">
                  <Button
                    onClick={() =>
                      ask(
                        "Help me create a specialist worker for a standing job. Ask what outcome I want, suggest a sensible schedule and access, then show me a short review before saving.",
                      )
                    }
                  >
                    Plan a worker
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      ask(
                        "Help me create a small organization of specialist workers. Ask what the team should accomplish, propose clear roles and delegation rules, then show me a short review before saving.",
                      )
                    }
                  >
                    Plan a team
                  </Button>
                </div>
              </div>
              <div class="routines-hero-stats" aria-label="Workforce status">
                <div>
                  <strong>{agents().length}</strong>
                  <span>Workers</span>
                </div>
                <div>
                  <strong>{organizations().length}</strong>
                  <span>Teams</span>
                </div>
                <div>
                  <strong>{agents().filter((item) => item.enabled).length}</strong>
                  <span>Active</span>
                </div>
              </div>
            </section>
            <Show when={organizations().length > 0}>
              <section class="routines-team-directory" aria-label="Your teams">
                <div class="routines-team-directory-head">
                  <h3>Teams</h3>
                  <span>{organizations().length} saved</span>
                </div>
                <div class="routines-team-directory-list">
                  <For each={organizations()}>
                    {(item) => (
                      <button type="button" onClick={() => chooseOrganization(item.id)}>
                        <span class="routines-team-directory-name">{item.name}</span>
                        <span class="routines-team-directory-purpose">
                          {item.purpose || `${item.members.length} workers`}
                        </span>
                        <span class="routines-team-directory-count">{item.members.length} workers</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </Show>
          <div class="sr-only" role="status" aria-live="polite" aria-busy={refreshing()}>
            {freshness()}
          </div>
          <Show when={vacant()}>
            <div class="routines-empty-block">
              <p class="routines-empty">No standing jobs yet. Assign one and it will sleep until it is time to work.</p>
              <div class="routines-empty-actions">
                <Button onClick={start}>Assign a routine</Button>
                <Button variant="ghost" disabled={refreshing()} onClick={load}>
                  Refresh
                </Button>
              </div>
            </div>
          </Show>
          <div
            class="routines-inbox"
            data-open={chosen() || currentOrganization() ? "true" : undefined}
            data-review={overlay(reviewed(), inspection())}
          >
            <div class="routines-people">
              <Show when={!vacant()}>
                <div class="routines-toolbar">
                  <div class="routines-roster-actions">
                    <Show
                      when={manage()}
                      fallback={
                        <>
                          <strong>Workers</strong>
                          <Button
                            size="small"
                            icon="plus"
                            onClick={() =>
                              ask(
                                "Help me set up a new Routine or team. Start by asking what I want Raya to handle, then infer sensible defaults and ask only the few decisions you genuinely need from me.",
                              )
                            }
                          >
                            New
                          </Button>
                        </>
                      }
                    >
                      <Checkbox hideLabel checked={allOn()} indeterminate={someOn()} onChange={markAll}>
                        Select all
                      </Checkbox>
                      <span class="routines-selection-count">{selected().length || "Select workers"}</span>
                      <Show when={selected().length > 0}>
                        <Button size="small" onClick={() => confirm(selected())}>
                          Remove
                        </Button>
                      </Show>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => {
                          setManage(false)
                          setPicked({})
                        }}
                      >
                        Done
                      </Button>
                    </Show>
                  </div>
                  <Show when={organizations().length > 0}>
                    <nav class="routines-organizations" aria-label="Organizations">
                      <button
                        type="button"
                        class="routines-organization"
                        aria-current={!organization() ? "page" : undefined}
                        onClick={() => chooseOrganization()}
                      >
                        All workers
                      </button>
                      <For each={organizations()}>
                        {(item) => (
                          <button
                            type="button"
                            class="routines-organization"
                            data-routine-organization={item.id}
                            aria-current={organization() === item.id ? "page" : undefined}
                            onClick={() => chooseOrganization(item.id)}
                          >
                            <span>{item.name}</span>
                            <span>{item.members.length}</span>
                          </button>
                        )}
                      </For>
                    </nav>
                  </Show>
                  <Show when={organizationError()}>
                    <p class="routines-organization-error" role="status">
                      {organizationError()}
                    </p>
                  </Show>
                  <label class="routines-field routines-search routines-roster-search">
                    <span class="sr-only">Search workers</span>
                    <input
                      value={query()}
                      aria-label="Search workers"
                      placeholder="Search"
                      onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                  </label>
                  <div class="routines-view-options">
                    <div class="routines-filters" role="group" aria-label="Worker filters">
                      <Button size="small" variant={tone(attention() === "all")} onClick={() => setAttention("all")}>
                        All
                      </Button>
                      <Button
                        size="small"
                        variant={tone(attention() === "unread")}
                        onClick={() => setAttention("unread")}
                      >
                        Unread
                      </Button>
                      <Button
                        size="small"
                        variant={tone(attention() === "needs")}
                        onClick={() => setAttention("needs")}
                      >
                        Needs attention
                      </Button>
                    </div>
                    <details class="routines-roster-more">
                      <summary>More options</summary>
                      <div class="routines-secondary">
                        <Show when={!organization()}>
                          <Button variant="ghost" size="small" onClick={reports}>
                            Report settings
                          </Button>
                        </Show>
                        <Button variant="ghost" size="small" onClick={() => setManage(true)}>
                          Manage workers
                        </Button>
                        <Button variant="ghost" size="small" disabled={refreshing()} onClick={load}>
                          Refresh
                        </Button>
                        <Archive onOpenSession={props.onOpenSession} />
                      </div>
                    </details>
                  </div>
                </div>
              </Show>
              <ul class="routines-list">
                <For each={shown()}>
                  {(item) => {
                    const run = () => latest(item, runs())
                    const command = () => action(run(), !!busy()[item.id], item.execution)
                    return (
                      <Person
                        item={item}
                        box={boxes()[item.id]}
                        stale={stale()[item.id]}
                        picked={!!picked()[item.id]}
                        manage={manage()}
                        current={chosen() === item.id}
                        panel={panel}
                        inspectable={inspectable(item)}
                        canOpen={
                          !!(item.execution ? item.execution.sessionID : run()?.sessionID) && !!props.onOpenSession
                        }
                        presence={state(item)}
                        command={command()}
                        onChoose={() => choose(item.id)}
                        onMark={(value) => mark(item.id, value)}
                        onAct={() => (command() === "open" ? open(item) : fire(item))}
                        onToggle={() => toggle(item)}
                        onEdit={() => edit(item)}
                        onAccess={() => review(item)}
                        onOutput={() => review(item, "output")}
                        onInspect={() => inspect(item)}
                        onRemove={() => confirm([item.id])}
                      />
                    )
                  }}
                </For>
              </ul>
              <Show when={shown().length === 0 && !vacant()}>
                <p class="routines-empty routines-no-match">No workers match this view.</p>
              </Show>
            </div>
            <Show when={identity(worker())} keyed>
              {(id) => {
                const item = createMemo(() => agents().find((candidate) => candidate.id === id)!)
                return (
                  <Inbox
                    agentID={item().id}
                    name={item().name}
                    role={item().role}
                    objective={item().objective}
                    schedule={whenLabel(item().schedule)}
                    manual={item().schedule.kind === "manual"}
                    access={
                      item().access === "full"
                        ? item().tools === undefined || item().tools?.includes("*")
                          ? "All tools"
                          : "Selected tools"
                        : item().access === "brief"
                          ? "Read and report"
                          : "Needs review"
                    }
                    output={item().output?.description?.trim() || "No required output"}
                    enabled={item().enabled}
                    canInspect={inspectable(item())}
                    connection={connection()}
                    box={boxes()[item().id]}
                    workspace={item().dir ? folder(item().dir!) : undefined}
                    workers={others(item().id, agents())}
                    runID={held(item(), runs())}
                    anchor={anchor(boxes()[item().id]?.conversationID)}
                    onAnchor={(value) => saveAnchor(boxes()[item().id]?.conversationID, value)}
                    onEdit={() => edit(item())}
                    onAccess={() => review(item())}
                    onOutput={() => review(item(), "output")}
                    onInspect={() => inspect(item())}
                    onToggle={() => toggle(item())}
                    onBack={leave}
                    backLabel={currentOrganization()?.name}
                  />
                )
              }}
            </Show>
            <Show when={!worker() && editingOrganization()}>
              <OrganizationEditor
                item={editingOrganization()!}
                agents={agents()}
                saving={locking()}
                error={organizationNotice()}
                provisioning={provisioning()}
                onClose={() => {
                  setEditingOrganization()
                  setOrganizationNotice("")
                }}
                onSave={saveOrganization}
                onArchive={() => archiveOrganization()}
                onProvision={saveProvisioning}
              />
            </Show>
            <Show when={!worker() && !editingOrganization() ? currentOrganization() : undefined} keyed>
              {(item) => (
                <section
                  class="routines-thread routines-organization-overview"
                  aria-labelledby={`organization-${item.id}`}
                >
                  <div class="routines-thread-head">
                    <div class="routines-thread-identity">
                      <h3 id={`organization-${item.id}`} tabIndex={-1}>
                        {item.name}
                      </h3>
                      <span>
                        {item.members.length} {item.members.length === 1 ? "worker" : "workers"}
                      </span>
                    </div>
                    <div class="routines-organization-head-actions">
                      <Button
                        size="small"
                        onClick={() =>
                          ask(
                            `Add a worker to ${item.name} (${item.id}, revision ${item.revision}). Start by asking what I want the new worker to take care of. Infer sensible defaults from my answer, ask only for choices that affect the result or access, show me a short review, then update the existing organization with Raya's native tools. Do not ask me for IDs, revisions, files, databases, or schemas.`,
                          )
                        }
                      >
                        Add worker
                      </Button>
                      <Button variant="ghost" size="small" onClick={() => editOrganization(item)}>
                        Settings
                      </Button>
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={locking()}
                        onClick={() => archiveOrganization(item)}
                      >
                        {organizationRequest()?.action === "archive" &&
                        organizationRequest()?.organizationID === item.id
                          ? "Stopping workers…"
                          : "Archive organization"}
                      </Button>
                    </div>
                  </div>
                  <div class="routines-thread-body">
                    <Show when={organizationNotice()}>
                      <p class="routines-error" role="alert">
                        {organizationNotice()}
                      </p>
                    </Show>
                    <Show when={item.purpose || item.policy}>
                      <p class="routines-organization-purpose">{item.purpose || item.policy}</p>
                    </Show>
                    <h3>Team</h3>
                    <ol class="routines-organization-members">
                      <For each={item.members}>
                        {(member) => {
                          const agent = () => agents().find((entry) => entry.id === member.agentID)
                          const supervisor = () => item.members.find((entry) => entry.agentID === member.supervisorID)
                          return (
                            <li>
                              <button type="button" onClick={() => choose(member.agentID)} disabled={!agent()}>
                                <span>{agent()?.name ?? "Archived worker"}</span>
                                <span>{member.role}</span>
                                <Show when={supervisor()}>
                                  {(lead) => (
                                    <span>
                                      Reports to{" "}
                                      {agents().find((entry) => entry.id === lead().agentID)?.name ?? lead().role}
                                    </span>
                                  )}
                                </Show>
                              </button>
                            </li>
                          )
                        }}
                      </For>
                    </ol>
                    <details class="routines-organization-details">
                      <summary>Organization details</summary>
                      <Show when={item.policy}>
                        <h3>Operating policy</h3>
                        <p class="routines-organization-policy">{item.policy}</p>
                      </Show>
                      <ReportSetting organizationID={item.id} connected={connection() === "connected"} />
                    </details>
                    <OrganizationActivity
                      id={item.id}
                      item={item}
                      agents={agents().map((agent) => ({ ...agent, state: boxes()[agent.id]?.state }))}
                      {...(workReceipt()?.organizationID === item.id
                        ? { receipt: { id: workReceipt()!.id, name: workReceipt()!.name } }
                        : {})}
                      onChoose={choose}
                      onAssigned={(worker) => setWorkReceipt({ organizationID: item.id, ...worker })}
                      onOpenSession={props.onOpenSession}
                      onPlan={(text) =>
                        ask(
                          `Assign tracked work in ${item.name} (${item.id}, revision ${item.revision}): ${text}\n\nFirst inspect the saved Routines state. Choose the best authorized assigning worker and responsible worker from their roles and standing jobs. Draft a clear outcome, expected result, and useful context. Ask me one concise question only if the route or intended result is genuinely ambiguous, then use assign_organization_work. Do not ask me for IDs or revisions.`,
                        )
                      }
                    />
                  </div>
                </section>
              )}
            </Show>
            <Show when={!worker() && !currentOrganization() && !editingOrganization()}>
              <section class="routines-start routines-thread" aria-labelledby="routines-start-title">
                <div class="routines-start-copy">
                  <span class="routines-start-kicker">Raya can run this for you</span>
                  <h3 id="routines-start-title">What would you like handled?</h3>
                  <p>
                    Describe the result in your own words. Raya will work out whether you need one worker or a team and
                    ask only for decisions that matter.
                  </p>
                </div>
                <form
                  class="routines-start-composer"
                  onSubmit={(event) => {
                    event.preventDefault()
                    begin()
                  }}
                >
                  <label class="sr-only" for="routines-start-input">
                    What should Raya handle?
                  </label>
                  <textarea
                    id="routines-start-input"
                    rows={4}
                    value={idea()}
                    placeholder="For example: Every Friday, review my accounts and send me anything that needs attention."
                    onInput={(event) => setIdea(event.currentTarget.value)}
                  />
                  <div class="routines-start-actions">
                    <Button type="submit" disabled={!idea().trim()}>
                      {props.canSubmitPlan ? "Ask Raya to plan" : "Continue in chat"}
                    </Button>
                  </div>
                </form>
                <div class="routines-start-examples" aria-label="Examples">
                  <button
                    type="button"
                    onClick={() => setIdea("Every Friday, review my accounts and report anything unusual.")}
                  >
                    Review something regularly
                  </button>
                  <button
                    type="button"
                    onClick={() => setIdea("Create a team that can divide work between specialist workers.")}
                  >
                    Build a team
                  </button>
                  <button
                    type="button"
                    onClick={() => setIdea("Keep watch for something important and tell me when it changes.")}
                  >
                    Monitor and notify me
                  </button>
                </div>
              </section>
            </Show>
          </div>
          <Show when={reviewed()} keyed>
            {(item) => (
              <Show when={section() === "output"} fallback={<AccessReview item={item} onClose={dismiss} />}>
                <OutputReview item={item} onClose={dismiss} />
              </Show>
            )}
          </Show>
          <Show when={inspection()} keyed>
            {(item) => (
              <RunReview
                id={panel}
                name={item.name}
                onClose={close}
                onOpenSession={props.onOpenSession}
                agentID={item.agentID}
                selected={item.runID}
                recovery={recovery(item, agents())}
                runs={runs()[item.agentID] ?? []}
              />
            )}
          </Show>
        </Show>
        <Show when={screen() === "assign"}>
          <Show when={editing()}>
            {(item) => (
              <div class="routines-field">
                <strong>{item().name}</strong>
                <span>Current schedule: {whenLabel(item().schedule)}</span>
                <span>{advice(item(), runs())}</span>
                <Show when={item().schedule.kind === "cron" && !timezone(item().schedule)?.trim()}>
                  <p role="note">
                    This routine has no saved timezone. Automatic runs are held until you choose the intended timezone
                    and check the preview before saving. Earlier run records are preserved.
                  </p>
                </Show>
              </div>
            )}
          </Show>
          <Show when={notice()}>
            {(message) => (
              <div role="alert">
                <p>{message()}</p>
                <Button variant="secondary" onClick={cancel}>
                  Back to routines to reload
                </Button>
              </div>
            )}
          </Show>
          <Show when={!editing()}>
            <p class="routines-lede">
              Set up a worker in three short steps. You can review everything before it is saved.
            </p>
            <div class="routines-suggest" role="list">
              <For each={templates()}>
                {(item) => (
                  <button type="button" class="routines-suggest-btn" onClick={() => apply(item)}>
                    {item.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <form
            class="routines-form"
            onSubmit={(event) => {
              event.preventDefault()
              create()
            }}
          >
            <Show
              when={!editing()}
              fallback={
                <>
                  <section class="routines-form-section" aria-labelledby="routine-job-heading">
                    <div class="routines-form-heading">
                      <h3 id="routine-job-heading">Job</h3>
                      <p>Changes apply the next time this worker runs. Earlier reports stay in its conversation.</p>
                    </div>
                    <label class="routines-field">
                      Name
                      <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
                    </label>
                    <label class="routines-field">
                      Standing job
                      <textarea
                        required
                        value={objective()}
                        onInput={(e) => setObjective(e.currentTarget.value)}
                        rows={4}
                      />
                    </label>
                  </section>
                  <section class="routines-form-section" aria-labelledby="routine-schedule-heading">
                    <div class="routines-form-heading">
                      <h3 id="routine-schedule-heading">Schedule</h3>
                      <p>Review is required only when this schedule changes.</p>
                    </div>
                    <ScheduleEditor value={draft()} onChange={setDraft} disabled={saving()} />
                  </section>
                </>
              }
            >
              <RoutineSetup
                step={setup()}
                name={name()}
                job={objective()}
                draft={draft()}
                output={output()}
                role={roleOpt().label}
                access={workOpt().label}
                dir={dir()}
                budget={budget()}
                saving={saving()}
                onStep={setSetup}
                onName={setName}
                onJob={setObjective}
                onDraft={setDraft}
                onBudget={setBudget}
              />
            </Show>

            <Show when={request()?.key === key() && preview()?.error}>
              {(message) => (
                <p class="routines-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={confirmed() && preview()?.schedule}>
              {(schedule) => (
                <div class="routines-schedule-review" role="status" aria-live="polite">
                  <strong>{editing() ? "Ready to save" : "Ready to assign"}</strong>
                  <span>{schedule().kind === "once" ? "Once at the time below" : whenLabel(schedule())}</span>
                  <Show when={preview()?.timezone ?? timezone(schedule())}>
                    <span>Timezone: {preview()?.timezone ?? timezone(schedule())}</span>
                  </Show>
                  <Show when={schedule().kind === "cron"}>
                    <span>Next runs</span>
                  </Show>
                  <For each={preview()?.occurrences ?? []}>
                    {(at) => (
                      <span>
                        {new Date(Number(at)).toLocaleString(undefined, {
                          timeZone: preview()?.timezone ?? timezone(schedule()),
                          timeZoneName: "short",
                        })}
                      </span>
                    )}
                  </For>
                  <span class="routines-hint">Raya must be running at the scheduled time.</span>
                </div>
              )}
            </Show>

            <Show when={settings()}>
              <details class="routines-advanced">
                <summary>Routine settings</summary>
                <p class="routines-hint">Adjust the result, worker, access, and files when the defaults do not fit.</p>
                <div class="routines-field">
                  <span>Worker role</span>
                  <Select
                    options={[...roles]}
                    current={roleOpt()}
                    label={(item) => item.label}
                    value={(item) => item.id}
                    onSelect={(item) => item && pick(item.id)}
                    variant="secondary"
                    size="small"
                  />
                </div>
                <Show when={role() === "custom"}>
                  <label class="routines-field">
                    Custom role
                    <input
                      value={custom()}
                      onInput={(e) => setCustom(e.currentTarget.value)}
                      placeholder="Researcher"
                    />
                  </label>
                </Show>
                <Show when={!editing()}>
                  <OutputEditor value={output()} onChange={setOutput} disabled={saving()} />
                </Show>
                <div class="routines-field">
                  <span>Agent</span>
                  <Select
                    options={picks()}
                    current={current()}
                    label={(item) => item.label}
                    value={(item) => item.key}
                    onSelect={(item) => item && setMode(item.key)}
                    variant="secondary"
                    size="small"
                  />
                  <p class="routines-hint">
                    Uses the same agent as chat unless you choose another.{" "}
                    <button
                      type="button"
                      class="routines-inline"
                      onClick={() => vscode.postMessage({ type: "openSettingsPanel", tab: "agentBehaviour" })}
                    >
                      Open settings
                    </button>
                  </p>
                </div>
                <Show when={!editing()}>
                  <div class="routines-field">
                    <span>Tool access</span>
                    <Select
                      options={work}
                      current={workOpt()}
                      label={(item) => item.label}
                      value={(item) => item.id}
                      onSelect={(item) => item && setAccess(item.id)}
                      variant="secondary"
                      size="small"
                    />
                    <p class="routines-hint">{workOpt().description}</p>
                  </div>
                </Show>
                <Show when={role() === "accountant"}>
                  <div class="routines-consent">
                    <Checkbox checked={money()} onChange={setMoney}>
                      Allow money records
                    </Checkbox>
                    <p class="routines-hint">Receipts, ledgers, and invoices. This does not allow payments.</p>
                  </div>
                </Show>
                <Show when={role() === "inbox"}>
                  <div class="routines-consent">
                    <Checkbox checked={messages()} onChange={setMessages}>
                      Allow messages
                    </Checkbox>
                    <p class="routines-hint">
                      Read the inbox and draft replies. Sending still requires your instruction.
                    </p>
                  </div>
                </Show>
                <div class="routines-field">
                  <label for="routine-workspace">Workspace folder</label>
                  <div class="routines-pick">
                    <input
                      id="routine-workspace"
                      value={dir()}
                      onInput={(e) => setDir(e.currentTarget.value)}
                      placeholder="Choose or type a folder"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      onClick={() => {
                        const id = crypto.randomUUID()
                        setWait(id)
                        vscode.postMessage({ type: "requestFolderPicker", requestId: id })
                      }}
                    >
                      Choose
                    </Button>
                  </div>
                  <p class="routines-hint">New files are kept inside this folder.</p>
                </div>
                <label class="routines-field">
                  <span class="routines-label">
                    Per-run model-cost limit <span class="routines-optional">(optional)</span>
                  </span>
                  <input
                    type="number"
                    min="0.01"
                    max="1000000"
                    step="0.01"
                    value={budget()}
                    onInput={(e) => setBudget(e.currentTarget.value)}
                    placeholder="No saved limit"
                  />
                  <p class="routines-hint">Raya stops the run when its model cost reaches this amount.</p>
                </label>
                <label class="routines-field">
                  <span class="routines-label">
                    Plan file <span class="routines-optional">(optional)</span>
                  </span>
                  <input
                    value={plan()}
                    onInput={(e) => setPlan(e.currentTarget.value)}
                    placeholder="Path to a .md plan"
                  />
                </label>
              </details>

              <div class="routines-submit">
                <span class="routines-hint">{submitHint()}</span>
                <Button type="submit" disabled={submitBlocked()}>
                  {caption()}
                </Button>
              </div>
            </Show>
          </form>
        </Show>
      </div>
    </div>
  )
}

export default RoutinesView
