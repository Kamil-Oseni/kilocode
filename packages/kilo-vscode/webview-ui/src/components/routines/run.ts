type Run = {
  status: "running" | "complete" | "blocked" | "error"
  blockedReason?: string
}

export type Execution = { state: "starting" | "active" | "recovery"; sessionID?: string; runID?: string }

type Evidence = {
  at: number
  trigger?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["trigger"]
}

export function reason(run: Evidence) {
  const trigger = run.trigger
  const start = `Startup began ${stamp(run.at)}`
  if (!trigger) return `Trigger not recorded · ${start}`
  if (trigger.kind === "manual") return `Manual start · ${start}`
  if (trigger.kind === "event")
    return `Event: ${trigger.source}${trigger.filter === undefined ? "" : `, filter ${JSON.stringify(trigger.filter)}`} · ${start}`
  return `Scheduled for ${stamp(Number(trigger.scheduledAt), trigger.tz)} · ${start}`
}

function stamp(at: number, tz?: string) {
  if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) return "an unknown time"
  try {
    return new Date(at).toLocaleString(undefined, { timeZone: tz, timeZoneName: "short" })
  } catch {
    return `${new Date(at).toLocaleString(undefined, { timeZoneName: "short" })} (saved timezone unavailable)`
  }
}

function waiting(run?: Run) {
  return run?.status === "blocked" && run.blockedReason === "waiting on you"
}

export function select<T extends Run>(runs: readonly T[]) {
  return runs.findLast((run) => run.status === "running" || waiting(run)) ?? runs.at(-1)
}

export function action(run?: Run, busy = false, execution?: Execution) {
  if (!busy && execution) return execution.sessionID ? "open" : execution.state === "recovery" ? "review" : "running"
  if (busy || run?.status === "running") return "running"
  if (waiting(run)) return "open"
  return "start"
}
