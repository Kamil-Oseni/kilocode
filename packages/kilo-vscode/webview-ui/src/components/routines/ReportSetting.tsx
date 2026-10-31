import { Component, createEffect, createSignal, on, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { routineFailure } from "../../utils/routine-recovery"

type Quiet = { start: number; end: number; timezone: string }
type Target = "global" | "agent" | "organization"

function detail(on: boolean, quiet: Quiet | undefined, target: Target, clock: (minute: number) => string) {
  if (!on) {
    if (target === "global") return "Allow any eligible Routine worker to report to its own conversation."
    if (target === "organization") return "Allow workers in this organization to report to their conversations."
    return "Allow this worker to report to this conversation."
  }
  if (!quiet) {
    if (target === "global") return "Eligible Routine workers can report to their own conversations at any time."
    if (target === "organization") return "Workers in this organization can report at any time."
    return "This worker can report at any time."
  }
  return `New reports are held ${clock(quiet.start)}–${clock(quiet.end)} (${quiet.timezone}).`
}

export const ReportSetting: Component<{
  global?: true
  agentID?: string
  organizationID?: string
  connected: boolean
}> = (props) => {
  const vscode = useVSCode()
  const [busy, setBusy] = createSignal(true)
  const [known, setKnown] = createSignal(false)
  const [enabled, setEnabled] = createSignal(false)
  const [quiet, setQuiet] = createSignal<Quiet>()
  const [editing, setEditing] = createSignal(false)
  const [start, setStart] = createSignal("22:00")
  const [end, setEnd] = createSignal("07:00")
  const [error, setError] = createSignal("")
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  let id = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: "load" | "enable" | "disable" | "save" = "load"
  const clear = () => {
    clearTimeout(timer)
    timer = undefined
    id = ""
    setBusy(false)
  }
  const clock = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
  const minute = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value)
    if (!match) return undefined
    const result = Number(match[1]) * 60 + Number(match[2])
    return Number.isInteger(result) && result >= 0 && result < 1440 ? result : undefined
  }
  const request = (
    action: "load" | "enable" | "disable" | "save",
    policy?: { start: number; end: number; timezone: string } | null,
  ) => {
    if (action !== "load" && (busy() || !known())) return
    clear()
    if ([props.global === true, !!props.agentID, !!props.organizationID].filter(Boolean).length !== 1) {
      setBusy(false)
      setError("Reload this report setting.")
      return
    }
    if (!props.connected) {
      setBusy(false)
      setError("Reconnect to review report access.")
      return
    }
    id = crypto.randomUUID()
    const current = id
    pending = action
    setBusy(true)
    setKnown(false)
    setError("")
    const scope = props.global
      ? { global: true as const }
      : props.agentID
        ? { agentID: props.agentID }
        : { organizationID: props.organizationID }
    timer = setTimeout(() => {
      if (id !== current) return
      clear()
      setError("Report settings could not be confirmed. Retry to check the saved setting.")
    }, 30_000)
    vscode.postMessage({
      type: "routineContactDestination",
      requestID: id,
      ...scope,
      action,
      ...(action === "save" ? { quiet: policy ?? null } : {}),
    })
  }
  const receive = (msg: ExtensionMessage) => {
    if (
      msg.type !== "routineContactDestination" ||
      msg.global !== props.global ||
      msg.agentID !== props.agentID ||
      msg.organizationID !== props.organizationID ||
      !id ||
      msg.requestID !== id
    )
      return
    clear()
    if (msg.error) {
      setError(routineFailure(msg.error, msg.recovery))
      return
    }
    setEnabled(msg.enabled === true)
    setKnown(true)
    const policy = msg.quiet
    if (
      policy &&
      Number.isInteger(policy.start) &&
      policy.start >= 0 &&
      policy.start < 1440 &&
      Number.isInteger(policy.end) &&
      policy.end >= 0 &&
      policy.end < 1440 &&
      policy.start !== policy.end &&
      typeof policy.timezone === "string"
    ) {
      setQuiet(policy)
      setStart(clock(policy.start))
      setEnd(clock(policy.end))
    } else {
      setQuiet(undefined)
    }
    if (pending === "save") setEditing(false)
    setError("")
  }
  const unsub = vscode.onMessage(receive)
  onCleanup(() => {
    clear()
    unsub()
  })
  createEffect(
    on(
      () => [props.connected, props.global, props.agentID, props.organizationID] as const,
      () => {
        clear()
        setKnown(false)
        setEnabled(false)
        setQuiet(undefined)
        setEditing(false)
        request("load")
      },
    ),
  )
  const toggle = () => {
    if (busy() || !known() || !props.connected) return
    setEditing(false)
    request(enabled() ? "disable" : "enable")
  }
  const save = () => {
    if (busy() || !known() || !props.connected) return
    const from = minute(start())
    const until = minute(end())
    if (from === undefined || until === undefined || from === until) {
      setError("Choose two different quiet-hour times.")
      return
    }
    request("save", { start: from, end: until, timezone: quiet()?.timezone ?? timezone })
  }
  const target = (): Target => (props.global ? "global" : props.organizationID ? "organization" : "agent")
  const heading = `routine-info-reports-${props.global ? "global" : (props.agentID ?? props.organizationID)}`
  return (
    <section class="routines-info-section" aria-labelledby={heading}>
      <h3 id={heading}>Reports to you</h3>
      <div class="routines-info-setting">
        <div>
          <strong>Raya inbox</strong>
          <span>
            {known() ? detail(enabled(), quiet(), target(), clock) : "Check report access before changing it."}
          </span>
        </div>
        <Button
          size="small"
          variant="secondary"
          disabled={busy() || !known() || !props.connected}
          aria-disabled={busy() || !known() || !props.connected}
          aria-busy={busy()}
          onClick={toggle}
        >
          {busy() ? "Checking..." : enabled() ? "Stop reports" : "Allow reports"}
        </Button>
      </div>
      {known() && enabled() && !editing() ? (
        <Button size="small" variant="ghost" disabled={busy()} onClick={() => setEditing(true)}>
          {quiet() ? "Edit quiet hours" : "Set quiet hours"}
        </Button>
      ) : null}
      {known() && enabled() && editing() ? (
        <div class="routines-info-quiet" role="group" aria-label="Quiet hours">
          <label>
            From
            <input type="time" value={start()} onInput={(event) => setStart(event.currentTarget.value)} />
          </label>
          <label>
            Until
            <input type="time" value={end()} onInput={(event) => setEnd(event.currentTarget.value)} />
          </label>
          <span>{quiet()?.timezone ?? timezone}</span>
          <div class="routines-info-quiet-actions">
            <Button size="small" variant="secondary" aria-disabled={busy()} onClick={save}>
              {busy() ? "Saving..." : "Save quiet hours"}
            </Button>
            {quiet() ? (
              <Button
                size="small"
                variant="ghost"
                aria-disabled={busy()}
                onClick={() => (busy() ? undefined : request("save", null))}
              >
                No quiet hours
              </Button>
            ) : null}
            <Button size="small" variant="ghost" disabled={busy()} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error() ? (
        <div class="routines-info-retry">
          <p class="routines-error" role="alert">
            {error()}
          </p>
          <Button
            size="small"
            variant="ghost"
            disabled={!props.connected}
            aria-disabled={busy() || !props.connected}
            onClick={() => request("load")}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  )
}
