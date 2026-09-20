import { createEffect, onCleanup } from "solid-js"

export function focus(open: () => boolean, target: () => HTMLElement | undefined) {
  let opener: HTMLElement | undefined
  let active = false

  const restore = () => {
    const node = opener
    opener = undefined
    queueMicrotask(() => {
      if (!node?.isConnected) return
      const current = document.activeElement
      if (current && current !== document.body) return
      node.focus()
    })
  }

  createEffect(() => {
    if (open()) {
      if (!active) opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      active = true
      queueMicrotask(() => {
        if (!open()) return
        target()?.focus()
      })
      return
    }
    if (!active) return
    active = false
    restore()
  })

  onCleanup(() => {
    if (!active) return
    active = false
    restore()
  })
}
