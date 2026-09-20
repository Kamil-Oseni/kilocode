import { Button as Kobalte } from "@kobalte/core/button"
import {
  size as actionSize,
  variant as actionVariant,
  type ActionIntent,
  type ActionScale,
} from "@kilocode/kilo-ui/action"
import { Show, splitProps, type ComponentProps } from "solid-js"
import { Icon, type IconProps } from "./icon"

type Size = "xs" | "sm" | "small" | "normal" | "default" | "large" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"
type Variant = "primary" | "default" | "secondary" | "outline" | "ghost" | "destructive" | "link"

export interface ButtonProps
  extends ComponentProps<typeof Kobalte>,
    Pick<ComponentProps<"button">, "class" | "classList" | "children"> {
  size?: Size
  variant?: Variant
  icon?: IconProps["name"]
  intent?: ActionIntent
  scale?: ActionScale
  pending?: boolean
}

function size(value: Size | undefined) {
  if (!value || value === "normal") return "default"
  if (value === "small") return "sm"
  if (value === "large") return "lg"
  return value
}

function variant(value: Variant | undefined) {
  if (!value || value === "default") return "primary"
  return value
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "icon",
    "class",
    "classList",
    "children",
    "intent",
    "scale",
    "pending",
    "disabled",
    "aria-busy",
  ])
  const intent = () => local.intent ?? (local.variant === "destructive" ? "destructive" : undefined)
  return (
    <Kobalte
      {...rest}
      data-component="button"
      data-size={local.scale ? actionSize(local.scale, "web") : size(local.size)}
      data-variant={local.intent ? actionVariant(local.intent) : variant(local.variant)}
      data-intent={intent()}
      data-pending={local.pending || undefined}
      data-icon={local.icon ? "inline-start" : undefined}
      aria-busy={local.pending ? "true" : local["aria-busy"]}
      disabled={local.pending || local.disabled}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.icon}>{(name) => <Icon name={name()} size="small" />}</Show>
      {local.children}
    </Kobalte>
  )
}

export function buttonVariants() {
  return ""
}
