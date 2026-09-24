import { Window } from "happy-dom"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { TaskToolBody } from "../../webview-ui/src/components/chat/TaskToolBody"

const window = new Window()
globalThis.window = window as unknown as Window & typeof globalThis
globalThis.document = window.document
globalThis.Node = window.Node

const root = document.createElement("div")
document.body.append(root)
const [running, setRunning] = createSignal(false)
const actions = Array.from({ length: 20 }, (_, index) => <div data-slot="task-tool-item">Action {index + 1}</div>)
const dispose = render(
  () => (
    <TaskToolBody
      running={running()}
      count={20}
      label="20 actions"
      report={<p>Saved report</p>}
      actions={actions}
      model="Selected model"
      modelLabel="Model details"
    />
  ),
  root,
)

const body = root.querySelector('[data-component="task-tools"]')!
const report = body.querySelector('[data-slot="task-result"]')!
const details = body.querySelector<HTMLDetailsElement>('[data-slot="task-actions"]')!
const model = body.querySelector('[data-slot="task-model-details"]')!
if (!report.textContent?.includes("Saved report")) throw new Error("saved report is missing")
if (!details || details.open) throw new Error("completed action history must start closed")
if (details.querySelector("summary")?.textContent !== "20 actions") throw new Error("wrong action summary")
if (details.querySelectorAll('[data-slot="task-tool-item"]').length !== 20) throw new Error("missing actions")
if (report.compareDocumentPosition(details) !== Node.DOCUMENT_POSITION_FOLLOWING) throw new Error("report is not first")
if (details.compareDocumentPosition(model) !== Node.DOCUMENT_POSITION_FOLLOWING) throw new Error("model is not last")

setRunning(true)
if (body.querySelector('[data-slot="task-actions"]')) throw new Error("running actions must not be folded")
if (body.querySelectorAll('[data-slot="task-tool-item"]').length !== 20) throw new Error("running actions are missing")
dispose()
