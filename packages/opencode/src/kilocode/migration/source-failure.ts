import { z } from "zod"
import { codes as offline } from "@opencode-ai/core/kilocode/source-offline-frame"
import { codes as stages } from "./source-stage"
import { codes as images } from "../daemon/image-diagnostic"

const codes = new Set([
  ...offline,
  ...stages,
  ...images,
  "RAYA_SOURCE_STATE_SCOPE_UNCOVERED",
  "RAYA_SERVE_WATCHDOG_FAILED",
  "RAYA_SERVE_ADMISSION_FAILED",
  "RAYA_SERVE_TASK_TIMEOUT",
  "RAYA_SERVE_TASK_FAILED",
  "RAYA_SERVE_SOURCE_LISTENER_FAILED",
  "RAYA_SERVE_HTTP_DRAIN_FAILED",
  "RAYA_SERVE_SCHEDULER_DRAIN_FAILED",
  "RAYA_SERVE_DAEMON_LISTENER_FAILED",
  "RAYA_SERVE_REPORT_FAILED",
  "EACCES",
  "EPERM",
  "ENOENT",
  "EEXIST",
  "EBUSY",
  "EBADF",
  "ENOTDIR",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EINVAL",
  "ELOOP",
  "EIO",
  "ETIMEDOUT",
  "ECANCELED",
  "EUNKNOWN",
  "SQLITE_ERROR",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_MISUSE",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "SQLITE_CONSTRAINT",
])
const issues = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
])
const fields = new Set([
  "sql",
  "json",
  "memory",
  "schema",
  "workspaces",
  "artifacts",
  "exports",
  "host",
  "preferences",
  "archives",
  "review",
])
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined // Uninspectable failures supply no diagnostic data.
  }
}

function kind(error: unknown) {
  try {
    return error instanceof AggregateError
      ? "AggregateError"
      : error instanceof z.ZodError
        ? "ZodError"
        : error instanceof TypeError
          ? "TypeError"
          : error instanceof RangeError
            ? "RangeError"
            : error instanceof SyntaxError
              ? "SyntaxError"
              : error instanceof Error
                ? "Error"
                : "Unknown"
  } catch {
    return "Unknown"
  }
}

/** Fixed classifications only: messages, stacks, values, arbitrary keys and paths are never published. */
export function failure(error: unknown) {
  const seen = new Set<unknown>()
  const queue = [{ error, depth: 0 }]
  const errors: {
    type: string
    depth: number
    code?: string
    stage?: number
    issues?: { code: string; path: (string | number)[] }[]
  }[] = []
  let truncated = false
  while (queue.length && errors.length < 32) {
    const item = queue.shift()!
    if (seen.has(item.error)) {
      truncated = true
      continue
    }
    seen.add(item.error)
    const type = kind(item.error)
    const code = own(item.error, "code")
    const entry: (typeof errors)[number] = { type, depth: item.depth }
    if (typeof code === "string" && codes.has(code)) {
      entry.code = code
      const stage = own(item.error, "stage")
      if (
        ["RAYA_SERVE_TASK_TIMEOUT", "RAYA_SERVE_TASK_FAILED"].includes(code) &&
        typeof stage === "number" &&
        Number.isSafeInteger(stage) &&
        stage >= 1 &&
        stage <= 64
      )
        entry.stage = stage
    }
    if (type === "ZodError") {
      const raw = own(item.error, "issues")
      if (Array.isArray(raw)) {
        if (raw.length > 8) truncated = true
        entry.issues = raw.slice(0, 8).map((issue) => {
          const code = own(issue, "code")
          const raw = own(issue, "path")
          const path: (string | number)[] = []
          if (Array.isArray(raw)) {
            if (typeof raw[0] === "string" && fields.has(raw[0])) path.push(raw[0])
            for (const value of raw.slice(1, 8))
              if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) path.push(value)
          }
          return { code: typeof code === "string" && issues.has(code) ? code : "unknown", path }
        })
      }
    }
    errors.push(entry)
    const cause = own(item.error, "cause")
    const children = type === "AggregateError" ? own(item.error, "errors") : undefined
    if (item.depth >= 6) {
      if (cause !== undefined || (Array.isArray(children) && children.length)) truncated = true
      continue
    }
    if (cause !== undefined) queue.push({ error: cause, depth: item.depth + 1 })
    if (Array.isArray(children)) {
      if (children.length > 32) truncated = true
      for (const error of children.slice(0, 32)) queue.push({ error, depth: item.depth + 1 })
    }
  }
  if (queue.length) truncated = true
  return { format: "raya.source-failure", version: 1, truncated, errors }
}
