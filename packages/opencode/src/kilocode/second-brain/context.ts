import { Token } from "@/util/token"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import type { ModelMessage, Tool } from "ai"
import type { ContextResult } from "./protocol"

const owners = new WeakMap<object, ReturnType<typeof create>>()
const reservations = new WeakMap<
  object,
  (
    budget: number,
    signal: AbortSignal,
  ) => {
    budget: number
    check: (value: unknown) => string
  }
>()
const MAX = 12_000
const MARGIN = 1024

function valid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** A tool-resolution owner, refreshed only by its actual outgoing provider frame. */
export function create() {
  let generation = 0
  let remaining: number | undefined
  const owner = {
    frame(value: number | undefined) {
      generation++
      remaining = value
    },
    reserve(this: void, value: number, signal: AbortSignal) {
      signal.throwIfAborted()
      if (!valid(value) || value === 0 || value > MAX) throw new Error("Invalid Memory context budget")
      if (remaining === undefined) throw new Error("Memory context allowance is unavailable for this request")
      const budget = Math.min(value, remaining)
      if (budget === 0) throw new Error("No remaining context for Memory retrieval")
      // Keep the reservation on failure: an uncertain result cannot be replayed into this frame.
      remaining -= budget
      const frame = generation
      let consumed = false
      return {
        budget,
        check(value: unknown) {
          signal.throwIfAborted()
          if (frame !== generation) throw new Error("Memory context belongs to a superseded request")
          if (consumed) throw new Error("Memory context reservation was already consumed")
          consumed = true
          const text = JSON.stringify(value)
          if (text === undefined || Math.ceil(Token.estimate(text) * 1.3) > budget)
            throw new Error("Memory result exceeds its reserved context budget")
          return text
        },
      }
    },
  }
  reservations.set(owner.reserve, owner.reserve)
  return owner
}

export function reserve(callback: unknown, budget: number, signal: AbortSignal) {
  const take = typeof callback === "function" ? reservations.get(callback) : undefined
  if (!take) throw new Error("Original request context owner required for Memory recall")
  return take(budget, signal)
}

/** Preserve whole cited passages in service priority order within the actual frame reservation. */
export function fit(value: ContextResult, budget: number): ContextResult {
  if (!valid(budget) || budget === 0 || budget > MAX) throw new Error("Invalid Memory context budget")
  const result = {
    ...value,
    context: { ...value.context, sources: [...value.context.sources], diagnostics: [...value.context.diagnostics] },
  }
  const fits = () => Math.ceil(Token.estimate(JSON.stringify(result)) * 1.3) <= budget
  if (fits()) return result
  result.context.truncated = true
  while (!fits() && result.context.diagnostics.length) result.context.diagnostics.pop()
  while (!fits() && result.context.sources.length) {
    const source = result.context.sources.pop()
    if (source) result.context.tokens -= source.tokens
  }
  if (!fits()) throw new Error("Memory provenance exceeds its reserved context budget")
  return result
}

export function bind(tools: Record<string, Tool>, owner: ReturnType<typeof create>) {
  for (const tool of Object.values(tools)) {
    owners.set(tool, owner)
    if (tool.execute) owners.set(tool.execute, owner)
  }
  return tools
}

/** Estimate the complete assembled frame, including schemas and reported usage. */
export function prepare(input: {
  originals: Record<string, Tool>
  tools: Record<string, Tool>
  messages: ModelMessage[]
  context: number
  output?: number
  reported?: number
}) {
  const selected = new Set<ReturnType<typeof create>>()
  for (const tool of Object.values(input.originals)) {
    const owner = owners.get(tool) ?? (tool.execute ? owners.get(tool.execute) : undefined)
    if (owner) selected.add(owner)
  }
  if (!selected.size) return
  if (selected.size !== 1) {
    for (const owner of selected) owner.frame(undefined)
    return
  }
  const usage = KiloSessionOverflow.measure(input).raw
  const output = input.output
  const reported = input.reported ?? 0
  const remaining =
    valid(input.context) && input.context > 0 && valid(output) && valid(reported)
      ? Math.max(0, input.context - Math.max(usage, reported) - output - MARGIN)
      : undefined
  for (const owner of selected) owner.frame(remaining)
}
