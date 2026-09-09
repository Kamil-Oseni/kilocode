import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
Object.assign(globalThis, {
  window,
  document: window.document,
  localStorage: window.localStorage,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
})
const { render } = await import("solid-js/web")
const { UsageHistoryView } = await import("../../webview-ui/src/components/chat/UsageHistory")
const { createSignal } = await import("solid-js")
const { costLabel } = await import("../../webview-ui/src/context/accounting")
const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
const [accounting, set] = createSignal({ amount: 0, reported: 0, estimated: 0, partial: 0, unknown: 1, legacy: 0 })
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <UsageHistoryView
      range="all"
      locale="en-US"
      providers={{}}
      usage={{
        range: "all",
        until: 1,
        timezone: "UTC",
        sessions: 1,
        totals: { steps: 1, cost: 0, tokens, accounting: accounting() },
        models: [{ providerID: "test", modelID: "test-model", steps: 1, cost: 0, tokens, accounting: accounting() }],
      }}
    />
  ),
  root,
)
assert.match(root.textContent!, /Cost unavailable/)
assert.doesNotMatch(root.textContent!, /\$0\.00/)
assert.equal(costLabel({ cost: 0, accounting: accounting() }, "en-US", true), "Cost unknown")
set({ amount: 0, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 0 })
assert.match(root.textContent!, /\$0\.00 · reported by provider/)
set({ amount: 0.0385, reported: 1, estimated: 1, partial: 0, unknown: 0, legacy: 0 })
assert.match(root.textContent!, /≈ \$0\.0385 · reported \+ estimated/)
set({ amount: 0.0385, reported: 0, estimated: 1, partial: 0, unknown: 1, legacy: 0 })
assert.match(root.textContent!, /≈ \$0\.0385 known · incomplete cost/)
assert.equal(costLabel({ cost: 0.0385, accounting: accounting() }, "en-US", true), "≈ $0.0385 partial")
set({ amount: 0.00000001, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 0 })
assert.match(root.textContent!, /< \$0\.000001/)
dispose()
await window.happyDOM.close()
console.log("Accounting usage view passed unknown, zero, mixed, incomplete and tiny amount states")
