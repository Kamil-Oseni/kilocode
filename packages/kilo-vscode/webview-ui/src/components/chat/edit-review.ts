import { createSignal } from "solid-js"

type Node = { session: string; file: string; el: HTMLElement }
type State = {
  expected: Record<string, string>
  aliases: Record<string, string>
  windows: boolean
  accepted: Record<string, string>
}
type Handler = { request: (action: "keep" | "undo", file: string) => void; busy: () => boolean }

const [nodes, setNodes] = createSignal<Node[]>([])
const [states, setStates] = createSignal<ReadonlyMap<string, State>>(new Map())
const [handlers, setHandlers] = createSignal<ReadonlyMap<string, Handler>>(new Map())
const normalize = (file: string, windows: boolean) => (windows ? file.replaceAll("\\", "/").toLowerCase() : file)
const canonical = (state: State, file: string) => state.aliases[normalize(file, state.windows)] ?? file

function update(
  session: string,
  expected: Record<string, string>,
  aliases: Record<string, string> = {},
  windows = false,
  confirmed?: Record<string, string>,
) {
  const prev = states().get(session)
  const paths = Object.fromEntries(Object.entries(aliases).map(([file, key]) => [normalize(file, windows), key]))
  for (const file of Object.keys(expected)) paths[normalize(file, windows)] = file
  const retained = Object.fromEntries(
    Object.entries(prev?.accepted ?? {}).filter(
      ([file, hash]) => !expected[file] || (confirmed === undefined && expected[file] === hash),
    ),
  )
  const accepted = {
    ...retained,
    ...Object.fromEntries(Object.entries(confirmed ?? {}).filter(([file, hash]) => expected[file] === hash)),
  }
  setStates((all) =>
    new Map(all).set(session, { expected, aliases: { ...prev?.aliases, ...paths }, windows, accepted }),
  )
}

function select(session: string, file: string) {
  const state = states().get(session)
  if (!state) return
  const key = canonical(state, file)
  const hash = state.expected[key]
  if (hash) return { file: key, expected: { [key]: hash } }
}

function register(node: Node) {
  setNodes((list) => [...list, node])
  return () => setNodes((list) => list.filter((item) => item !== node))
}

function isKept(session: string, file: string) {
  const state = states().get(session)
  if (!state) return false
  const key = canonical(state, file)
  return !!state.accepted[key] && (!state.expected[key] || state.accepted[key] === state.expected[key])
}

function keep(session: string, file: string, revision?: string) {
  const state = states().get(session)
  if (!state) return
  const key = canonical(state, file)
  const hash = revision ?? state.expected[key]
  if (!hash || (state.expected[key] && state.expected[key] !== hash)) return
  setStates((all) => new Map(all).set(session, { ...state, accepted: { ...state.accepted, [key]: hash } }))
}

/** Accept the reviewed set, including transcript nodes that have not mounted yet. */
function keepAll(session: string) {
  const state = states().get(session)
  if (!state) return
  setStates((all) => new Map(all).set(session, { ...state, accepted: { ...state.accepted, ...state.expected } }))
}

function reset(session: string) {
  setStates((all) => {
    const next = new Map(all)
    next.delete(session)
    return next
  })
}

function connect(session: string, handler: Handler) {
  setHandlers((all) => new Map(all).set(session, handler))
  return () =>
    setHandlers((all) => {
      if (all.get(session) !== handler) return all
      const next = new Map(all)
      next.delete(session)
      return next
    })
}

const busy = (session: string) => handlers().get(session)?.busy() ?? true
const request = (session: string, file: string, action: "keep" | "undo") =>
  handlers().get(session)?.request(action, file)

function pending(session: string) {
  const state = states().get(session)
  const seen = new Set<string>()
  const out: string[] = []
  for (const node of nodes()) {
    const key = state ? canonical(state, node.file) : node.file
    if (node.session !== session || seen.has(key)) continue
    seen.add(key)
    if (!isKept(session, node.file)) out.push(node.file)
  }
  return out
}

function focus(session: string, file: string) {
  const hit = nodes().find((node) => node.session === session && node.file === file)
  hit?.el.scrollIntoView({ behavior: "smooth", block: "center" })
}

export const editReview = {
  register,
  isKept,
  keep,
  keepAll,
  reset,
  pending,
  focus,
  update,
  select,
  connect,
  busy,
  request,
}
