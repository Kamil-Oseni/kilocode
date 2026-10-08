import path from "node:path"
import { Schema } from "effect"
import { Result, type Request } from "./protocol"

const restricted = new Set(["system", "archive", ".git", "health", "medical", "private", "sensitive"])

/** Revalidate the reply against the retained request, before settling its original deferred. */
export function valid(request: Request, value: Result) {
  if (!Schema.is(Result)(value) || request.command.action !== value.action || request.project !== value.project)
    return false
  if (value.action === "capturePolicy" || value.action === "capture") {
    const command = request.command
    if (command.action !== value.action) return false
    if (command.action !== "capturePolicy" && command.action !== "capture") return false
    if (
      value.sessionID !== request.sessionID ||
      value.messageID !== command.messageID ||
      value.source_sha256 !== command.source_sha256
    )
      return false
    if (value.action === "capturePolicy")
      return value.enabled
        ? Boolean(value.grant && path.isAbsolute(value.grant.root) && value.grant.expires > Date.now())
        : value.grant === undefined
    if (command.action !== "capture") return false
    return value.status === "skipped"
      ? command.entries.length === 0 && value.receipt === undefined
      : value.receipt !== undefined
  }
  if (value.action === "status") {
    if ((value.capture === "capacity") !== (value.capture_reason !== undefined)) return false
    return value.configured
      ? value.root !== undefined && path.isAbsolute(value.root)
      : value.root === undefined && value.index === "unchecked" && value.capture === "unavailable"
  }
  if (request.command.action === "status") return false
  if (value.action !== "context") {
    if (
      request.command.action === "context" ||
      request.command.action === "capturePolicy" ||
      request.command.action === "capture"
    )
      return false
    return (
      value.proposals.every((row) => row.project === request.project) &&
      (request.command.action !== "propose" || value.proposals.every((row) => row.status === "pending")) &&
      (request.command.action === "list" ||
        (value.proposals.length === 1 && value.proposals[0]?.id === request.command.id))
    )
  }
  if (request.command.action !== "context" || !path.isAbsolute(value.root)) return false
  const names = new Set<string>()
  for (const source of value.context.sources) {
    const parts = source.relative.split("/")
    const name = source.relative.toLowerCase()
    if (
      !name.endsWith(".md") ||
      names.has(name) ||
      !path.isAbsolute(source.path) ||
      parts.some(
        (part) => !part || [".", ".."].includes(part) || /[\\<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part),
      ) ||
      parts.some((part) => restricted.has(part.toLowerCase().replace(/\.md$/, ""))) ||
      path.resolve(value.root, ...parts) !== path.resolve(source.path) ||
      source.end_line < source.line ||
      !source.text.trim() ||
      (source.truncated && !value.context.truncated)
    )
      return false
    names.add(name)
  }
  return (
    value.context.tokens <= request.command.budget &&
    value.context.sources.reduce((sum, source) => sum + source.tokens, 0) === value.context.tokens
  )
}
