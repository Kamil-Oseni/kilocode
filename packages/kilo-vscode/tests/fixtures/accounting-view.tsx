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
const { CostDetails } = await import("../../webview-ui/src/components/chat/CostDetails")
const close = render(
  () => (
    <CostDetails
      locale="en-US"
      parts={[
        {
          id: "step-1",
          sessionID: "session",
          messageID: "message",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens,
          accounting: {
            version: 1,
            status: "estimated",
            source: "model-rate-snapshot:private/priced",
            currency: "USD",
            amount: 0,
            buckets: [{ name: "input", tokens: 100, rate: 0, source: "configuration" }],
            issues: [],
          },
        },
        {
          id: "step-2",
          sessionID: "session",
          messageID: "message",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens,
          accounting: {
            version: 1,
            status: "partial",
            source: "model-rate-snapshot:test/priced",
            currency: "USD",
            amount: 0,
            buckets: [{ name: "cache_read", tokens: 50 }],
            issues: ["cache_read_rate_unverified"],
          },
        },
      ]}
    />
  ),
  root,
)
assert.equal(root.querySelector("details > summary")?.textContent, "How model costs were calculated")
assert.match(root.textContent!, /Pricing model: private\/priced/)
assert.match(root.textContent!, /Configured rate/)
assert.match(root.textContent!, /100 tokens.*\$0\.00 per million tokens/)
assert.match(root.textContent!, /Cached input: 50 tokens; rate unavailable/)
assert.match(root.textContent!, /cache read rate unverified/)
close()
const older = render(
  () => (
    <CostDetails
      locale="en-US"
      parts={Array.from({ length: 21 }, (_, index) => ({
        id: `step-${index}`,
        sessionID: "session",
        messageID: "message",
        type: "step-finish" as const,
        reason: "stop",
        cost: 0,
        tokens,
      }))}
    />
  ),
  root,
)
assert.equal(root.querySelectorAll("h4").length, 20)
assert.equal(root.querySelector("h4")?.textContent, "Step 2")
const button = root.querySelector("button")
assert.equal(button?.textContent, "Show earlier calculations")
button!.click()
assert.equal(root.querySelectorAll("h4").length, 21)
assert.equal(root.querySelector("h4")?.textContent, "Step 1")
older()
await window.happyDOM.close()
console.log("Accounting usage view passed unknown, zero, mixed, incomplete and tiny amount states")
