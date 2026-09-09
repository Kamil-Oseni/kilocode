import type { KiloClient, KilocodeGoalUpdateResponse } from "@kilocode/sdk/v2/client"
import type { GoalEditedMessage, GoalStoppedMessage } from "../../webview-ui/src/types/messages/extension-messages"
import type { GoalState } from "../shared/goal"
import { valid, equal } from "../shared/goal-criteria"

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value)

function operations(value: unknown): string | undefined {
  if (value === undefined) return
  const fallback = "Saved delegated cancellation attempts could not be verified."
  if (!Array.isArray(value)) return fallback
  if (!value.length) return "No delegated cancellation attempts were recorded."
  const outcomes: Record<string, string> = {
    accepted: "input cancellation accepted; external termination was not verified",
    "not-selected": "not selected by the registry",
    cancelled: "registry reported the job cancelled",
    completed: "registry reported the job already completed",
    error: "registry reported a job error",
    running: "registry reported the job still running",
  }
  const ids = new Set<string>()
  const rows = value.map((item: unknown) => {
    if (!item || typeof item !== "object") return
    const entry = item as Record<string, unknown>
    if (
      !["id", "jobID", "revision"].every((field) => identifier(entry[field])) ||
      ids.has(String(entry.id)) ||
      !finite(entry.at) ||
      ("messageID" in entry && !identifier(entry.messageID)) ||
      !["requested", "observed"].includes(String(entry.phase))
    )
      return
    ids.add(String(entry.id))
    const target = `job ${entry.jobID}${"messageID" in entry ? `, input ${entry.messageID}` : ""}`
    if (entry.phase === "requested") return `${target}: requested, no result recorded`
    if (
      !finite(entry.observedAt) ||
      typeof entry.result !== "string" ||
      !Object.hasOwn(outcomes, entry.result) ||
      ("messageID" in entry ? !["accepted", "not-selected"].includes(entry.result) : entry.result === "accepted")
    )
      return
    return `${target}: ${outcomes[entry.result]}`
  })
  if (rows.some((row) => row === undefined)) return fallback
  return `Saved delegated cancellation attempts: ${rows.join("; ")}.`
}

function background(value: unknown): string | undefined {
  if (value === undefined) return
  const fallback = "Related background work could not be checked. External work may still finish."
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "checked" ||
    !("at" in value) ||
    typeof value.at !== "number" ||
    !Number.isFinite(new Date(value.at).getTime()) ||
    !("jobs" in value) ||
    !Array.isArray(value.jobs)
  )
    return fallback
  const jobs = value.jobs.map((job: unknown) => {
    if (
      !job ||
      typeof job !== "object" ||
      !("id" in job) ||
      typeof job.id !== "string" ||
      !("type" in job) ||
      typeof job.type !== "string" ||
      ("title" in job && typeof job.title !== "string")
    )
      return undefined
    return `${"title" in job ? job.title : job.type} (${job.id})`
  })
  if (jobs.some((job) => job === undefined)) return fallback
  const time = new Date(value.at).toLocaleString()
  return jobs.length
    ? `Related background work running at the stop check (${time}): ${jobs.join("; ")}. This is a saved snapshot; their current state may differ.`
    : `No related background jobs were running at the stop check (${time}). External work was not checked.`
}

export async function stopResult(
  client: KiloClient,
  sessionID: string,
  directory?: string,
): Promise<string | undefined> {
  try {
    const result = await client.kilocode.goal.stopResult({ sessionID, directory })
    if (result.response.status === 404) return
    const receipt = result.data
    if (
      result.error ||
      !receipt ||
      receipt.sessionID !== sessionID ||
      !identifier(receipt.intent) ||
      !finite(receipt.at) ||
      !Number.isFinite(new Date(receipt.at).getTime()) ||
      !["requested", "cleared", "finished"].includes(receipt.phase) ||
      (receipt.phase === "finished" && (typeof receipt.interrupted !== "boolean" || !finite(receipt.finishedAt)))
    )
      return "The previous goal-stop result could not be verified."
    const outcome =
      receipt.phase === "requested"
        ? "requested; tracking removal and the worker's outcome are unconfirmed."
        : receipt.phase === "cleared"
          ? "tracking stopped; the worker's outcome is unconfirmed."
          : receipt.interrupted
            ? "tracking stopped and its worker was interrupted. External or background work may still finish."
            : "tracking stopped; this request did not interrupt the parent worker."
    const detail = [
      receipt.phase === "finished" ? background(receipt.background) : undefined,
      operations(receipt.operations),
    ]
      .filter(Boolean)
      .join(" ")
    return `Last goal stop (${new Date(receipt.at).toLocaleString()}): ${outcome}${detail ? ` ${detail}` : ""}`
  } catch {
    return "The previous goal-stop result could not be loaded. Reconnect to check it."
  }
}

export async function stopGoal(input: {
  client: KiloClient | null | undefined
  directory?: string
  message: { sessionID?: unknown; requestID?: unknown; expectedIntent?: unknown }
  post: (message: GoalStoppedMessage) => void
}) {
  const message = input.message
  if (!identifier(message.requestID) || !identifier(message.sessionID)) return
  const reply = { type: "goalStopped" as const, requestID: message.requestID, sessionID: message.sessionID }
  if (!identifier(message.expectedIntent)) {
    input.post({ ...reply, error: "Review the goal before stopping it." })
    return
  }
  if (!input.client) {
    input.post({ ...reply, error: "Raya is disconnected. Reconnect and review the goal before trying again." })
    return
  }
  try {
    const result = await input.client.kilocode.goal.stop({
      sessionID: message.sessionID,
      directory: input.directory,
      expectedIntent: message.expectedIntent,
    })
    const receipt = result.data
    if (
      result.error ||
      !receipt ||
      receipt.sessionID !== message.sessionID ||
      receipt.intent !== message.expectedIntent ||
      !finite(receipt.at) ||
      !["cleared", "finished"].includes(receipt.phase) ||
      (receipt.phase === "finished" && (typeof receipt.interrupted !== "boolean" || !finite(receipt.finishedAt)))
    ) {
      input.post({
        ...reply,
        error:
          result.response.status === 409
            ? "The goal changed since you reviewed it. Cancel and review the refreshed goal before stopping it."
            : "Could not confirm that goal tracking stopped. Cancel and review the refreshed goal before trying again.",
      })
      return
    }
    const detail = [
      receipt.phase === "finished" ? background(receipt.background) : undefined,
      operations(receipt.operations),
    ]
      .filter(Boolean)
      .join(" ")
    input.post({
      ...reply,
      cleared: true,
      worker: receipt.phase === "cleared" ? "unconfirmed" : receipt.interrupted ? "interrupted" : "preserved",
      ...(detail ? { background: detail } : {}),
    })
  } catch {
    input.post({
      ...reply,
      error:
        "The connection failed before stopping was confirmed. Cancel and review the refreshed goal before trying again.",
    })
  }
}

function matches(
  goal: KilocodeGoalUpdateResponse | undefined,
  objective: string,
  status?: "active" | "paused",
  accept?: boolean,
): goal is KilocodeGoalUpdateResponse {
  return (
    !!goal &&
    goal.objective === objective &&
    (status === undefined || goal.status === status) &&
    identifier(goal.intent) &&
    (accept
      ? goal.status === "complete" && goal.review?.status === "accepted"
      : ["active", "paused", "blocked"].includes(goal.status)) &&
    finite(goal.createdAt) &&
    finite(goal.updatedAt) &&
    finite(goal.usage?.turns) &&
    finite(goal.usage?.continuations) &&
    finite(goal.usage?.toolCalls) &&
    Array.isArray(goal.progress)
  )
}

function confirmation(
  goal: KilocodeGoalUpdateResponse | undefined,
  objective: string,
  status: "active" | "paused" | undefined,
  accept: boolean,
  criteria: GoalState["criteria"],
) {
  return matches(goal, objective, status, accept) && (criteria === undefined || equal(goal.criteria, criteria))
}

function guidance(message: { status?: unknown; accept?: unknown }) {
  return message.status === undefined && !message.accept
    ? "Copy your draft, then cancel and reopen to review the saved goal."
    : "Review the refreshed goal before trying again."
}

export async function editGoal(input: {
  client: KiloClient | null | undefined
  directory?: string
  message: {
    type: string
    sessionID?: unknown
    requestID?: unknown
    objective?: unknown
    expectedIntent?: unknown
    status?: unknown
    criteria?: unknown
    accept?: unknown
  }
  post: (message: GoalEditedMessage) => void
}) {
  const message = input.message
  if (!identifier(message.requestID) || !identifier(message.sessionID)) return
  const reply = { type: "goalEdited" as const, requestID: message.requestID, sessionID: message.sessionID }
  if (message.accept !== undefined && message.accept !== true) {
    input.post({ ...reply, error: "Use the reviewed goal's acceptance action." })
    return
  }
  if (message.criteria !== undefined && !valid(message.criteria)) {
    input.post({ ...reply, error: "Use 1-20 criteria with unique IDs, descriptions and verification instructions." })
    return
  }
  const recovery = guidance(message)
  if (message.status !== undefined && message.status !== "active" && message.status !== "paused") {
    input.post({ ...reply, error: "Choose pause or resume for the goal status." })
    return
  }
  if (!identifier(message.expectedIntent) || typeof message.objective !== "string" || !message.objective.trim()) {
    input.post({ ...reply, error: `The goal change is incomplete. ${recovery}` })
    return
  }
  if (!input.client) {
    input.post({
      ...reply,
      error: `Raya is disconnected. Reconnect before trying again. ${recovery}`,
    })
    return
  }
  try {
    const result = await input.client.kilocode.goal.update({
      sessionID: message.sessionID,
      directory: input.directory,
      objective: message.objective.trim(),
      expectedIntent: message.expectedIntent,
      status: message.status,
      criteria: message.criteria,
      accept: message.accept === true ? true : undefined,
    })
    if (result.error) {
      input.post({
        ...reply,
        error:
          result.response.status === 409
            ? `The goal changed since you reviewed it. ${recovery}`
            : `Could not confirm the goal update. ${recovery}`,
      })
      return
    }
    const goal = result.data
    if (!confirmation(goal, message.objective.trim(), message.status, message.accept === true, message.criteria)) {
      input.post({
        ...reply,
        error: `The confirmation did not match this change. ${recovery}`,
      })
      return
    }
    input.post({ ...reply, goal: goal as GoalState })
  } catch {
    input.post({
      ...reply,
      error: `The connection failed before the update was confirmed. ${recovery}`,
    })
  }
}
