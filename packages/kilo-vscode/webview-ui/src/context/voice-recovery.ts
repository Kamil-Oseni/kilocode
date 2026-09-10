import { createEffect, createSignal } from "solid-js"

type Owner = { id: string; session: string }
type Cleanup = "pending" | "ready" | "failed"
type State = Owner & { ended: boolean; local: Cleanup; host: Cleanup; hidden: boolean }

/** One admission owns both cleanup boundaries; changing tasks never releases either. */
export function createVoiceRecovery(session: () => string | undefined, stop: () => Promise<void>, failed: () => void) {
  const [state, setState] = createSignal<State>()
  const update = (id: string, patch: Partial<State>) => {
    setState((value) => (value?.id === id ? { ...value, ...patch } : value))
  }
  const blocked = () => {
    const value = state()
    return !!value && (!value.ended || value.local !== "ready" || value.host !== "ready")
  }
  createEffect(() => {
    const value = state()
    if (value && !value.hidden && value.session !== session()) update(value.id, { hidden: true })
  })
  return {
    blocked,
    state: () => {
      const value = state()
      if (!value?.ended || value.hidden || value.session !== session()) return
      return { ...value, ready: !blocked() }
    },
    bind(owner: Owner) {
      setState({ ...owner, ended: false, local: "pending", host: "pending", hidden: false })
    },
    close() {
      const value = state()
      if (!value || value.ended) return
      update(value.id, { ended: true })
      void stop().then(
        () => update(value.id, { local: "ready" }),
        () => {
          update(value.id, { local: "failed" })
          failed()
        },
      )
    },
    acknowledge(id: string) {
      if (state()?.ended) update(id, { host: "ready" })
    },
    fail(id: string) {
      const value = state()
      if (value?.id !== id || !value.ended || value.host === "ready") return false
      update(id, { host: "failed" })
      return true
    },
    invalidate() {
      const value = state()
      if (value) update(value.id, { hidden: true })
    },
  }
}
