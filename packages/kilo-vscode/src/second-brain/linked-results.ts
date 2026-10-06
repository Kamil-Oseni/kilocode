import type { BrainContext } from "../shared/second-brain"
import { Failure } from "./client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join("|") === keys.sort().join("|")
}

function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max
}

function relative(value: unknown): value is string {
  return (
    text(value, 4096) &&
    value.length > 0 &&
    value.toLowerCase().endsWith(".md") &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          ![".", ".."].includes(part) &&
          !/[\\<>:"|?*\x00-\x1f]/.test(part) &&
          !/[. ]$/.test(part) &&
          !["system", "archive", ".git", "health", "medical", "private", "sensitive"].includes(
            part.toLowerCase().replace(/\.md$/, ""),
          ),
      )
  )
}

const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
const invalid = () =>
  new Failure("invalid_response", "Linked memory context does not match its bounded source contract.", 200)

/** Validate data and provenance separately from the original operation receipt. */
export function context(value: unknown, root: string, budget: number): BrainContext {
  if (
    !integer(budget, 12000) ||
    budget === 0 ||
    !fields(value, ["sources", "diagnostics", "tokens", "truncated", "capture_enabled"]) ||
    value.capture_enabled !== false ||
    typeof value.truncated !== "boolean" ||
    !integer(value.tokens, budget) ||
    !Array.isArray(value.sources) ||
    value.sources.length > 12 ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 108
  )
    throw invalid()
  const names = new Set<string>()
  const sources = value.sources.map((row: unknown) => {
    if (
      !fields(row, [
        "path",
        "relative",
        "line",
        "end_line",
        "heading",
        "text",
        "source_sha256",
        "depth",
        "tokens",
        "truncated",
      ]) ||
      !relative(row.relative) ||
      !text(row.path, 8192) ||
      normalize(row.path) !== normalize(root) + "/" + row.relative.toLowerCase() ||
      names.has(row.relative.toLowerCase()) ||
      !integer(row.line, 256000) ||
      row.line === 0 ||
      !integer(row.end_line, 256000) ||
      row.end_line < row.line ||
      !text(row.heading, 256000) ||
      !text(row.text, 256000) ||
      !row.text.trim() ||
      !text(row.source_sha256, 64) ||
      !/^[a-f0-9]{64}$/.test(row.source_sha256) ||
      !integer(row.depth, 2) ||
      !integer(row.tokens, Math.min(2000, budget)) ||
      row.tokens === 0 ||
      typeof row.truncated !== "boolean"
    )
      throw invalid()
    names.add(row.relative.toLowerCase())
    return Object.freeze({
      path: row.path,
      relative: row.relative,
      line: row.line,
      end_line: row.end_line,
      heading: row.heading,
      text: row.text,
      source_sha256: row.source_sha256,
      depth: row.depth,
      tokens: row.tokens,
      truncated: row.truncated,
    })
  })
  const diagnostics = value.diagnostics.map((row: unknown) => {
    if (!fields(row, ["relative", "reason"]) || !text(row.relative, 4096) || !text(row.reason, 8192)) throw invalid()
    return Object.freeze({ relative: row.relative, reason: row.reason })
  })
  if (
    sources.reduce((sum, row) => sum + row.tokens, 0) !== value.tokens ||
    (sources.some((row) => row.truncated) && !value.truncated)
  )
    throw invalid()
  return Object.freeze({
    sources: Object.freeze(sources),
    diagnostics: Object.freeze(diagnostics),
    tokens: value.tokens,
    truncated: value.truncated,
    capture_enabled: false,
  })
}
