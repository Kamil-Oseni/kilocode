import type { BackgroundJobsLoadedMessage, ExtensionMessage, WebviewMessage } from "../../types/messages"
import { reconcileBackgroundAgents, type BackgroundAgentSnapshot } from "./background-agents"

type Scope = { sessionID: string; directory: string }
type Stop = { id: string; revision: string; request: string }
type State = { snapshot: BackgroundAgentSnapshot; refreshing: boolean; stop?: Stop }

export function createBackgroundMonitor(input: {
  scope: () => Scope | undefined
  post: (message: WebviewMessage) => void
  listen: (handler: (message: ExtensionMessage) => void) => () => void
  update: (state: State) => void
}) {
  let selected: string | undefined
  let pending: string | undefined
  let deadline = 0
  let dirty = false
  let disposed = false
  let reconnecting = false
  let state: State = { snapshot: { jobs: [], loaded: false, unavailable: false }, refreshing: false }
  const key = () => {
    const scope = input.scope()
    return scope ? JSON.stringify([scope.sessionID, scope.directory]) : undefined
  }
  const reset = () => {
    selected = key()
    pending = undefined
    dirty = false
    state = { snapshot: { jobs: [], loaded: false, unavailable: false }, refreshing: false }
    input.update(state)
  }
  const request = () => {
    if (disposed || reconnecting) return
    if (selected !== key()) reset()
    const scope = input.scope()
    if (!scope) return
    if (pending && Date.now() < deadline) return
    if (pending) state = { ...state, snapshot: { ...state.snapshot, unavailable: true } }
    pending = `${scope.sessionID}:${crypto.randomUUID()}`
    deadline = Date.now() + 15_000
    dirty = false
    state = { ...state, refreshing: true }
    input.update(state)
    input.post({ type: "requestBackgroundJobs", sessionID: scope.sessionID, requestID: pending })
  }
  const receive = (message: BackgroundJobsLoadedMessage) => {
    const original = state.stop
    const receipt = original?.request === message.requestID
    const refresh = pending === message.requestID
    if (!receipt && !refresh) return
    pending = undefined
    state = { ...state, refreshing: false }
    if (receipt) state = { ...state, stop: undefined }
    if (!receipt && !message.error && original) {
      const job = message.jobs.find((item) => item.id === original.id)
      if (job && (job.status !== "running" || (job.revision && job.revision !== original.revision)))
        state = { ...state, stop: undefined }
    }
    // A hint received during the request invalidates its observation. Keep Stop
    // acknowledgement handling, then fetch once more instead of reviving stale waits.
    if (dirty && !receipt) {
      request()
      return
    }
    state = { ...state, snapshot: reconcileBackgroundAgents(state.snapshot, message) }
    input.update(state)
    if (dirty) request()
  }
  const unsubscribe = input.listen((message) => {
    if (disposed) return
    if (message.type === "connectionState") {
      reconnecting = true
      reset()
      queueMicrotask(() => {
        if (disposed) return
        reconnecting = false
        reset()
        request()
      })
      return
    }
    if (selected !== key()) reset()
    const scope = input.scope()
    if (!scope || reconnecting) return
    if (message.type === "localInferenceChanged") {
      const member = state.snapshot.jobs.some(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.background === true &&
          job.metadata.parentSessionId === scope.sessionID &&
          job.metadata.sessionId === message.sessionID,
      )
      if (message.sessionID !== scope.sessionID && !member) return
      state = {
        ...state,
        snapshot: {
          ...state.snapshot,
          jobs: state.snapshot.jobs.map((job) =>
            job.metadata?.localInference ? { ...job, metadata: { ...job.metadata, localInference: undefined } } : job,
          ),
        },
      }
      input.update(state)
      if (pending) dirty = true
      else request()
      return
    }
    if (message.type !== "backgroundJobsLoaded" || message.sessionID !== scope.sessionID) return
    receive(message)
  })
  return {
    request,
    reset,
    stop: (value: Stop) => {
      state = { ...state, stop: value }
      input.update(state)
    },
    dispose: () => {
      disposed = true
      pending = undefined
      dirty = false
      unsubscribe()
    },
  }
}
