import { Component, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"

type Quiet = { start: number; end: number; timezone: string }

function detail(on: boolean, quiet: Quiet | undefined, group: boolean, clock: (minute: number) => string) {
  if (!on)
    return group
      ? "Allow workers in this organization to send reports to their conversations."
      : "Allow this worker to send reports to this conversation."
  if (!quiet)
    return group
      ? "Workers in this organization can send reports to their conversations at any time."
      : "This worker can send reports to this conversation at any time."
  return `New ${group ? "organization " : ""}reports are held ${clock(quiet.start)}–${clock(quiet.end)} (${quiet.timezone}).`
}

export const ReportSetting: Component<{ agentID?: string; organizationID?: string; connected: boolean }> = (props) => {
  const vscode = useVSCode()
  const [busy, setBusy] = createSignal(true)
  const [enabled, setEnabled] = createSignal(false)
  const [quiet, setQuiet] = createSignal<Quiet>()
  const [editing, setEditing] = createSignal(false)
  const [start, setStart] = createSignal("22:00")
  const [end, setEnd] = createSignal("07:00")
  const [error, setError] = createSignal("")
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  let id = ""
  let pending: "load" | "enable" | "disable" | "save" = "load"
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
    if (!!props.agentID === !!props.organizationID) {
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
    pending = action
    setBusy(true)
    setError("")
    const scope = props.agentID ? { agentID: props.agentID } : { organizationID: props.organizationID }
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
      msg.agentID !== props.agentID ||
      msg.organizationID !== props.organizationID ||
      msg.requestID !== id
    )
      return
    setBusy(false)
    if (msg.error) {
      setError(msg.error)
      return
    }
    setEnabled(msg.enabled === true)
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
  onCleanup(unsub)
  onMount(() => request("load"))
  const toggle = () => {
    if (busy() || !props.connected) return
    setEditing(false)
    request(enabled() ? "disable" : "enable")
  }
  const save = () => {
    if (busy()) return
    const from = minute(start())
    const until = minute(end())
    if (from === undefined || until === undefined || from === until) {
      setError("Choose two different quiet-hour times.")
      return
    }
    request("save", { start: from, end: until, timezone: quiet()?.timezone ?? timezone })
  }
  const group = () => !!props.organizationID
  const heading = `routine-info-reports-${props.agentID ?? props.organizationID}`
  return (
    <section class="routines-info-section" aria-labelledby={heading}>
      <h3 id={heading}>Reports to you</h3>
      <div class="routines-info-setting">
        <div>
          <strong>Raya inbox</strong>
          <span>{detail(enabled(), quiet(), group(), clock)}</span>
        </div>
        <Button
          size="small"
          variant="secondary"
          disabled={!props.connected}
          aria-disabled={busy() || !props.connected}
          aria-busy={busy()}
          onClick={toggle}
        >
          {busy() ? "Checking..." : enabled() ? "Stop reports" : "Allow reports"}
        </Button>
      </div>
      {enabled() && !editing() ? (
        <Button size="small" variant="ghost" disabled={busy()} onClick={() => setEditing(true)}>
          {quiet() ? "Edit quiet hours" : "Set quiet hours"}
        </Button>
      ) : null}
      {enabled() && editing() ? (
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
