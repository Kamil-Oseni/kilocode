export const intents = ["primary", "secondary", "destructive", "quiet"] as const
export const scales = ["compact", "default", "large"] as const

export type ActionIntent = (typeof intents)[number]
export type ActionScale = (typeof scales)[number]

export function variant(intent: ActionIntent) {
  if (intent === "quiet") return "ghost" as const
  return intent
}

export function size(scale: ActionScale, host: "extension" | "web") {
  if (host === "extension") {
    if (scale === "compact") return "small" as const
    if (scale === "large") return "large" as const
    return "normal" as const
  }
  if (scale === "compact") return "sm" as const
  if (scale === "large") return "lg" as const
  return "default" as const
}
