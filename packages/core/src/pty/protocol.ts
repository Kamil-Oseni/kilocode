export * as PtyProtocol from "./protocol"

// Wire protocol for PTY websocket transports. The PTY domain service is transport-free; server
// routes adapt Pty.attach to websockets with these helpers so every surface speaks one protocol.
//
// Outbound frames are raw UTF-8 terminal chunks. One control frame — a 0x00 byte followed by
// UTF-8 JSON — carries the absolute output cursor after replay so clients can resume later.

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

// Replay can be megabytes; send it in bounded frames.
export const REPLAY_CHUNK = 64 * 1024

// kilocode_change start - retain the cursor-only frame for older clients and add exact replay-loss evidence.
export type ReplayGap = { readonly requestedCursor: number; readonly retainedFrom: number; readonly retainedTo: number }

export function metaFrame(cursor: number, replayGap?: ReplayGap) {
  const bytes = encoder.encode(JSON.stringify({ cursor, ...(replayGap ? { replayGap } : {}) }))
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}
// kilocode_change end

export function chunks(data: string) {
  const out: string[] = []
  for (let i = 0; i < data.length; i += REPLAY_CHUNK) out.push(data.slice(i, i + REPLAY_CHUNK))
  return out
}

// Inbound client frames are UTF-8 text or binary; invalid UTF-8 input is dropped.
export function decodeInput(message: string | Uint8Array | ArrayBuffer) {
  if (typeof message === "string") return message
  try {
    return decoder.decode(message instanceof ArrayBuffer ? new Uint8Array(message) : message)
  } catch {
    return undefined
  }
}
