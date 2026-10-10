import { z } from "zod"
import { codes as offline } from "@opencode-ai/core/kilocode/source-offline-frame"
import { codes as stages } from "./source-stage"
import { codes as images } from "../daemon/image-diagnostic"

// Exact shipped planning literals only. Classification changes neither the error nor admission.
const planning = new Map([
  ["Offline stable registry requires Windows LOCALAPPDATA", "RAYA_SOURCE_REGISTRY_LOCALAPPDATA_MISSING"],
  ["Offline registry path invalid", "RAYA_SOURCE_REGISTRY_PATH_INVALID"],
  ["Offline registry aliases a different physical namespace", "RAYA_SOURCE_REGISTRY_ALIAS_REFUSED"],
  ["Offline registry overlaps selected namespace", "RAYA_SOURCE_REGISTRY_OVERLAP_REFUSED"],
  ["Offline registry requires a distinct existing canonical branch", "RAYA_SOURCE_REGISTRY_BRANCH_MISSING"],
  ["Offline registry branch is unsupported", "RAYA_SOURCE_REGISTRY_BRANCH_UNSUPPORTED"],
  ["Offline registry branch changed before native acquisition", "RAYA_SOURCE_REGISTRY_BRANCH_CHANGED"],
  ["Offline registry physical identity changed", "RAYA_SOURCE_REGISTRY_IDENTITY_CHANGED"],
  ["Offline private registry ACL refused", "RAYA_SOURCE_REGISTRY_ACL_REFUSED"],
  ["Offline helper pin changed", "RAYA_SOURCE_IMAGE_HELPER_PIN_CHANGED"],
  ["Offline roots empty, duplicate or exceeded bound", "RAYA_SOURCE_IMAGE_ROOTS_REFUSED"],
  ["Offline physical plan exceeded root bound", "RAYA_SOURCE_IMAGE_ROOT_CAPACITY"],
  ["Offline control is not a registry generation", "RAYA_SOURCE_IMAGE_CONTROL_REFUSED"],
  ["Offline held guardian identity differs", "RAYA_SOURCE_IMAGE_GUARDIAN_CHANGED"],
  ["Offline held mapping differs", "RAYA_SOURCE_IMAGE_MAPPING_CHANGED"],
  ["Offline stage content differs", "RAYA_SOURCE_IMAGE_CONTENT_CHANGED"],
  ["Offline stage timestamp differs", "RAYA_SOURCE_IMAGE_TIMESTAMP_CHANGED"],
  ["Offline logical root lacks held namespace mapping", "RAYA_SOURCE_IMAGE_LOGICAL_MAPPING_MISSING"],
  ["Offline logical source identity changed", "RAYA_SOURCE_IMAGE_LOGICAL_IDENTITY_CHANGED"],
  ["Offline negative root namespace is not a directory", "RAYA_SOURCE_IMAGE_NEGATIVE_TYPE_REFUSED"],
  ["Derived profile root differs from held raw mapping", "RAYA_SOURCE_SQL_ROOT_MAPPING_CHANGED"],
  ["Selected SQLite profile is absent from held image", "RAYA_SOURCE_SQL_SELECTED_ABSENT"],
  ["Raw image omits selected SQLite file", "RAYA_SOURCE_SQL_SELECTED_MAPPING_MISSING"],
  ["Private SQLite copy differs from raw image", "RAYA_SOURCE_SQL_COPY_CHANGED"],
  ["Selected profile path lacks a held image mapping", "RAYA_SOURCE_PROFILE_MAPPING_MISSING"],
  ["Present SQLite store lacks recovered workspace mapping", "RAYA_SOURCE_WORKSPACE_MAPPING_MISSING"],
  ["Historical workspace inventory exceeds supported bytes", "RAYA_SOURCE_WORKSPACE_BYTE_CAPACITY"],
  ["Historical workspace inventory exceeds supported rows", "RAYA_SOURCE_WORKSPACE_ROW_CAPACITY"],
  ["Historical workspace inventory exceeds supported namespaces", "RAYA_SOURCE_WORKSPACE_NAMESPACE_CAPACITY"],
])
const reasons = new Map([
  ["Additional store workspace is not declared", "RAYA_PROFILE_STORE_WORKSPACE_UNDECLARED"],
  ["Portable composer content disagrees with source SQL", "RAYA_PROFILE_COMPOSER_SQL_DIFFERS"],
  ["Portable composer workspace is not declared", "RAYA_PROFILE_COMPOSER_WORKSPACE_UNDECLARED"],
  ["Duplicate canonical source workspace", "RAYA_PROFILE_WORKSPACE_DUPLICATED"],
  ["Secondary namespace workspace is undeclared", "RAYA_PROFILE_SECONDARY_WORKSPACE_UNDECLARED"],
  ["Duplicate SQL table", "RAYA_PROFILE_SQL_TABLE_DUPLICATED"],
  ["Memory exceeds the shared namespace inventory bound", "RAYA_PROFILE_MEMORY_CAPACITY"],
  ["Git artifacts exceed the shared namespace inventory bound", "RAYA_PROFILE_GIT_CAPACITY"],
  ["Duplicate JSON path", "RAYA_PROFILE_JSON_PATH_DUPLICATED"],
  ["Checkpoint metadata lacks its declared session and snapshot", "RAYA_PROFILE_CHECKPOINT_REFERENCE_MISSING"],
  ["Checkpoint snapshot object format does not match", "RAYA_PROFILE_CHECKPOINT_FORMAT_DIFFERS"],
  ["Checkpoint inventory exceeds its bound", "RAYA_PROFILE_CHECKPOINT_CAPACITY"],
  ["Duplicate source workspace", "RAYA_PROFILE_SOURCE_WORKSPACE_DUPLICATED"],
  ["Git artifact workspace is not declared", "RAYA_PROFILE_GIT_WORKSPACE_UNDECLARED"],
  ["Standalone memory workspace is duplicated or undeclared", "RAYA_PROFILE_MEMORY_WORKSPACE_REFUSED"],
  ["SQL row/column shape mismatch", "RAYA_PROFILE_SQL_ROW_SHAPE_DIFFERS"],
  ["Restored Git projection references its own snapshot", "RAYA_PROFILE_RESTORED_GIT_SELF_REFERENCE"],
  ["Restored component projection references its own snapshot", "RAYA_PROFILE_RESTORED_COMPONENT_SELF_REFERENCE"],
  ["Restored source projection references its own snapshot", "RAYA_PROFILE_RESTORED_SOURCE_SELF_REFERENCE"],
  ["Duplicate archived source identity", "RAYA_PROFILE_ARCHIVE_ID_DUPLICATED"],
  ["Secondary archive provenance lacks its historical snapshot", "RAYA_PROFILE_ARCHIVE_PROVENANCE_MISSING"],
  ["Declared portable workspace reference must be absolute", "RAYA_PROFILE_WORKSPACE_NOT_ABSOLUTE"],
  ["Invalid portable workspace reference", "RAYA_PROFILE_WORKSPACE_INVALID"],
  ["Portable project sandboxes must be a serialized directory array", "RAYA_PROFILE_SANDBOX_SHAPE_REFUSED"],
  ["Portable directory reference must be a string", "RAYA_PROFILE_DIRECTORY_SHAPE_REFUSED"],
  ["Portable project directory relation is invalid", "RAYA_PROFILE_PROJECT_DIRECTORY_INVALID"],
  ["Disposition fingerprint differs", "RAYA_PROFILE_DISPOSITION_FINGERPRINT_DIFFERS"],
  ["Disposition file paths duplicate", "RAYA_PROFILE_DISPOSITION_PATH_DUPLICATED"],
  ["Disposition file root binding is unavailable", "RAYA_PROFILE_DISPOSITION_ROOT_MISSING"],
  ["Disposition file differs from its logical roots", "RAYA_PROFILE_DISPOSITION_ROOT_DIFFERS"],
  ["SQLite disposition lacks its exact recovery root", "RAYA_PROFILE_DISPOSITION_SQL_ROOT_MISSING"],
  ["Configuration disposition differs from its native origin", "RAYA_PROFILE_DISPOSITION_CONFIG_DIFFERS"],
  ["Component disposition differs from its native origin", "RAYA_PROFILE_DISPOSITION_COMPONENT_DIFFERS"],
  ["Disposition SQLite group path differs", "RAYA_PROFILE_DISPOSITION_SQL_PATH_DIFFERS"],
  ["Disposition lacks its preserved notes component", "RAYA_PROFILE_DISPOSITION_NOTES_MISSING"],
  ["Disposition differs from its preserved plan bytes", "RAYA_PROFILE_DISPOSITION_PLAN_DIFFERS"],
  ["SQLite correspondence component differs", "RAYA_PROFILE_SQL_COMPONENT_DIFFERS"],
  ["SQLite Routine effect component binding differs", "RAYA_PROFILE_ROUTINE_BINDING_DIFFERS"],
  ["SQLite Routine effect component differs", "RAYA_PROFILE_ROUTINE_COMPONENT_DIFFERS"],
  ["SQLite Routine effect correspondence differs", "RAYA_PROFILE_ROUTINE_CORRESPONDENCE_DIFFERS"],
  ["SQLite allocator selected target is missing", "RAYA_PROFILE_ALLOCATOR_TARGET_MISSING"],
  ["SQLite allocator selected high-water differs", "RAYA_PROFILE_ALLOCATOR_HIGH_WATER_DIFFERS"],
  ["SQLite correspondence selected table differs", "RAYA_PROFILE_SQL_SELECTED_TABLE_DIFFERS"],
  ["SQLite correspondence invents selected table", "RAYA_PROFILE_SQL_SELECTED_TABLE_INVENTED"],
  ["Configuration correspondence differs from held capture", "RAYA_PROFILE_CONFIG_CORRESPONDENCE_DIFFERS"],
  ["Configuration correspondence graphs differ", "RAYA_PROFILE_CONFIGURATION_CORRESPONDENCE_GRAPHS_DIFFER"],
])

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
  "quick_check",
  "busy",
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

function category(error: unknown) {
  const message = own(error, "message")
  if (typeof message !== "string" || message.length > 160) return undefined
  return planning.get(message)
}

function reason(issue: unknown) {
  if (own(issue, "code") !== "custom") return undefined
  const message = own(issue, "message")
  if (typeof message !== "string" || message.length > 160) return undefined
  return reasons.get(message)
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
    issues?: { code: string; path: (string | number)[]; reason?: string }[]
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
    if (!entry.code && type !== "Unknown") {
      const mapped = category(item.error)
      if (mapped) entry.code = mapped
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
          const fixed = reason(issue)
          return {
            code: typeof code === "string" && issues.has(code) ? code : "unknown",
            path,
            ...(fixed ? { reason: fixed } : {}),
          }
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
