import assert from "node:assert/strict"
import { createRoot, createComputed, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { dispatch } from "../../../webview-ui/src/utils/message-dispatch"

for (const order of [false, true]) {
  const values: string[] = []
  const state = createRoot((dispose) => {
    const [id, select] = createSignal("pending")
    const [agents, update] = createStore<Record<string, string | undefined>>({ pending: "ask" })
    createComputed(() => values.push(agents[id()] ?? "auto"))
    const transfer = () => {
      update("session", agents.pending)
      update("pending", undefined)
    }
    const activate = () => select("session")
    const handlers = new Set(order ? [activate, transfer] : [transfer, activate])
    return { dispose, handlers }
  })
  values.length = 0
  try {
    dispatch(state.handlers, undefined)
    assert.deepEqual(values, ["ask"], "promotion must publish only the complete session selection")
  } finally {
    state.dispose()
  }
}

const calls: number[] = []
assert.throws(
  () =>
    dispatch(
      new Set([
        () => {
          calls.push(1)
          throw new Error("subscriber failed")
        },
        () => calls.push(2),
      ]),
      undefined,
    ),
  /subscriber failed/,
)
assert.deepEqual(calls, [1])

const handlers = new Set<() => void>()
const removed = () => calls.push(4)
handlers.add(() => {
  calls.push(3)
  handlers.delete(removed)
  handlers.add(() => calls.push(5))
})
handlers.add(removed)
dispatch(handlers, undefined)
assert.deepEqual(calls, [1, 3, 5])
const values: number[] = []
const state = createRoot((dispose) => {
  const [value, update] = createSignal(0)
  createComputed(() => values.push(value()))
  return { dispose, update }
})
values.length = 0
try {
  dispatch(
    new Set([
      () => {
        state.update(1)
        void Promise.resolve().then(() => state.update(2))
      },
      () => state.update(3),
    ]),
    undefined,
  )
  assert.deepEqual(values, [3])
  await Promise.resolve()
  assert.deepEqual(values, [3, 2])
} finally {
  state.dispose()
}
console.log(
  JSON.stringify({
    passed: true,
    orders: 2,
    exceptionsRetained: true,
    setIterationRetained: true,
    asynchronousBoundaryRetained: true,
  }),
)
