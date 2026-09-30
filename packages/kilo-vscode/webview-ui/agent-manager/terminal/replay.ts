interface ReplayGateDeps {
  /** Write one output chunk to xterm, optionally observing parser completion. */
  write(data: string | Uint8Array, callback?: () => void): void
  /** Release input buffered before the initial PTY attachment. */
  flush(): void
  /** Explain a truncated replay before painting the retained tail. */
  gap?(gap: { requestedCursor: number; retainedFrom: number; retainedTo: number }): void
  /** A peer never supplied a replay boundary before this local cap was reached. */
  overflow?(): void
}

const LIMIT = 8 * 1024 * 1024

function gap(data: Uint8Array) {
  if (data.length > 4096) return
  try {
    const meta: unknown = JSON.parse(new TextDecoder().decode(data.subarray(1)))
    if (!meta || typeof meta !== "object" || !("replayGap" in meta)) return
    const value = meta.replayGap
    if (!value || typeof value !== "object") return
    if (!("requestedCursor" in value) || !("retainedFrom" in value) || !("retainedTo" in value)) return
    const requested = value.requestedCursor
    const from = value.retainedFrom
    const to = value.retainedTo
    if (
      typeof requested !== "number" ||
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isSafeInteger(requested) ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      requested < 0 ||
      from <= requested ||
      to < from
    )
      return
    return { requestedCursor: requested, retainedFrom: from, retainedTo: to }
  } catch {
    return
  }
}

/** Keep terminal protocol replies ahead of user input without reordering the
 * user's bytes when both arrive while initial replay is being parsed. */
export function createInputBuffer(limit = 256 * 1024) {
  let input = ""
  let replies = ""

  const add = (data: string, reply = false) => {
    if (reply) {
      replies += data
      if (replies.length > limit) replies = replies.slice(-limit)
      return
    }
    input += data
    if (input.length > limit) input = input.slice(-limit)
  }

  const take = () => {
    const data = replies + input
    replies = ""
    input = ""
    return data
  }

  return { add, take }
}

/**
 * Gate initial user input on the PTY replay boundary. The backend sends a
 * binary 0x00 metadata frame after retained output; waiting for xterm to parse
 * everything queued before that frame keeps shell capability replies ahead of
 * the command the user typed while the PTY was starting.
 *
 * Reconnects keep their existing output-settle timer instead. Their buffered
 * input belongs to an exited shell recovery flow, not the initial attachment.
 */
export function createReplayGate(deps: ReplayGateDeps) {
  let blocked = false
  let boundary = false
  let draining = false
  let serial = 0
  let pending: Array<string | Uint8Array> = []
  let size = 0
  let lost = false

  const attach = (reconnecting: boolean) => {
    serial++
    blocked = !reconnecting
    boundary = false
    draining = false
    pending = []
    size = 0
    lost = false
  }

  const output = (data: string | Uint8Array) => {
    if (!boundary) {
      pending.push(data)
      size += typeof data === "string" ? data.length * 2 : data.byteLength
      while ((size > LIMIT || pending.length > 256) && pending.length) {
        const dropped = pending.shift()!
        size -= typeof dropped === "string" ? dropped.length * 2 : dropped.byteLength
        lost = true
      }
      return
    }
    deps.write(data)
  }

  const frame = (data: Uint8Array) => {
    if (data.length === 0 || data[0] !== 0x00) return false
    if (!boundary) {
      boundary = true
      const missing = gap(data)
      if (missing) deps.gap?.(missing)
      if (lost && !missing) deps.overflow?.()
      // Match OpenCode's transport ordering: once the server says replay is
      // complete, xterm-generated replies from parsing those queued chunks
      // must precede the command typed while the PTY was starting. Keep user
      // input blocked until the parser-drain callback below; TerminalTab puts
      // parser-generated replies in its separate priority buffer meanwhile.
      draining = blocked
      const current = serial
      for (const chunk of pending) deps.write(chunk)
      pending = []
      size = 0
      if (blocked)
        deps.write("", () => {
          if (serial !== current) return
          draining = false
          blocked = false
          deps.flush()
        })
    }
    return true
  }

  const end = () => {
    if (boundary) return
    boundary = true
    if (lost) deps.overflow?.()
    for (const chunk of pending) deps.write(chunk)
    pending = []
    size = 0
  }

  return { attach, blocked: () => blocked, draining: () => draining, awaiting: () => !boundary, frame, output, end }
}
