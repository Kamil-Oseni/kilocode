// kilocode_change - new file; raya_change: parse DeepSeek DSML tool calls from OpenAI-compatible text streams
type Call = {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export type State = {
  readonly pending: string
  readonly block?: string
  readonly index: number
}

export type Result = {
  readonly state: State
  readonly text: string
  readonly calls: ReadonlyArray<Call>
}

const names = ["tool_calls", "function_calls"] as const
const bars = ["｜", "｜｜", "|", "||"] as const
const opens = names.flatMap((name) => bars.map((bar) => `<${bar}DSML${bar}${name}>`))
const close = /<\/[｜|]+DSML[｜|]+(?:tool_calls|function_calls)\s*>/
const invoke = /<[｜|]+DSML[｜|]+invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]+DSML[｜|]+invoke\s*>/g
const parameter =
  /<[｜|]+DSML[｜|]+parameter\s+name="([^"]+)"\s+string="(true|false)"\s*>([\s\S]*?)<\/[｜|]+DSML[｜|]+parameter\s*>/g

const suffix = (text: string) => {
  const limit = Math.min(text.length, Math.max(...opens.map((item) => item.length)) - 1)
  for (let size = limit; size > 0; size--) {
    const value = text.slice(-size)
    if (opens.some((item) => item.startsWith(value))) return value
  }
  return ""
}

const opening = (text: string) =>
  opens.reduce<{ at: number; value: string } | undefined>((found, value) => {
    const at = text.indexOf(value)
    if (at < 0 || (found && found.at <= at)) return found
    return { at, value }
  }, undefined)

const decode = (value: string, string: boolean) => {
  const text = value.trim()
  if (string) return text
  return JSON.parse(text) as unknown
}

const parse = (text: string, index: number) => {
  const calls: Call[] = []
  for (const match of text.matchAll(invoke)) {
    const input: Record<string, unknown> = {}
    for (const item of match[2].matchAll(parameter)) input[item[1]] = decode(item[3], item[2] === "true")
    calls.push({ id: `dsml-${index + calls.length}`, name: match[1], input })
  }
  return calls
}

export const initial = (): State => ({ pending: "", index: 0 })

export function push(state: State, chunk: string): Result {
  const text = `${state.pending}${chunk}`
  if (state.block !== undefined) {
    const block = `${state.block}${text}`
    const end = close.exec(block)
    close.lastIndex = 0
    if (!end) return { state: { ...state, pending: "", block }, text: "", calls: [] }
    const calls = parse(block.slice(0, end.index + end[0].length), state.index)
    const rest = block.slice(end.index + end[0].length)
    const next = push({ pending: "", index: state.index + calls.length }, rest)
    return { state: next.state, text: next.text, calls: [...calls, ...next.calls] }
  }

  const start = opening(text)
  if (start) {
    const before = text.slice(0, start.at)
    const next = push(
      { pending: "", block: start.value, index: state.index },
      text.slice(start.at + start.value.length),
    )
    return { state: next.state, text: `${before}${next.text}`, calls: next.calls }
  }

  const pending = suffix(text)
  return {
    state: { ...state, pending },
    text: text.slice(0, text.length - pending.length),
    calls: [],
  }
}

export const flush = (state: State) => `${state.block ?? ""}${state.pending}`

export * as Dsml from "./dsml"
