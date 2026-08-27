// raya_change - Milestone E fixed React runtime for sandboxed canvas artifacts
import React, { Component, useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"

type CanvasData = Record<string, unknown>
type CanvasComponent = React.ComponentType<{ data: CanvasData }>

declare global {
  interface Window {
    RayaCanvas: {
      React: typeof React
      mount(component: CanvasComponent): void
    }
  }
}

let root: Root | undefined
let view: CanvasComponent | undefined
let data: CanvasData = {}
let ready = false
let update: ((value: CanvasData) => void) | undefined

function post(message: object) {
  window.parent.postMessage({ source: "raya-canvas", ...message }, "*")
}

function detail(error: unknown) {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}

function show(error: unknown) {
  const message = detail(error)
  const target = document.getElementById("raya-canvas-error")
  if (target) {
    target.textContent = message
    target.hidden = false
  }
  post({ type: "runtimeError", error: message })
}

class Boundary extends Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {}

  static getDerivedStateFromError(error: unknown) {
    return { error: detail(error) }
  }

  componentDidCatch(error: unknown) {
    show(error)
  }

  render() {
    if (this.state.error) return null
    return this.props.children
  }
}

function Host() {
  const [value, setValue] = useState(data)
  update = setValue
  useEffect(() => {
    post({ type: "rendered" })
  })
  if (!view) return null
  return React.createElement(
    Boundary,
    null,
    React.createElement(view, {
      data: value,
    }),
  )
}

function render() {
  if (!ready || !view) return
  const target = document.getElementById("raya-canvas-root")
  if (!target) return show(new Error("Canvas root element is missing"))
  root ??= createRoot(target)
  root.render(React.createElement(Host))
}

window.RayaCanvas = {
  React,
  mount(component) {
    view = component
    render()
  },
}

window.addEventListener("message", (event: MessageEvent<{ source?: string; type?: string; data?: CanvasData }>) => {
  if (event.data?.source !== "raya-canvas-host" || event.data.type !== "data") return
  data = event.data.data ?? {}
  ready = true
  if (update) update(data)
  render()
})
window.addEventListener("error", (event) => show(event.error ?? event.message))
window.addEventListener("unhandledrejection", (event) => show(event.reason))
post({ type: "ready" })
