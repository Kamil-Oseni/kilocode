export * from "@opencode-ai/ui/dialog"

import { Dialog as Base, type DialogProps } from "@opencode-ai/ui/dialog"
import { onCleanup } from "solid-js"

const scopes = new WeakMap<Document, { tokens: Set<object>; generation: number }>()

export function Dialog(props: DialogProps) {
  const doc = typeof document === "undefined" ? undefined : document
  const opener = doc?.activeElement
  const token = {}
  const stack = doc ? (scopes.get(doc) ?? { tokens: new Set<object>(), generation: 0 }) : undefined
  const disposed = { latest: false, generation: 0 }
  if (doc && stack) scopes.set(doc, stack)
  if (stack) {
    stack.tokens.add(token)
    stack.generation++
  }
  onCleanup(() => {
    if (!stack) return
    disposed.latest = Array.from(stack.tokens).at(-1) === token
    disposed.generation = stack.generation
    stack.tokens.delete(token)
  })

  return (
    <Base
      {...props}
      onCloseAutoFocus={(event) => {
        const latest = stack?.tokens.has(token)
          ? Array.from(stack.tokens).at(-1) === token
          : disposed.latest && disposed.generation === stack?.generation
        stack?.tokens.delete(token)
        props.onCloseAutoFocus?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        if (!latest || !doc || !(opener instanceof HTMLElement) || !opener.isConnected) return
        if (opener.closest("[inert]") || opener.matches(":disabled")) return
        const active = doc.activeElement
        const content = event.currentTarget
        if (
          active &&
          active !== doc.body &&
          active !== opener &&
          !(content instanceof Node && content.contains(active))
        )
          return
        opener.focus({ preventScroll: true })
      }}
    />
  )
}
