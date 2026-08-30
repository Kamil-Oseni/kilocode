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

// raya_change start - run artifact capture: rasterize the live DOM to a PNG via
// an SVG <foreignObject>, dependency-free so it stays cheap to bundle.
function inlineStyles(source: Element, target: Element) {
  const computed = window.getComputedStyle(source)
  const style = (target as HTMLElement).style
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i]
    style.setProperty(prop, computed.getPropertyValue(prop), computed.getPropertyPriority(prop))
  }
  const from = source.children
  const to = target.children
  for (let i = 0; i < from.length && i < to.length; i++) inlineStyles(from[i], to[i])
}

async function runCapture() {
  try {
    const node = document.getElementById("raya-canvas-root")
    if (!node) throw new Error("Canvas root element is missing")
    const rect = node.getBoundingClientRect()
    const width = Math.max(1, Math.ceil(rect.width) || node.scrollWidth || 800)
    const height = Math.max(1, Math.ceil(rect.height) || node.scrollHeight || 600)
    const clone = node.cloneNode(true) as HTMLElement
    inlineStyles(node, clone)
    const xml = new XMLSerializer().serializeToString(clone)
    const bg = window.getComputedStyle(document.body).backgroundColor
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">${xml}</div>` +
      `</foreignObject></svg>`
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error("capture render failed"))
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)
    })
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const cx = canvas.getContext("2d")
    if (!cx) throw new Error("2D canvas context unavailable")
    cx.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#1e1e1e"
    cx.fillRect(0, 0, width, height)
    cx.drawImage(img, 0, 0)
    post({ type: "captured", data: canvas.toDataURL("image/png") })
  } catch (error) {
    post({ type: "captureError", error: detail(error) })
  }
}
// raya_change end

// raya_change start - Design Mode: hover-highlight elements and pick one to
// emit a steering hint back to the chat composer.
const HOVER = "raya-design-hover"
let hover: Element | undefined
let designStyle: HTMLStyleElement | undefined

function describe(el: Element) {
  const tag = el.tagName.toLowerCase()
  const id = el.id ? `#${el.id}` : ""
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).filter((c) => c !== HOVER).join(".")
      : ""
  const text = (el.textContent ?? "").trim().slice(0, 60)
  return `In the canvas, update this element: \`${tag}${id}${cls}\`${text ? ` ("${text}")` : ""} — `
}

function onMove(event: MouseEvent) {
  const target = event.target as Element | null
  if (hover && hover !== target) hover.classList.remove(HOVER)
  if (target && target.id !== "raya-canvas-error") {
    target.classList.add(HOVER)
    hover = target
  }
}

function onPick(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  const target = event.target as Element | null
  if (target) post({ type: "designPick", text: describe(target) })
}

function setDesign(on: boolean) {
  if (on) {
    if (!designStyle) {
      designStyle = document.createElement("style")
      designStyle.textContent = `.${HOVER}{outline:2px solid #6ea8fe !important;outline-offset:-2px;cursor:crosshair !important;}`
      document.head.appendChild(designStyle)
    }
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("click", onPick, true)
    return
  }
  document.removeEventListener("mousemove", onMove, true)
  document.removeEventListener("click", onPick, true)
  if (hover) {
    hover.classList.remove(HOVER)
    hover = undefined
  }
}
// raya_change end

type HostMessage =
  | { source?: string; type: "data"; data?: CanvasData }
  | { source?: string; type: "capture" }
  | { source?: string; type: "designMode"; enabled?: boolean }

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data
  if (message?.source !== "raya-canvas-host") return
  if (message.type === "data") {
    data = message.data ?? {}
    ready = true
    if (update) update(data)
    render()
    return
  }
  if (message.type === "capture") {
    void runCapture()
    return
  }
  if (message.type === "designMode") {
    setDesign(!!message.enabled)
  }
})
window.addEventListener("error", (event) => show(event.error ?? event.message))
window.addEventListener("unhandledrejection", (event) => show(event.reason))
post({ type: "ready" })
