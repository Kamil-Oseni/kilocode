import { createHash } from "node:crypto"

type State = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }
type Store = Record<string, Record<string, string>>
const name = "raya.reviewUndone.v1"
const owners = 128
const paths = 256
const queues = new WeakMap<State, Promise<unknown>>()
const owner = (session: string) => createHash("sha256").update(session).digest("hex")
const dict = (entries: Iterable<readonly [string, string]>) => Object.fromEntries(entries) as Record<string, string>

function serial<T>(state: State, run: () => Promise<T>) {
  const next = (queues.get(state) ?? Promise.resolve()).then(run, run)
  queues.set(state, next)
  return next
}

function valid(file: string, hash: string) {
  return file.length > 0 && file.length <= 4096 && !file.includes("\0") && hash.length > 0 && hash.length <= 128
}

function read(state: State): Store {
  const value = state.get(name)
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const stored = Object.create(null) as Store
  for (const [key, files] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !files || typeof files !== "object" || Array.isArray(files)) continue
    const entries = Object.entries(files)
    if (entries.some(([file, hash]) => typeof hash !== "string" || !valid(file, hash))) continue
    stored[key] = dict(entries as Array<[string, string]>)
  }
  return stored
}

/** Keep only files whose revision was submitted with a successful Undo. */
export function scoped(files: readonly string[] | undefined, revisions: Readonly<Record<string, string>> | undefined) {
  if (!revisions) return
  const next: Record<string, string> = {}
  for (const file of files ?? Object.keys(revisions)) {
    const hash = revisions[file]
    if (hash) next[file] = hash
  }
  if (!Object.keys(next).length) return
  return next
}

/** Historical Undo dismissals apply only while the file is absent from the live diff. */
export function apply(expected: Readonly<Record<string, string>>, dismissed: Readonly<Record<string, string>>) {
  const accepted: Record<string, string> = {}
  const stale: string[] = []
  for (const [file, hash] of Object.entries(dismissed)) {
    if (expected[file]) {
      stale.push(file)
      continue
    }
    accepted[file] = hash
  }
  return { accepted, stale }
}

export function listed(state: State | undefined, session: string) {
  if (!state) return {}
  return read(state)[owner(session)] ?? {}
}

/** Save successful Undo fingerprints so a later webview can dismiss files that left the diff. */
export async function record(state: State | undefined, session: string, files: Readonly<Record<string, string>>) {
  if (!state) return
  const hash = owner(session)
  await serial(state, async () => {
    const stored = read(state)
    const added = Object.entries(files)
    for (const [file, revision] of added) {
      if (!valid(file, revision))
        throw new Error("Saved review undo dismissals could not be read. Review remains available.")
    }
    const entries = new Map(Object.entries(stored[hash] ?? {}))
    for (const [file, revision] of added) {
      entries.delete(file)
      entries.set(file, revision)
    }
    const next = dict([...entries].slice(-paths))
    const sessions = Object.entries(stored).filter(([key]) => key !== hash)
    sessions.push([hash, next])
    await state.update(name, Object.fromEntries(sessions.slice(-owners)))
  })
}

/** Drop dismissals whose files have returned in the live diff. */
export async function reopen(state: State | undefined, session: string, files: readonly string[]) {
  if (!state || !files.length) return
  const hash = owner(session)
  await serial(state, async () => {
    const stored = read(state)
    const current = stored[hash]
    if (!current) return
    const removed = new Set(files)
    const next = dict(Object.entries(current).filter(([file]) => !removed.has(file)))
    const entries = Object.entries(stored).filter(([key]) => key !== hash)
    if (Object.keys(next).length) entries.push([hash, next])
    await state.update(name, Object.fromEntries(entries))
  })
}

/** Remove only entries attributable to a backend-confirmed deleted session. */
export async function forget(state: State | undefined, session: string) {
  if (!state) return
  const hash = owner(session)
  await serial(state, async () => {
    const stored = read(state)
    if (!stored[hash]) return
    await state.update(name, Object.fromEntries(Object.entries(stored).filter(([key]) => key !== hash)))
  })
}
