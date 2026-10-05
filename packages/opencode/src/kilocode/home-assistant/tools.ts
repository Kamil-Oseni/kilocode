import { Permission } from "@/permission"
import type { MessageV2 } from "@/session/message-v2"

/** Exact connected-device tools; registration and per-call approval remain separate boundaries. */
export namespace HomeAssistant {
  export const key = "raya.home-assistant.selection"
  const names = [
    "raya_home_assistant_lights_read",
    "raya_home_assistant_lights_set",
    "raya_home_assistant_lights_mode",
    "raya_home_assistant_moods_list",
    "raya_home_assistant_moods_save",
    "raya_home_assistant_moods_start",
    "raya_home_assistant_moods_stop",
  ]

  export const prompt =
    "For Home Assistant lights, use the registered raya_home_assistant tools directly in this primary chat. Do not delegate device actions to a read-only specialist or call chief_route for them. If unavailable, report the limitation. Honor approval and device/mode allowlists. Send a mutation once; never retry uncertain actions. Report readback truthfully; scene acceptance or script/mood startup does not prove completed physical change. For themed dynamic moods, research the theme with available web tools, cite inspiration and distinguish inferred colours from official palettes. Propose the palette and requested targets, save with moods_save, and start only when requested. Prefer a 60-second staggered cycle; preserve ceiling/PC participation when requested. Recall saved names with moods_list/start; inspect actual cycle status and use moods_stop to cancel."

  export const auto =
    "For a new Auto request, first call chief_route with workflow:home_assistant only when the complete request needs Home Assistant light inspection or control; otherwise use its default specialist workflow. Device tools are unavailable until that exact request is selected. After Home Assistant selection, use its registered tools directly in this primary chat; do not delegate device actions. If no device tools are available, report that limitation. Honor approval and configured device/mode allowlists. Send a mutation once, never retry an uncertain action, and report target readback truthfully."

  export function selected(
    metadata: Record<string, unknown> | undefined,
    dispatch: { session: string; user: string } | undefined,
  ) {
    if (!dispatch) return false
    const value = metadata?.[key]
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    if (!("session" in value) || !("user" in value) || !("request" in value)) return false
    return (
      value.session === dispatch.session &&
      value.user === dispatch.user &&
      typeof value.request === "string" &&
      value.request.length > 0 &&
      value.request === metadata?.["raya.chief.request"]
    )
  }

  /** A settled current primary turn permits truthful synthesis, not any new tool authority. */
  export function settled(
    messages: readonly MessageV2.WithParts[],
    session: { id: string; parentID?: string; metadata?: Record<string, unknown> },
    user: string,
  ) {
    if (session.parentID || !selected(session.metadata, { session: session.id, user })) return false
    const latest = messages.findLast((message) => message.info.role === "user")
    if (
      latest?.info.role !== "user" ||
      latest.info.agent !== "auto" ||
      latest.info.id !== user ||
      latest.info.sessionID !== session.id
    )
      return false
    return messages.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.agent === "auto" &&
        message.info.sessionID === session.id &&
        message.info.parentID === user &&
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            part.sessionID === session.id &&
            part.messageID === message.info.id &&
            names.includes(part.tool) &&
            (part.state.status === "completed" || part.state.status === "error"),
        ),
    )
  }

  export function rules(defaults: Permission.Ruleset) {
    return Permission.fromConfig(
      Object.fromEntries(
        names.map((name) => [
          name,
          Permission.evaluate(name, "*", defaults).action === "deny" ? ("deny" as const) : ("ask" as const),
        ]),
      ),
    )
  }

  export function tools<T>(available: Record<string, T>) {
    return Object.fromEntries(
      [...names, "websearch", "webfetch"].flatMap((name) =>
        Object.hasOwn(available, name) ? [[name, available[name]]] : [],
      ),
    )
  }
}
