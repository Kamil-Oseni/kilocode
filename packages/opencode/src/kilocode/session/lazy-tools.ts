import { jsonSchema, tool, type Tool, type ToolExecutionOptions } from "ai"
import { z } from "zod"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { KiloToolSchema } from "./tool-schema"
import { KiloSessionOverflow } from "./overflow"
import { TurnTools } from "@/kilocode/capability/turn-tools"
import { HomeAssistant } from "@/kilocode/home-assistant/tools"

const name = "discover_tools"
const args = z
  .object({
    offset: z.number().int().min(0).max(10000).optional(),
    query: z.string().max(128).optional(),
    select: z.array(z.string().min(1).max(256)).max(8).optional(),
  })
  .strict()
type Receipt = {
  message: string
  call: string
  input: string
  output: string
  selected: string[]
  signal?: AbortSignal
}
type Binding = {
  scope: object
  session: string
  user: string
  message: string
  current: () => Promise<SessionV1.WithParts[]>
  permits: (id: string) => Promise<boolean>
  receipts: Receipt[]
  selected: string[]
  active: Set<string>
}
const catalogs = new WeakMap<Tool, Binding>()
// Ephemeral execution evidence deliberately cannot be restored from serialized tool history.
const instances = new WeakMap<object, Map<string, Binding>>()
const core = ["read", "glob", "grep", "question", "ask_options", "second_brain_recall"]
const coding = ["read", "edit", "bash", "glob", "grep", "question", "ask_options"]

function latest(messages: SessionV1.WithParts[]) {
  return messages
    .filter((row) => row.info.role === "user")
    .sort((a, b) => (a.info.id < b.info.id ? -1 : 1))
    .at(-1)?.info.id
}

async function check(state: Binding, options: ToolExecutionOptions, ids: string[]) {
  options.abortSignal?.throwIfAborted()
  const messages = await state.current()
  if (instances.get(state.scope)?.get(state.session) !== state || latest(messages) !== state.user)
    throw new Error("Tool discovery belongs to an expired turn")
  const user = messages.find((row) => row.info.id === state.user)?.info
  for (const id of ids) {
    if (user?.role !== "user" || user.tools?.[id] === false || !(await state.permits(id)))
      throw new Error("Tool is unavailable or denied for the current turn")
  }
  const final = await state.current()
  const turn = final.find((row) => row.info.id === state.user)?.info
  if (instances.get(state.scope)?.get(state.session) !== state || latest(final) !== state.user)
    throw new Error("Tool discovery belongs to an expired turn")
  if (turn?.role !== "user" || ids.some((id) => turn.tools?.[id] === false))
    throw new Error("Tool is unavailable or denied for the current turn")
  options.abortSignal?.throwIfAborted()
}

export namespace LazyTools {
  export function eligible(agent: { name: string; mode?: string }) {
    return agent.name === "ask" || (["code", "voice"].includes(agent.name) && agent.mode === "primary")
  }

  export function bind(input: {
    scope: object
    session: string
    user: string
    message: string
    tools: Record<string, Tool>
    messages: SessionV1.WithParts[]
    current: () => Promise<SessionV1.WithParts[]>
    permits: (id: string) => Promise<boolean>
  }) {
    const turns = instances.get(input.scope) ?? new Map<string, Binding>()
    instances.set(input.scope, turns)
    const previous = turns.get(input.session)
    const receipts = previous?.user === input.user ? previous.receipts : []
    const accepted = receipts.filter(
      (receipt) =>
        !receipt.signal?.aborted &&
        input.messages.some(
          (row) =>
            row.info.id === receipt.message &&
            row.info.role === "assistant" &&
            row.info.error === undefined &&
            row.info.parentID === input.user &&
            row.parts.some(
              (part) =>
                part.type === "tool" &&
                part.tool === name &&
                part.callID === receipt.call &&
                part.sessionID === input.session &&
                part.messageID === receipt.message &&
                part.state.status === "completed" &&
                JSON.stringify(part.state.input) === receipt.input &&
                part.state.output === receipt.output,
            ),
        ),
    )
    const state: Binding = {
      scope: input.scope,
      session: input.session,
      user: input.user,
      message: input.message,
      current: input.current,
      permits: input.permits,
      receipts,
      selected: accepted.at(-1)?.selected ?? [],
      active: new Set(),
    }
    turns.set(input.session, state)
    return Object.fromEntries(
      Object.entries(input.tools).map(([id, item]) => {
        const execute = item.execute
        if (execute)
          item.execute = async (value, options) => {
            await check(state, options, [id])
            if (!state.active.has(id)) throw new Error("Tool is not active for this turn")
            return execute(value, options)
          }
        catalogs.set(item, state)
        return [id, item]
      }),
    )
  }

  export async function select(input: {
    agent: string
    mode?: string
    tools: Record<string, Tool>
    system: string[]
    model: Provider.Model
    discovery?: boolean
  }): Promise<Record<string, Tool>> {
    if (!eligible({ name: input.agent, mode: input.mode })) return input.tools
    if (!Object.keys(input.tools).length) return input.tools
    if (Object.keys(input.tools).length === 1 && input.tools.get_goal) return input.tools
    const state = Object.values(input.tools)
      .map((item) => catalogs.get(item))
      .find((item) => item !== undefined)
    const hard = input.model.limit.input || input.model.limit.context
    const output = input.model.limit.input ? 0 : KiloSessionOverflow.OUTPUT_MIN
    if (hard === 0) {
      if (state) state.active = new Set(Object.keys(input.tools))
      return input.tools
    }
    const fits = async (tools: Record<string, Tool>) => {
      const schemas = await KiloToolSchema.sanitize(tools)
      return (
        KiloSessionOverflow.measure({
          messages: [...input.system, TurnTools.prompt(Object.keys(tools))].map((content) => ({
            role: "system",
            content,
          })),
          tools: schemas,
        }).normalized +
          output <
        hard
      )
    }
    if (await fits(input.tools)) {
      if (state) state.active = new Set(Object.keys(input.tools))
      return input.tools
    }
    if (input.discovery === false) return input.tools
    if (Object.hasOwn(input.tools, name)) throw new Error("Reserved tool discovery name is occupied")
    const loader = tool({
      description:
        "Discover every currently permitted tool, 16 entries per page. Search descriptions with query. Select up to 8 exact IDs to activate their full schemas on the NEXT step after this call completes. Selection replaces the previous selection; permissions still apply. Rediscover on a new turn.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0, maximum: 10000 },
          query: { type: "string", maxLength: 128 },
          select: { type: "array", maxItems: 8, items: { type: "string", maxLength: 256 } },
        },
        additionalProperties: false,
      }),
      execute: async (value, options) => {
        if (!state) throw new Error("Tool discovery has no live session binding")
        await check(state, options, [name])
        if (!state.active.has(name)) throw new Error("Tool is not active for this turn")
        const parsed = args.parse(value)
        const selected = [...new Set(parsed.select ?? [])]
        if (selected.some((id) => !Object.hasOwn(input.tools, id)))
          throw new Error("Requested tool is unavailable or denied")
        const next = Object.fromEntries(selected.map((id) => [id, input.tools[id]]))
        next[name] = loader
        if (!(await fits(next))) throw new Error("Selected tool schemas exceed this model's fixed context budget")
        await check(state, options, [name, ...selected])
        const current = (await state.current()).find((row) => row.info.id === state.user)?.info
        const permitted = await Promise.all(
          Object.keys(input.tools).map(async (id) =>
            current?.role === "user" && current.tools?.[id] !== false && (await state.permits(id)) ? id : undefined,
          ),
        )
        await check(state, options, [name, ...selected])
        const rows = Object.entries(input.tools)
          .filter(([id]) => permitted.includes(id))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(
            ([id, item]) =>
              !parsed.query || `${id} ${item.description ?? ""}`.toLowerCase().includes(parsed.query.toLowerCase()),
          )
        const offset = parsed.offset ?? 0
        const output = JSON.stringify({
          total: rows.length,
          offset,
          next: offset + 16 < rows.length ? offset + 16 : null,
          tools: rows
            .slice(offset, offset + 16)
            .map(([id, item]) => ({ id, description: (item.description ?? "").slice(0, 256) })),
          selected,
          activation: "after-completion",
          ephemeral: true,
        })
        if (state.receipts.length >= 64) throw new Error("Tool discovery receipt limit reached for this turn")
        if (parsed.select)
          state.receipts.push({
            message: state.message,
            call: options.toolCallId,
            input: JSON.stringify(value),
            output,
            selected,
            signal: options.abortSignal,
          })
        return { title: "Available tools", output, metadata: {} }
      },
    })
    const chosen: Record<string, Tool> = { [name]: loader }
    for (const id of state?.selected ?? []) if (Object.hasOwn(input.tools, id)) chosen[id] = input.tools[id]
    // The unchanged LLM preflight reports an irreducible fixed system when even the loader cannot fit.
    if (!(await fits(chosen))) {
      if (state) state.active = new Set([name])
      return { [name]: loader }
    }
    if (!state?.selected.length)
      for (const id of input.agent === "voice"
        ? [...Object.keys(HomeAssistant.tools(input.tools)), ...core]
        : input.agent === "code"
          ? coding
          : core) {
        if (!Object.hasOwn(input.tools, id)) continue
        const next = { ...chosen, [id]: input.tools[id] }
        if (await fits(next)) chosen[id] = input.tools[id]
      }
    if (state) state.active = new Set(Object.keys(chosen))
    return chosen
  }
}
