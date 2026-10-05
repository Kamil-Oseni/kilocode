import { createSignal, type Setter } from "solid-js"
import { onCleanup } from "solid-js" // kilocode_change
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { Global } from "@opencode-ai/core/global"
import { kvOwner } from "../kilocode/kv-owner" // kilocode_change
import { useTuiPaths } from "./runtime"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const paths = useTuiPaths()
    void Global.Path.state
    const file = path.join(paths.state, "kv.json")
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    // kilocode_change start - fence and join this realized preference writer
    const owner = kvOwner(file)
    onCleanup(() => void owner.retire().catch((error) => console.error("Failed to retire KV state", { error })))
    // kilocode_change end

    owner // kilocode_change
      .read() // kilocode_change
      .then((x) => {
        setStore(x)
      })
      .catch((error) => {
        console.error("Failed to read KV state", { error })
      })
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        owner.check() // kilocode_change
        setStore(key, value)
        const snapshot = structuredClone(unwrap(store))
        void owner // kilocode_change
          .write(snapshot) // kilocode_change
          .catch((error) => {
            console.error("Failed to write KV state", { error })
          })
      },
    }
    return result
  },
})
