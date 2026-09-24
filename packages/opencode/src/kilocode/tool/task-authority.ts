import { Permission } from "@/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

/** A child session's durable ceiling. Missing metadata means a pre-existing legacy task. */
export namespace TaskAuthority {
  export const key = "raya.task.authority"
  export const computerKey = "raya.task.computer"
  export type Access = "read" | "edit" | "computer"
  type Saved = { version: 1; access: Access }
  type Computer = {
    version: 1
    parentSessionID: string
    childSessionID: string
    grantID: string
    windowID?: string
    identity?: string
  }

  const safe = ["read", "grep", "glob", "list", "semantic_search", "todoread", "chief_message"]
  const computer = [
    "desktop_observe",
    "desktop_windows",
    "desktop_focus",
    "desktop_watch",
    "desktop_move",
    "desktop_drag",
    "desktop_click",
    "desktop_type",
    "desktop_key",
    "desktop_scroll",
    "desktop_sequence",
  ]

  export function read(metadata?: Record<string, unknown>): Access | undefined {
    const value = metadata?.[key]
    if (value === undefined) return
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid child authority record")
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      (record.access !== "read" && record.access !== "edit" && record.access !== "computer")
    ) {
      throw new Error("Invalid child authority record")
    }
    return record.access
  }

  export function save(metadata: Record<string, unknown> | undefined, access: Access | undefined) {
    if (!access) return metadata ?? {}
    return { ...metadata, [key]: { version: 1, access } satisfies Saved }
  }

  export function bind(metadata: Record<string, unknown>, proof: Omit<Computer, "version">) {
    return { ...metadata, [computerKey]: { version: 1, ...proof } satisfies Computer }
  }

  export function proof(metadata: Record<string, unknown> | undefined, sessionID: string, parentID?: string) {
    if (read(metadata) !== "computer") return
    const value = metadata?.[computerKey]
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Computer task delegation is missing")
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      typeof record.parentSessionID !== "string" ||
      !record.parentSessionID ||
      typeof record.childSessionID !== "string" ||
      record.childSessionID !== sessionID ||
      record.parentSessionID !== parentID ||
      typeof record.grantID !== "string" ||
      !record.grantID ||
      (record.windowID !== undefined &&
        (typeof record.windowID !== "string" || !record.windowID || record.windowID.length > 200)) ||
      (record.windowID !== undefined) !== (record.identity !== undefined) ||
      (record.identity !== undefined &&
        (typeof record.identity !== "string" || !record.identity || record.identity.length > 200))
    )
      throw new Error("Computer task delegation does not match this child")
    return {
      parentSessionID: record.parentSessionID,
      childSessionID: record.childSessionID,
      grantID: record.grantID,
      ...(record.windowID ? { windowID: record.windowID } : {}),
      ...(record.identity ? { identity: record.identity } : {}),
    }
  }

  export function rules(access: Access | undefined): Permission.Ruleset {
    if (access !== "read" && access !== "computer") return []
    return [
      { permission: "*", pattern: "*", action: "deny" },
      ...(access === "computer" ? [...safe, ...computer] : safe).map((permission) => ({
        permission,
        pattern: "*",
        action: "allow" as const,
      })),
    ]
  }

  /** Keep parent read denials after the child's allowlist; a specialist may not reopen them. */
  export function denies(access: Access | undefined, parent: Permission.Ruleset): Permission.Ruleset {
    if (access !== "read" && access !== "computer") return []
    return (access === "computer" ? [...safe, ...computer] : safe).flatMap((permission) => [
      ...((access === "read" || safe.includes(permission)) &&
      Permission.evaluate(permission, "*", parent).action === "deny"
        ? [{ permission, pattern: "*", action: "deny" as const }]
        : []),
      ...parent
        .filter(
          (rule) => rule.action === "deny" && rule.permission !== "*" && Wildcard.match(permission, rule.permission),
        )
        .map((rule) => ({ ...rule, permission })),
    ])
  }

  export function permits(access: Access | undefined, permission: string, pattern: string) {
    return (
      (access !== "read" && access !== "computer") ||
      Permission.evaluate(permission, pattern, rules(access)).action !== "deny"
    )
  }

  export function select(input: {
    requested?: Access
    saved?: Access
    parent: Permission.Ruleset
  }): Access | undefined {
    if ((input.saved === "read" || input.saved === "computer") && input.requested && input.saved !== input.requested) {
      throw new Error("A restricted child cannot be resumed with different access")
    }
    const access = input.requested ?? input.saved
    if (access !== "edit" || input.requested !== "edit") return access
    if (Permission.evaluate("edit", "*", input.parent).action !== "allow") {
      throw new Error("The parent policy does not allow editing access for this child")
    }
    return access
  }

  /** Admit Auto children with a durable minimum authority and goal-bound edits. */
  export function admit(input: {
    auto: boolean
    planned?: Access
    requested?: Access
    saved?: Access
    goalActive: boolean
    parent: Permission.Ruleset
  }) {
    const requested = input.planned ?? input.requested ?? input.saved ?? (input.auto ? "read" : undefined)
    if (input.auto && !input.planned && (requested === "edit" || input.saved === "edit") && !input.goalActive)
      throw new Error("Auto editing requires an active goal")
    return select({ requested, saved: input.saved, parent: input.parent })
  }
}
