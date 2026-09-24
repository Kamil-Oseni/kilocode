import { Permission } from "@/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

/** A child session's durable ceiling. Missing metadata means a pre-existing legacy task. */
export namespace TaskAuthority {
  export const key = "raya.task.authority"
  export type Access = "read" | "edit"
  type Saved = { version: 1; access: Access }

  const safe = ["read", "grep", "glob", "list", "semantic_search", "todoread", "chief_message"]

  export function read(metadata?: Record<string, unknown>): Access | undefined {
    const value = metadata?.[key]
    if (value === undefined) return
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid child authority record")
    const record = value as Record<string, unknown>
    if (record.version !== 1 || (record.access !== "read" && record.access !== "edit")) {
      throw new Error("Invalid child authority record")
    }
    return record.access
  }

  export function save(metadata: Record<string, unknown> | undefined, access: Access | undefined) {
    if (!access) return metadata ?? {}
    return { ...metadata, [key]: { version: 1, access } satisfies Saved }
  }

  export function rules(access: Access | undefined): Permission.Ruleset {
    if (access !== "read") return []
    return [
      { permission: "*", pattern: "*", action: "deny" },
      ...safe.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    ]
  }

  /** Keep parent read denials after the child's allowlist; a specialist may not reopen them. */
  export function denies(access: Access | undefined, parent: Permission.Ruleset): Permission.Ruleset {
    if (access !== "read") return []
    return safe.flatMap((permission) => [
      ...(Permission.evaluate(permission, "*", parent).action === "deny"
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
    return access !== "read" || Permission.evaluate(permission, pattern, rules(access)).action !== "deny"
  }

  export function select(input: {
    requested?: Access
    saved?: Access
    parent: Permission.Ruleset
  }): Access | undefined {
    if (input.saved === "read" && input.requested === "edit") {
      throw new Error("A read-only child cannot be resumed with editing access")
    }
    const access = input.requested ?? input.saved
    if (access !== "edit" || input.requested !== "edit") return access
    if (Permission.evaluate("edit", "*", input.parent).action !== "allow") {
      throw new Error("The parent policy does not allow editing access for this child")
    }
    return access
  }
}
