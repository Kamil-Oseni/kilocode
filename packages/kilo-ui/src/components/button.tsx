export * from "@opencode-ai/ui/button"

import { Button as Base, type ButtonProps as Props } from "@opencode-ai/ui/button"
import { splitProps } from "solid-js"
import { size, variant, type ActionIntent, type ActionScale } from "./action"

export interface ButtonProps extends Omit<Props, "variant"> {
  variant?: Props["variant"] | "destructive"
  intent?: ActionIntent
  scale?: ActionScale
  pending?: boolean
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "intent", "scale", "pending", "disabled", "aria-busy"])
  const intent = () => local.intent ?? (local.variant === "destructive" ? "destructive" : undefined)
  const value = () => {
    const current = local.intent ? variant(local.intent) : local.variant
    if (current === "destructive") return "secondary"
    return current
  }
  return (
    <Base
      {...rest}
      variant={value()}
      size={local.scale ? size(local.scale, "extension") : local.size}
      data-intent={intent()}
      data-pending={local.pending || undefined}
      aria-busy={local.pending ? "true" : local["aria-busy"]}
      disabled={local.pending || local.disabled}
    />
  )
}
