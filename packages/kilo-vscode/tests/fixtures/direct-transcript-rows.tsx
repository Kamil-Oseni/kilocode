import { Window } from "happy-dom"

const window = new Window()
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
})

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { DirectRows } = await import("../../webview-ui/src/components/chat/DirectRows")

const [rows, setRows] = createSignal(new Map([["assistant", { text: "Asked whether to continue" }]]))
const root = document.createElement("div")
document.body.append(root)
let mounts = 0
const dispose = render(
  () => (
    <DirectRows keys={["assistant"]} get={(key) => rows().get(key)!}>
      {(row) => {
        mounts += 1
        return <div data-row="assistant">{row().text}</div>
      }}
    </DirectRows>
  ),
  root,
)

if (root.textContent !== "Asked whether to continue") throw new Error("initial Ask row was not rendered")
setRows(new Map([["assistant", { text: "Stopped as requested. I won't continue this task." }]]))
if (root.textContent !== "Stopped as requested. I won't continue this task.")
  throw new Error(`same-key final acknowledgement was hidden: ${root.textContent}`)
if (mounts !== 1) throw new Error(`same-key assistant row remounted ${mounts} times`)
dispose()
