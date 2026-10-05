/**
 * Agent Manager terminal manager.
 *
 * Maps Agent Manager terminal IDs to backend PTY IDs (from `kilo serve`).
 * Creation, resize, close, and bulk dispose all funnel through the v2 SDK
 * (`client.pty.{create,update,remove}`). The backend runs a real shell via
 * `@lydell/node-pty` and streams the output over the `/pty/:id/connect`
 * WebSocket — the webview connects directly to that URL so raw bytes do
 * not travel through postMessage.
 *
 * This module is vscode-free on purpose: it only talks to the SDK and
 * whatever log / post / WS-URL helpers its caller provides. That keeps the
 * architecture test happy and makes the manager easy to unit test.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import path from "node:path"

const env = { KILO_UNICODE_LOGO: "0" }

function key(directory: string) {
  const value = path.resolve(directory)
  return process.platform === "win32" ? value.toLowerCase() : value
}

/**
 * Everything the manager needs from the surrounding AgentManagerProvider.
 *
 * Keeping these as function dependencies rather than direct references
 * to the connection service keeps the manager trivially unit-testable
 * and lets the provider control initialization order.
 */
export interface TerminalManagerDeps {
  /** Obtain the shared SDK client. Throws when the CLI is not connected. */
  getClient(): KiloClient
  /** Build the WebSocket URL (including auth + directory query params). */
  buildWsUrl(ptyID: string, cwd: string): string
  /** Short logger, routed to the Agent Manager output channel. */
  log(...args: unknown[]): void
}

/**
 * Bookkeeping entry kept in memory for each live terminal.
 *
 * `cwd` is stored because it is required on every SDK call (the server
 * uses the `directory` query param to route requests to the right
 * per-instance PTY map — see `packages/opencode/src/server/instance/middleware.ts`).
 */
interface Entry {
  terminalId: string
  ptyID: string
  worktreeId: string | null
  cwd: string
  title: string
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>()
  private readonly shells = new Map<string, Entry>()
  private readonly restarts = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, { cols: number; rows: number }>()
  private readonly creates = new Map<string, Set<Promise<unknown>>>()
  private readonly blocked = new Map<string, number>()
  private closed = false
  private retirement: Promise<void> | undefined

  constructor(private readonly deps: TerminalManagerDeps) {}

  /**
   * Spawn a new backend PTY and record it locally.
   *
   * Returns the attach info the webview needs: our synthetic terminal ID,
   * the title, and the signed WebSocket URL pointing at the PTY's connect
   * endpoint. The worktreeId is round-tripped so the webview can route the
   * tab back into the correct sidebar context.
   */
  async create(params: {
    terminalId: string
    worktreeId: string | null
    cwd: string
    title: string
    cols?: number
    rows?: number
  }): Promise<{ terminalId: string; worktreeId: string | null; title: string; wsUrl: string }> {
    const directory = key(params.cwd)
    if (this.closed) throw new Error("Terminal intake is retired")
    if (this.blocked.has(directory)) throw new Error(`PTY directory is being removed: ${params.cwd}`)
    const task = this.createImpl(params)
    const creates = this.creates.get(directory) ?? new Set<Promise<unknown>>()
    if (!this.creates.has(directory)) this.creates.set(directory, creates)
    creates.add(task)
    try {
      return await task
    } finally {
      creates.delete(task)
      if (creates.size === 0) this.creates.delete(directory)
    }
  }

  async blockDirectory(directory: string) {
    const target = key(directory)
    this.blocked.set(target, (this.blocked.get(target) ?? 0) + 1)
    const creates = this.creates.get(target)
    if (creates) await Promise.allSettled([...creates])
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.blocked.get(target)
      if (!count || count === 1) this.blocked.delete(target)
      else this.blocked.set(target, count - 1)
    }
  }

  async closeDirectory(directory: string): Promise<void> {
    const target = key(directory)
    const entries = [...this.entries.values()].filter((entry) => key(entry.cwd) === target)
    const results = await Promise.all(entries.map((entry) => this.close(entry.terminalId)))
    if (results.some((result) => !result)) throw new Error(`Failed to close terminals in ${directory}`)
  }

  private async createImpl(params: {
    terminalId: string
    worktreeId: string | null
    cwd: string
    title: string
    cols?: number
    rows?: number
  }): Promise<{ terminalId: string; worktreeId: string | null; title: string; wsUrl: string }> {
    const initial =
      this.pending.get(params.terminalId) ??
      (params.cols !== undefined && params.rows !== undefined ? { cols: params.cols, rows: params.rows } : undefined)
    this.pending.delete(params.terminalId)

    const client = this.deps.getClient()
    const { data, error } = await client.pty.create({
      directory: params.cwd,
      cwd: params.cwd,
      title: params.title,
      // xterm's DOM renderer cannot draw the Unicode sextant glyphs used by
      // Raya's modern wordmark, so use the compatible logo in embedded tabs.
      env,
      size: initial,
    })
    if (error || !data) {
      const err = error instanceof Error ? error.message : String(error ?? "unknown error")
      throw new Error(`Failed to create PTY: ${err}`)
    }
    const entry: Entry = {
      terminalId: params.terminalId,
      ptyID: data.id,
      worktreeId: params.worktreeId,
      cwd: params.cwd,
      title: data.title ?? params.title,
    }
    this.entries.set(params.terminalId, entry)
    this.shells.set(entry.ptyID, { ...entry })
    // If a resize arrived while pty.create was in flight that differed from `initial`, apply it now.
    const latest = this.pending.get(params.terminalId)
    if (latest && (latest.cols !== initial?.cols || latest.rows !== initial?.rows)) {
      this.pending.delete(params.terminalId)
      const { error: resizeErr } = await client.pty.update({
        directory: entry.cwd,
        ptyID: entry.ptyID,
        size: latest,
      })
      if (resizeErr) {
        const err = resizeErr instanceof Error ? resizeErr.message : String(resizeErr)
        this.deps.log(`Initial terminal resize failed (${params.terminalId}): ${err}`)
      }
    }
    const wsUrl = this.deps.buildWsUrl(entry.ptyID, entry.cwd)
    this.deps.log(`Terminal created: ${params.terminalId} -> pty ${entry.ptyID} cwd=${entry.cwd}`)
    return { terminalId: params.terminalId, worktreeId: entry.worktreeId, title: entry.title, wsUrl }
  }

  /**
   * Forward a resize event to the backend PTY.
   *
   * If the terminal creation is still in flight, dimensions are queued into
   * `pending` and applied during PTY initialization before the WebSocket
   * URL is returned.
   */
  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      this.pending.set(terminalId, { cols, rows })
      return
    }
    this.pending.delete(terminalId)
    const client = this.deps.getClient()
    const { error } = await client.pty.update({
      directory: entry.cwd,
      ptyID: entry.ptyID,
      size: { cols, rows },
    })
    if (error) {
      const err = error instanceof Error ? error.message : String(error)
      this.deps.log(`Terminal resize failed (${terminalId}): ${err}`)
    }
  }

  /** Titles of every live terminal in a context — used by the router to
   *  pick the lowest free "Terminal N" ordinal. */
  titles(worktreeId: string | null): string[] {
    const out: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.worktreeId === worktreeId) out.push(entry.title)
    }
    return out
  }

  /** Kill a single terminal. Keep bookkeeping when the backend rejects cleanup so the UI can retry.
   *  The SDK's `pty.remove` returns `{ data, error }` without throwing
   *  on 4xx/5xx, so we have to check `error` ourselves; otherwise a
   *  failed delete would be silently logged as a successful close and
   *  the server-side PTY would linger until `kilo serve` exits. */
  async close(terminalId: string): Promise<boolean> {
    this.pending.delete(terminalId)
    const entry = this.entries.get(terminalId)
    if (!entry) return true
    try {
      const client = this.deps.getClient()
      const { error } = await client.pty.remove({ directory: entry.cwd, ptyID: entry.ptyID })
      if (error) {
        const msg = error instanceof Error ? error.message : String(error)
        this.deps.log(`Terminal close failed (${terminalId}): ${msg} — PTY may linger until kilo serve exits`)
        return false
      }
      this.entries.delete(terminalId)
      this.shells.delete(entry.ptyID)
      this.deps.log(`Terminal closed: ${terminalId} (pty ${entry.ptyID})`)
      return true
    } catch (err) {
      // Thrown errors are reserved for transport-level failures (no
      // response from the server at all); API-level errors arrive via
      // the `error` field checked above.
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.log(`Terminal close transport error (${terminalId}): ${msg}`)
      return false
    }
  }

  async restart(terminalId: string, cols?: number, rows?: number): Promise<string | undefined> {
    if (this.closed) throw new Error("Terminal intake is retired")
    const entry = this.entries.get(terminalId)
    if (!entry) return
    const prior = this.restarts.get(terminalId)
    if (prior) {
      await prior
      const current = this.entries.get(terminalId)
      return current ? this.deps.buildWsUrl(current.ptyID, current.cwd) : undefined
    }
    const task = this.restartEntry(entry, cols, rows)
    this.restarts.set(terminalId, task)
    await task.finally(() => {
      if (this.restarts.get(terminalId) === task) this.restarts.delete(terminalId)
    })
    const current = this.entries.get(terminalId)
    return current ? this.deps.buildWsUrl(current.ptyID, current.cwd) : undefined
  }

  /**
   * Kill every managed terminal. Invoked from AgentManagerProvider.dispose()
   * so PTYs do not outlive a webview drop that bypasses the explicit close
   * messages.
   *
   * Fence intake and join accepted creates/restarts before removal. Retain
   * failed removals, including prior restart shells, and reject retirement.
   * An SDK removal confirms the backend response; native source-family
   * closure remains a separate proof supplied by the capture controller.
   */
  dispose(): Promise<void> {
    this.closed = true
    return (this.retirement ??= this.retire())
  }

  private async retire(): Promise<void> {
    await Promise.allSettled([...this.creates.values()].flatMap((tasks) => [...tasks]))
    await Promise.allSettled([...this.restarts.values()])
    this.pending.clear()
    const snapshot = [...this.shells.values()]
    if (snapshot.length === 0) {
      this.entries.clear()
      return
    }
    this.deps.log(`Disposing ${snapshot.length} terminal(s)`)
    const client = (() => {
      try {
        return this.deps.getClient()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.deps.log(`Terminal dispose: SDK client unavailable (${msg}); PTY cleanup is unconfirmed`)
        return undefined
      }
    })()
    if (!client) {
      throw new Error("Terminal cleanup client is unavailable")
    }
    const results = await Promise.all(
      snapshot.map(async (entry) => {
        try {
          // Same reasoning as `close()`: the SDK surfaces API errors
          // through the response's `error` field, not an exception.
          const { error } = await client.pty.remove({ directory: entry.cwd, ptyID: entry.ptyID })
          if (error) return { ok: false as const, entry, err: error }
          return { ok: true as const, entry }
        } catch (err) {
          return { ok: false as const, entry, err }
        }
      }),
    )
    let failed = 0
    for (const r of results) {
      if (r.ok) continue
      failed++
      const msg = r.err instanceof Error ? r.err.message : String(r.err)
      this.deps.log(`Terminal dispose cleanup failed (${r.entry.terminalId}): ${msg}`)
    }
    if (failed > 0) {
      this.deps.log(`Terminal dispose: ${failed}/${snapshot.length} PTYs may linger until kilo serve exits`)
    }
    for (const result of results) {
      if (result.ok) {
        this.shells.delete(result.entry.ptyID)
        if (this.entries.get(result.entry.terminalId)?.ptyID === result.entry.ptyID)
          this.entries.delete(result.entry.terminalId)
      }
    }
    if (failed)
      throw new AggregateError(
        results.flatMap((result) => (result.ok ? [] : [result.err])),
        "Terminal cleanup failed",
      )
  }

  private async restartEntry(entry: Entry, cols?: number, rows?: number): Promise<void> {
    try {
      const client = this.deps.getClient()
      const old = entry.ptyID
      const created = await client.pty.create({
        directory: entry.cwd,
        cwd: entry.cwd,
        title: entry.title,
        env,
      })
      const info = created.data
      if (created.error || !info)
        throw new Error(created.error ? String(created.error) : "PTY create returned no session")
      this.shells.set(info.id, { ...entry, ptyID: info.id })
      if (cols !== undefined && rows !== undefined) {
        await client.pty.update({
          ptyID: info.id,
          directory: entry.cwd,
          size: { cols, rows },
        })
      }
      entry.ptyID = info.id
      const removed = await client.pty.remove({ directory: entry.cwd, ptyID: old })
      if (removed.error) throw new Error("Restarted terminal previous PTY removal failed", { cause: removed.error })
      this.shells.delete(old)
      this.deps.log(`Terminal restarted (${entry.terminalId} pty=${entry.ptyID})`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.log(`Terminal restart failed (${entry.terminalId}): ${msg}`)
      throw error
    }
  }
}
