import { AsyncLocalStorage } from "node:async_hooks"

const state = new AsyncLocalStorage<boolean>()

/** Only this original command's instance bootstrap may opt out of watcher warm-up. */
export function run<A>(watch: boolean | undefined, body: () => Promise<A>) {
  return state.run(watch !== false, body)
}

export function warm() {
  return state.getStore() !== false
}
