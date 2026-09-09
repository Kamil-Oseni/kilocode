import type { KiloClient, KilocodeGoalGetResponse, ToolPart } from "@kilocode/sdk/v2/client"
import type { GoalEvidenceResultMessage } from "../../webview-ui/src/types/messages/extension-messages"
import type { GoalEvidence } from "../shared/goal"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import { inspection } from "@opencode-ai/core/kilocode/evidence-inspection"

const coverage = (part: ToolPart) =>
  part.tool === "read" && part.state.status === "completed" ? inspection(part.state.metadata) : undefined

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256

const reference = (
  value: unknown,
): value is Required<Pick<GoalEvidence, "sessionID" | "messageID" | "partID" | "callID">> => {
  if (!value || typeof value !== "object") return false
  const ref = value as Record<string, unknown>
  return [ref.sessionID, ref.messageID, ref.partID, ref.callID].every(identifier)
}

const selection = (goal: KilocodeGoalGetResponse | undefined, at: unknown) => {
  if (!goal || at === undefined) return goal
  if (typeof at !== "number" || !Number.isFinite(at)) return
  const matches = [goal, ...(goal.history ?? [])].filter((item) => item.createdAt === at)
  return matches.length === 1 ? matches[0] : undefined
}

const revision = (goal: NonNullable<ReturnType<typeof selection>>, id: unknown) => {
  if (id === undefined) return goal
  if (!identifier(id)) return
  const matches = goal.revisions?.filter((item) => item.id === id) ?? []
  return matches.length === 1 ? matches[0] : undefined
}

const receipt = (
  audit: KilocodeGoalGetResponse["audit"],
  ref: Omit<GoalEvidence, "summary" | "record">,
  part: Parameters<typeof digest>[0],
) => {
  const accepted = audit?.requirements
    .flatMap((item) => item.evidence)
    .find(
      (item) =>
        item.sessionID === ref.sessionID &&
        item.messageID === ref.messageID &&
        item.partID === ref.partID &&
        item.callID === ref.callID,
    )
  if (!accepted?.record) return "unrecorded"
  return accepted.record.version === 1 && accepted.record.digest === digest(part) ? "matching" : "changed"
}

export async function evidence(input: {
  client?: KiloClient | null
  directory?: string
  message: {
    type?: unknown
    sessionID?: unknown
    requestID?: unknown
    evidence?: unknown
    createdAt?: unknown
    revisionID?: unknown
  }
  post: (message: GoalEvidenceResultMessage) => void
}) {
  const request = input.message
  const sessionID = request.sessionID
  const requestID = request.requestID
  if (!identifier(sessionID) || !identifier(requestID)) return
  const reply = (result: Pick<GoalEvidenceResultMessage, "source" | "error">) =>
    input.post({
      type: "goalEvidenceResult",
      sessionID,
      requestID,
      ...result,
    })
  const ref = request.evidence
  if (!input.client || !reference(ref)) {
    reply({ error: "This evidence has no complete source identity, or the backend is unavailable." })
    return
  }
  try {
    const goal = await input.client.kilocode.goal.get({ sessionID, directory: input.directory }, { throwOnError: true })
    const retained = selection(goal.data, request.createdAt)
    if (!retained) {
      reply({
        error: "The selected goal is missing or ambiguous in retained history. Refresh the goal history and try again.",
      })
      return
    }
    const selected = revision(retained, request.revisionID)
    if (!selected) {
      reply({ error: "The selected goal revision is missing or ambiguous. Refresh its history and try again." })
      return
    }
    const refs = [selected.audit, selected.auditAttempt].flatMap(
      (audit) => audit?.requirements.flatMap((item) => item.evidence) ?? [],
    )
    if (
      !refs.some(
        (item) =>
          item.sessionID === ref.sessionID &&
          item.messageID === ref.messageID &&
          item.partID === ref.partID &&
          item.callID === ref.callID,
      )
    ) {
      reply({
        error:
          "The goal no longer contains this exact evidence reference. Refresh the goal and review its current audit.",
      })
      return
    }
    const result = await input.client.session.message(
      { sessionID: ref.sessionID, messageID: ref.messageID, directory: input.directory },
      { throwOnError: true },
    )
    if (result.data.info.id !== ref.messageID || result.data.info.sessionID !== ref.sessionID) {
      reply({ error: "The backend returned a different source message. The result was not displayed." })
      return
    }
    const parts = result.data.parts.filter(
      (part) =>
        part.id === ref.partID &&
        part.messageID === ref.messageID &&
        part.sessionID === ref.sessionID &&
        part.type === "tool" &&
        part.callID === ref.callID,
    )
    const part = parts[0]
    if (parts.length !== 1 || !part || part.type !== "tool") {
      reply({ error: "The cited tool result is missing or ambiguous. No substitute result was selected." })
      return
    }
    const state = part.state
    const status = receipt(selected.audit, ref, part)
    if (status === "changed") {
      reply({
        error:
          "This tool result has changed since the accepted audit. Its current content was not displayed as the verified source.",
      })
      return
    }
    const args = JSON.stringify(state.input, null, 2)
    const output =
      state.status === "completed"
        ? state.output
        : state.status === "error"
          ? state.error
          : "No completed output is recorded."
    const metadata = JSON.stringify(("metadata" in state ? state.metadata : {}) ?? {}, null, 2)
    const limit = 50_000
    reply({
      source: {
        receipt: status,
        inspection: coverage(part),
        tool: part.tool,
        status: state.status,
        input: args.slice(0, limit),
        output: output.slice(0, limit),
        metadata: metadata.slice(0, limit),
        truncated: [args, output, metadata].some((text) => text.length > limit),
      },
    })
  } catch {
    reply({ error: "Could not load the cited tool result. Check the backend connection and try again." })
  }
}
