import { Effect } from "effect"
import { createHash } from "node:crypto"
import type { ChildProcess } from "effect/unstable/process"
import type { RunResult } from "../process"

const names = new Set([
  "Snapshot.state",
  "Snapshot.track",
  "Snapshot.patch",
  "Snapshot.restore",
  "Snapshot.diff",
  "Snapshot.diffFull",
  "Git.repo.discover",
  "Git.tree.capture",
  "Git.tree.write",
  "Git.index.refresh",
  "Git.index.ignored",
  "Git.worktree.create",
  "Git.worktree.remove",
  "Git.worktree.list",
])
const verbs = new Set([
  "init",
  "config",
  "rev-parse",
  "ls-files",
  "diff-files",
  "write-tree",
  "read-tree",
  "check-ignore",
  "cat-file",
  "status",
  "worktree",
  "add",
  "update-index",
])
let count = 0
let failures = 0
let emitted = 0
let attempts = 0
let settled = 0
let rejected = 0
let interrupted = 0
export function attempt(enabled: boolean) {
  if (enabled) ++attempts
}
export function settle(enabled: boolean, failed: boolean, canceled: boolean) {
  if (!enabled) return
  ++settled
  if (failed) ++rejected
  if (canceled) ++interrupted
}
export function footer() {
  return {
    diagnosticOnly: true,
    retirementAuthority: false,
    attempted: attempts,
    recordAttempts: count,
    emitted,
    dropped: Math.max(count - 4096, 0),
    failures,
    settled,
    rejected,
    interrupted,
    recordsComplete: attempts === emitted && settled === attempts && count === emitted && failures === 0,
    runStreamCovered: false,
    directSpawnCovered: false,
  }
}
export function failure() {
  ++failures
}

export function record(
  command: ChildProcess.Command,
  pid: number,
  start: number,
  observed: number,
  spans: readonly string[],
  result: RunResult,
  elapsed: number,
) {
  if (process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS !== "1") return undefined
  if (++count > 4096) return undefined
  const image = command._tag === "StandardCommand" ? command.command.split(/[\\/]/).at(-1)?.toLowerCase() : undefined
  const args = command._tag === "StandardCommand" ? command.args : []
  const text = result.stderr.subarray(0, 2048).toString("utf8").toLowerCase()
  const category =
    result.output !== undefined
      ? "combined-unavailable"
      : !result.stderr.length
        ? "empty"
        : /not a git repository|not a git directory/.test(text)
          ? "not-repository"
          : /filename too long|file name too long/.test(text)
            ? "path-length"
            : /permission denied|access is denied/.test(text)
              ? "permission"
              : /invalid argument/.test(text)
                ? "invalid-argument"
                : /no such file|cannot find/.test(text)
                  ? "missing"
                  : "unknown"
  const row = {
    diagnosticOnly: true,
    failures,
    retirementAuthority: false,
    pid,
    parentPID: process.pid,
    start,
    observed,
    clockStable: observed >= start && Math.abs(observed - start - elapsed) <= 4,
    image: image === "git" || image === "git.exe" ? "git" : image === "cmd" || image === "cmd.exe" ? "cmd" : "other",
    operation: args.find((value) => verbs.has(value)) ?? "unknown",
    caller: spans.find((value) => names.has(value)) ?? "unknown",
    gitdir:
      args.includes("--git-dir") || args.some((value) => value.startsWith("--git-dir=")) ? "explicit" : "implicit",
    exitCode: result.exitCode,
    stderrBytes: result.stderr.length,
    stderrSHA256: createHash("sha256").update(result.stderr).digest("hex"),
    stderrTruncated: result.stderrTruncated,
    category,
  }
  ++emitted
  return row
}

// PID-only matches are never sufficient. Missing and ambiguous birth intervals stay unconfirmed.
export function join(
  row: { pid: number; parentPID: number; start: number; observed: number; clockStable: boolean },
  members: readonly { pid: number; birth: string; parentPID: number }[],
) {
  if (
    !row.clockStable ||
    !Number.isSafeInteger(row.start) ||
    !Number.isSafeInteger(row.observed) ||
    row.observed < row.start
  )
    return undefined
  const lower = (BigInt(row.start) - 1n) * 10000n + 116444736000000000n
  const upper = (BigInt(row.observed) + 1n) * 10000n + 116444736000000000n
  const matches = members.filter(
    (value) =>
      value.pid === row.pid &&
      value.parentPID === row.parentPID &&
      /^\d{1,20}$/.test(value.birth) &&
      BigInt(value.birth) >= lower &&
      BigInt(value.birth) <= upper,
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function safe(...args: Parameters<typeof record>) {
  try {
    return record(...args)
  } catch {
    failure()
    return undefined
  }
}

export function context() {
  return Effect.gen(function* () {
    const span = yield* Effect.currentSpan.pipe(Effect.option)
    const spans: string[] = []
    if (span._tag === "None") return spans
    let current = span.value
    for (let depth = 0; depth < 16; ++depth) {
      if (current._tag !== "Span") break
      if (names.has(current.name)) spans.push(current.name)
      if (current.parent._tag === "None" || current.parent.value._tag !== "Span") break
      current = current.parent.value
    }
    return spans
  })
}
