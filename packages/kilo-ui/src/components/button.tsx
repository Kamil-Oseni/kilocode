export * from "@opencode-ai/ui/button"

import { Button as Base, type ButtonProps as Props } from "@opencode-ai/ui/button"
import { splitProps } from "solid-js"

export interface ButtonProps extends Omit<Props, "variant"> {
  variant?: Props["variant"] | "destructive"
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant"])
  return (
    <Base
      {...rest}
      variant={local.variant === "destructive" ? "secondary" : local.variant}
      data-intent={local.variant === "destructive" ? "destructive" : undefined}
    />
  )
}
