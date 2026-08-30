/**
 * raya_change - inline agent-edit review state.
 *
 * Tracks which files edited by the agent this session the user has explicitly
 * "kept" so the inline review chrome (hued block + Undo/Keep + "N of M"
 * navigator) can hide itself, and provides the ordered pending-edit list the
 * navigator steps through. State is a module-level reactive store keyed by
 * session id — the transcript is a single webview app, so no provider plumbing
 * is needed, and session keys prevent any cross-session bleed.
 */
import { createSignal } from "solid-js"

type Node = { session: string; file: string; el: HTMLElement }

const [nodes, setNodes] = createSignal<Node[]>([])
const [kept, setKept] = createSignal<ReadonlySet<string>>(new Set())

const key = (session: string, file: string) => `${session}\u0000${file}`

function register(node: Node) {
  setNodes((list) => [...list, node])
  return () => setNodes((list) => list.filter((item) => item !== node))
}

function isKept(session: string, file: string) {
  return kept().has(key(session, file))
}

function keep(session: string, file: string) {
  setKept((set) => new Set(set).add(key(session, file)))
}

/** Mark every currently-registered edit for a session as kept (Keep all / Undo all). */
function keepAll(session: string) {
  setKept((set) => {
    const next = new Set(set)
    for (const node of nodes()) if (node.session === session) next.add(key(session, node.file))
    return next
  })
}

/** Forget kept files for a session so a later edit can show review chrome again. */
function reset(session: string) {
  setKept((set) => {
    const next = new Set<string>()
    for (const item of set) if (!item.startsWith(`${session}\u0000`)) next.add(item)
    return next
  })
}

/** Ordered, de-duplicated files still awaiting review for a session (transcript order). */
function pending(session: string) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const node of nodes()) {
    if (node.session !== session || seen.has(node.file)) continue
    seen.add(node.file)
    if (!isKept(session, node.file)) out.push(node.file)
  }
  return out
}

function focus(session: string, file: string) {
  const hit = nodes().find((node) => node.session === session && node.file === file)
  hit?.el.scrollIntoView({ behavior: "smooth", block: "center" })
}

export const editReview = { register, isKept, keep, keepAll, reset, pending, focus }
