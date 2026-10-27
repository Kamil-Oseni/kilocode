import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../types/messages"
import * as Inference from "./local-inference-state"
import type { SessionStatusInfo } from "../types/messages"
import type { useServer } from "./server"
import type { useVSCode } from "./vscode"

type Scope = { sessionID: string; messageID: string; directory: string }

export function createChatInference(
  server: ReturnType<typeof useServer>,
  vscode: ReturnType<typeof useVSCode>,
  session: () => string | null | undefined,
  status: () => SessionStatusInfo,
  submitting: () => boolean,
  blocked: (sessionID: string) => boolean,
  message: () => string | undefined,
) {
  return createLocalInference({
    scope: () => {
      const sessionID = session()
      const info = status()
      if (!sessionID || !server.isConnected() || (info.type !== "busy" && !submitting())) return
      if (info.type === "retry" || info.type === "offline" || blocked(sessionID)) return
      const messageID = message()
      return messageID ? { sessionID, messageID, directory: server.workspaceDirectory() } : undefined
    },
    post: vscode.postMessage,
    listen: vscode.onMessage,
  })
}

function createLocalInference(input: {
  scope: () => Scope | undefined
  post: (message: WebviewMessage) => void
  listen: (handler: (message: ExtensionMessage) => void) => () => void
}) {
  const [value, setValue] = createSignal<unknown>()
  const [now, setNow] = createSignal(Date.now())
  const [revision, setRevision] = createSignal(0)
  const key = createMemo(() => {
    const scope = input.scope()
    return scope ? JSON.stringify([scope.sessionID, scope.messageID, scope.directory]) : undefined
  })
  let selected: string | undefined
  let halted: string | undefined
  let scope: Scope | undefined
  let pending: { id: string; at: number } | undefined
  let reconnecting = false

  const request = () => {
    if (!scope || !selected || halted === selected || reconnecting) return
    if (pending && Date.now() - pending.at < 15_000) return
    if (pending) setValue()
    const id = crypto.randomUUID()
    pending = { id, at: Date.now() }
    input.post({ type: "requestLocalInference", sessionID: scope.sessionID, requestID: id })
  }
  createEffect(() => {
    const next = key()
    revision()
    if (next !== selected) halted = undefined
    selected = next
    scope = next ? untrack(input.scope) : undefined
    pending = undefined
    setValue()
    request()
  })
  const unsubscribe = input.listen((message) => {
    if (message.type === "sessionTurnClosed" && message.sessionID === scope?.sessionID) {
      halted = key()
      pending = undefined
      setValue()
      return
    }
    if (message.type === "connectionState") {
      reconnecting = true
      pending = undefined
      setValue()
      queueMicrotask(() => {
        reconnecting = false
        setRevision((value) => value + 1)
      })
      return
    }
    if (message.type !== "localInferenceLoaded" || !scope || !pending) return
    if (message.sessionID !== scope.sessionID || message.requestID !== pending.id || selected !== key()) return
    pending = undefined
    setValue(message.error ? undefined : Inference.read(message.snapshot, scope.sessionID, Date.now()))
  })
  onCleanup(unsubscribe)
  onMount(() => {
    const poll = setInterval(request, 5_000)
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(clock)
    })
  })
  return {
    waiting: createMemo(() => {
      const current = input.scope()
      if (!current || halted === key()) return
      const row = Inference.wait(value(), current.sessionID, current.messageID, now())
      if (!row) return
      return { elapsed: row.since === undefined ? undefined : Math.floor((now() - row.since) / 1_000) }
    }),
    cancel: () => {
      halted = key()
      pending = undefined
      setValue()
    },
  }
}
