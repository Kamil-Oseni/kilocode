import type { BrainSource } from "../shared/second-brain"
import { Failure } from "./client"
type Row = { [key: string]: unknown }

function record(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function integer(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= limit
}

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

function scores(item: Row): item is Row & { embedding_similarity: number; relevance_score: number } {
  return (
    typeof item.embedding_similarity === "number" &&
    Number.isFinite(item.embedding_similarity) &&
    Math.abs(item.embedding_similarity) <= 1.001 &&
    typeof item.relevance_score === "number" &&
    Number.isFinite(item.relevance_score) &&
    item.relevance_score >= 0 &&
    item.relevance_score <= 1
  )
}

/** Exact legacy scalar and source-provenance projection, shared by both protocols. */
export function search(value: unknown, root: string, top: number) {
  if (!record(value) || value.capture_enabled !== false || !Array.isArray(value.results) || value.results.length > top)
    throw new Failure("invalid_response", "Memory results did not match their contract.", 200)
  const results: BrainSource[] = value.results.map((item: unknown) => {
    if (!record(item) || typeof item.relative !== "string" || typeof item.path !== "string")
      throw new Failure("invalid_response", "Memory result is missing source provenance.", 200)
    const parts = item.relative.split("/")
    if (
      parts.some(
        (part) => !part || [".", ".."].includes(part) || /[\\<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part),
      ) ||
      ["system", "archive", ".git"].includes(parts[0].toLowerCase()) ||
      !item.relative.toLowerCase().endsWith(".md") ||
      normalize(item.path) !== root + "/" + item.relative.toLowerCase()
    )
      throw new Failure("invalid_response", "Memory result escaped its configured note root.", 200)
    if (
      !integer(item.line, 256000) ||
      item.line === 0 ||
      !integer(item.end_line, 256000) ||
      item.end_line < item.line ||
      typeof item.heading !== "string" ||
      typeof item.text !== "string" ||
      !item.text ||
      !hash(item.source_sha256) ||
      !scores(item)
    )
      throw new Failure("invalid_response", "Memory result has invalid source coordinates or scores.", 200)
    return Object.freeze({
      path: item.path,
      relative: item.relative,
      line: item.line,
      end_line: item.end_line,
      heading: item.heading,
      text: item.text,
      source_sha256: item.source_sha256,
      embedding_similarity: item.embedding_similarity,
      relevance_score: item.relevance_score,
    })
  })
  return Object.freeze(results)
}
