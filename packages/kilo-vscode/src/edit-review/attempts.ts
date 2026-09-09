import { createHash } from "node:crypto"

type State = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }
const name = "raya.reviewAttempts.v1"
const queues = new WeakMap<State, Promise<unknown>>()
type Entry = string | { id: string; session: string }

function identity(value: Entry | undefined) {
  return typeof value === "string" ? value : value?.id
}

function valid(value: unknown): value is Entry {
  if (typeof value === "string") return value.length > 0 && value.length <= 128
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("id" in value) || !("session" in value)) return false
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.session === "string" &&
    /^[a-f0-9]{64}$/.test(value.session)
  )
}

const owner = (session: string) => createHash("sha256").update(session).digest("hex")

function serial<T>(state: State, run: () => Promise<T>) {
  const next = (queues.get(state) ?? Promise.resolve()).then(run, run)
  queues.set(state, next)
  return next
}

function read(state: State): Record<string, Entry> {
  const value = state.get(name)
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => !valid(item)))
    throw new Error("Saved review attempts could not be read. Review remains available.")
  return value as Record<string, Entry>
}

/** Remove only entries attributable to a backend-confirmed deleted session. */
export async function forget(state: State | undefined, session: string) {
  if (!state) return
  await serial(state, async () => {
    const stored = read(state)
    const hash = owner(session)
    const entries = Object.entries(stored).filter(([, value]) => typeof value === "string" || value.session !== hash)
    if (entries.length === Object.keys(stored).length) return
    await state.update(name, Object.fromEntries(entries))
  })
}

/** Save the backend identity before dispatch; clear it only after acknowledged completion. */
export async function remember(
  state: State | undefined,
  input: {
    request: string
    session: string
    directory: string
    action: "keep" | "undo"
    files?: readonly string[]
    expected?: Readonly<Record<string, string>>
  },
) {
  if (!state) return { id: input.request, recovered: false, complete: async () => {} }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.session,
        input.directory,
        input.action,
        input.files ? [...input.files].sort() : null,
        Object.entries(input.expected ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest("hex")
  const id = await serial(state, async () => {
    const stored = read(state)
    const id = identity(stored[key]) ?? input.request
    if (typeof stored[key] === "object") {
      if (stored[key].session !== owner(input.session))
        throw new Error("Saved review attempt ownership does not match its session.")
      return id
    }
    await state.update(name, { ...stored, [key]: { id, session: owner(input.session) } })
    return id
  })
  return {
    id,
    recovered: id !== input.request,
    complete: () =>
      serial(state, async () => {
        const stored = read(state)
        if (identity(stored[key]) !== id) return
        const next = { ...stored }
        delete next[key]
        await state.update(name, next)
      }),
  }
}
