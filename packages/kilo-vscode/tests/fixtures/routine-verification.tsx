import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window()
Object.assign(globalThis, { window, document: window.document, Node: window.Node })
const { render } = await import("solid-js/web")
const { Verification } = await import("../../webview-ui/src/components/routines/Verification")
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <Verification
      outcome={{
        kind: "notify",
        summary: "Actual final answer",
        verification: {
          at: 1,
          requirements: [
            {
              requirement: "Prose claim",
              required: true,
              passed: true,
              basis: "model-audit",
              evidence: ["Read a source"],
            },
            {
              requirement: "Command criterion",
              required: true,
              passed: true,
              basis: "command",
              evidence: ["Original command receipt"],
            },
            {
              requirement: "File comparison",
              required: true,
              passed: true,
              basis: "byte-equality",
              evidence: ["Original comparison receipt"],
            },
            { requirement: "Legacy claim", required: true, passed: true, evidence: ["Old evidence"] },
            { requirement: "Failed criterion", required: true, passed: false, basis: "command", evidence: [] },
          ],
        },
      }}
    />
  ),
  root,
)
try {
  const rows = Array.from(root.querySelectorAll("li.routines-note"))
  assert.equal(rows.length, 5)
  assert.match(rows[0].textContent!, /Agent reported satisfied/)
  assert.match(rows[1].textContent!, /Saved command check passed/)
  assert.match(rows[2].textContent!, /Saved byte-equality check passed/)
  assert.match(rows[3].textContent!, /Recorded completion claim.*verification basis unavailable/)
  assert.match(rows[4].textContent!, /Not verified/)
  assert.doesNotMatch(root.textContent!, /Verified at completion/)
  assert.match(root.textContent!, /do not verify the later final answer/)
} finally {
  dispose()
  await window.happyDOM.close()
}
