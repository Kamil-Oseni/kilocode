import { Schema } from "effect"
import { VoiceID } from "./openai-protocol"

const Revision = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
export const Item = Schema.Struct({
  id: VoiceID,
  previous: Schema.NullOr(VoiceID),
  role: Schema.Literals(["user", "assistant", "other"]),
  state: Schema.Literals(["pending", "final", "omitted"]),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
})
const Items = Schema.Array(Item).check(Schema.isMaxLength(128))
export const Input = Schema.Struct({
  generation: VoiceID,
  providerCallID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^\S+$/)),
  version: Schema.Literal(1),
  revision: Revision,
  items: Items,
  incomplete: Schema.optional(Schema.Boolean),
})
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  revision: Revision,
  items: Items,
  incomplete: Schema.Boolean,
  updatedAt: Schema.Finite,
})
export const Receipt = Schema.Struct({ version: Schema.Literal(1), revision: Revision, updatedAt: Schema.Finite })
export const Context = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(
    Schema.Struct({
      bindingID: VoiceID,
      itemID: VoiceID,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
    }),
  ).check(Schema.isMaxLength(128)),
  incomplete: Schema.Boolean,
})

export function valid(input: unknown): input is typeof Input.Type {
  return (
    Schema.is(Input)(input) &&
    Object.keys(input).every((key) =>
      ["generation", "providerCallID", "version", "revision", "items", "incomplete"].includes(key),
    ) &&
    new Set(input.items.map((item) => item.id)).size === input.items.length &&
    input.items.every(
      (item) =>
        Object.keys(item).every((key) => ["id", "previous", "role", "state", "text"].includes(key)) &&
        (item.text === undefined || Buffer.byteLength(item.text, "utf8") <= 4096) &&
        (item.role === "other" || item.state !== "final" ? item.text === undefined : typeof item.text === "string"),
    ) &&
    Buffer.byteLength(JSON.stringify(input), "utf8") <= 32768
  )
}

export function fingerprint(input: Pick<typeof Snapshot.Type, "items" | "incomplete" | "revision">) {
  return JSON.stringify({
    revision: input.revision,
    incomplete: input.incomplete,
    items: input.items.map((item) => ({
      id: item.id,
      previous: item.previous,
      role: item.role,
      state: item.state,
      ...(item.text !== undefined ? { text: item.text } : {}),
    })),
  })
}

/** A rolling buffer may discard only an old prefix. Known omissions never regain text. */
export function follows(before: typeof Snapshot.Type, after: typeof Snapshot.Type) {
  const retained = new Map(after.items.map((item) => [item.id, item]))
  const start = before.items.findIndex((item) => retained.has(item.id))
  const removed = start < 0 ? before.items.length : start
  if (removed && !after.incomplete) return false
  const suffix = before.items.slice(removed)
  if (suffix.some((item) => !retained.has(item.id))) return false
  const overlap = after.items.filter((item) => before.items.some((prior) => prior.id === item.id))
  if (overlap.some((item, index) => item.id !== suffix[index]?.id)) return false
  if (suffix.some((item, index) => after.items[index]?.id !== item.id)) return false
  return suffix.every((prior) => {
    const item = retained.get(prior.id)!
    if (item.role !== prior.role || item.previous !== prior.previous) return false
    if (prior.state === "omitted") return item.state === "omitted"
    if (prior.state === "pending") return true
    if (item.state === "omitted") return true
    return item.state === "final" && item.text === prior.text
  })
}

/** Conversation links determine order. Missing predecessors are disclosed, never invented. */
export function ordered(snapshot: typeof Snapshot.Type) {
  const lookup = new Map(snapshot.items.map((item) => [item.id, item]))
  const roots = snapshot.items.filter((item) => item.previous === null || !lookup.has(item.previous))
  const items: (typeof Item.Type)[] = []
  let incomplete = snapshot.incomplete
  if (roots.length !== 1) return { items, incomplete: snapshot.items.length > 0 || incomplete }
  let current: typeof Item.Type | undefined = roots[0]
  if (current?.previous !== null) incomplete = true
  const seen = new Set<string>()
  while (current && !seen.has(current.id) && items.length < 128) {
    seen.add(current.id)
    items.push(current)
    const next = snapshot.items.filter((item) => item.previous === current!.id)
    if (next.length > 1) {
      incomplete = true
      break
    }
    current = next[0]
  }
  if (seen.size !== snapshot.items.length || current) incomplete = true
  return { items, incomplete }
}
