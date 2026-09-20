import type { SessionInfo } from "../../types/messages"

export type HistoryTaskState = "idle" | "working" | "waiting"

function folder(path?: string) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1)
}

export function describe(session: SessionInfo, state: HistoryTaskState, current: boolean) {
  const project = folder(session.directory) ?? session.projectID ?? "Current project"
  const files = session.summary?.files ?? 0
  const result =
    files > 0
      ? `${files} ${files === 1 ? "file" : "files"} changed`
      : session.revert
        ? "Review changes retained"
        : "Conversation retained"
  if (state === "waiting") return { project, result, status: "Needs your answer", action: "Open to respond" }
  if (state === "working") return { project, result, status: "Working", action: "Open to monitor" }
  if (current) return { project, result, status: "Open here", action: "Continue task" }
  return { project, result, status: "Ready", action: "Resume task" }
}

export function repository(url?: string | null) {
  if (!url) return "Project metadata unavailable"
  const clean = url.replace(/\.git$/i, "").replace(/[\\/]+$/, "")
  return clean.split(/[\\/]/).filter(Boolean).at(-1) ?? url
}
