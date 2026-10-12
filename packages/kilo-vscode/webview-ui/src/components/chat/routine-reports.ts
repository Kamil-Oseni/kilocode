import { batch, createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import {
  ReportPage,
  type RoutineReport,
  type RoutineReportPage,
  type AgentReportsRead,
} from "../../../../src/shared/routine-reports"

/** The production caller supplies its current session/server accessors and webview transport. */
export function reports(input: {
  session: Accessor<string | undefined>
  directory: Accessor<string>
  connected: Accessor<boolean>
  post: (message: AgentReportsRead) => void
  listen: (handler: (message: unknown) => void) => () => void
}) {
  const [items, setItems] = createSignal<readonly RoutineReport[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [page, setPage] = createSignal<string>()
  const [next, setNext] = createSignal<string>()
  const [bootstrap, setBootstrap] = createSignal<RoutineReportPage["bootstrap"]>()
  let active: { requestID: string; sessionID: string; directory: string; cursor?: string } | undefined
  let closed = false
  const current = () =>
    !closed &&
    active &&
    input.connected() &&
    input.session() === active.sessionID &&
    input.directory() === active.directory

  const read = (cursor?: string) => {
    const sessionID = input.session()
    const directory = input.directory()
    if (closed || !input.connected() || !sessionID || !directory) return
    active = { requestID: crypto.randomUUID(), sessionID, directory, cursor }
    batch(() => {
      setLoading(true)
      setError(undefined)
    })
    input.post({ type: "agentReportsRead", requestID: active.requestID, sessionID, ...(cursor ? { cursor } : {}) })
  }
  const refresh = () => read()
  const older = () => {
    if (!loading() && next()) read(next())
  }
  const retry = () => read(current() ? active?.cursor : page())
  const resume = () => read(page())

  // A synchronously delivered first reply must already have a listener.
  const dispose = input.listen((message) => {
    if (!current() || !active || !message || typeof message !== "object") return
    const reply = message as {
      type?: unknown
      requestID?: unknown
      sessionID?: unknown
      items?: unknown
      error?: unknown
      cursor?: unknown
      next?: unknown
      bootstrap?: unknown
    }
    if (
      reply.type !== "agentReportsLoaded" ||
      reply.requestID !== active?.requestID ||
      reply.sessionID !== active.sessionID ||
      reply.cursor !== active.cursor
    )
      return
    if (typeof reply.error === "string" && reply.error) {
      batch(() => {
        setLoading(false)
        setError(reply.error as string)
      })
      return
    }
    const parsed = ReportPage.safeParse({ items: reply.items, next: reply.next, bootstrap: reply.bootstrap })
    const rows = parsed.success ? parsed.data.items : undefined
    if (
      !rows ||
      rows.some((row) => row.reportSessionID !== active?.sessionID) ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    ) {
      batch(() => {
        setLoading(false)
        setError("Routine reports could not be verified. Refresh to try again.")
      })
      return
    }
    batch(() => {
      setItems(rows)
      setPage(active?.cursor)
      setNext(parsed.success ? parsed.data.next : undefined)
      setBootstrap(parsed.success ? parsed.data.bootstrap : undefined)
      setLoading(false)
      setError(undefined)
    })
  })

  createEffect(() => {
    input.session()
    input.directory()
    input.connected()
    untrack(() => {
      active = undefined
      batch(() => {
        setItems([])
        setError(undefined)
        setLoading(false)
        setPage(undefined)
        setNext(undefined)
        setBootstrap(undefined)
      })
      refresh()
    })
  })
  onCleanup(() => {
    closed = true
    active = undefined
    dispose()
  })
  return {
    items,
    loading,
    error,
    next,
    bootstrap,
    historical: () => page() !== undefined,
    refresh,
    older,
    retry,
    resume,
  }
}
