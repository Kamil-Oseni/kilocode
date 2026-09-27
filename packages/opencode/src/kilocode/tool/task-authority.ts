import { Permission } from "@/permission"
import { RayaAskOptions } from "@/kilocode/ask-options"
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
  type SelectedComputer = {
    version: 2
    parentSessionID: string
    childSessionID: string
    grantID: string
    binding: { version: 1; windowID: string; identity: string }
  }

  const safe = ["read", "file_facts", "grep", "glob", "list", "semantic_search", "todoread", "chief_message"]
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

  export function bindSelected(metadata: Record<string, unknown>, proof: Omit<SelectedComputer, "version">) {
    if (!/^0x[0-9A-F]+$/.test(proof.binding.windowID) || !/^[A-F0-9]{64}$/.test(proof.binding.identity))
      throw new Error("Selected Computer Use child binding is invalid")
    return { ...metadata, [computerKey]: { version: 2, ...proof } satisfies SelectedComputer }
  }

  export function proof(metadata: Record<string, unknown> | undefined, sessionID: string, parentID?: string) {
    if (read(metadata) !== "computer") return
    const value = metadata?.[computerKey]
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Computer task delegation is missing")
    const record = value as Record<string, unknown>
    if (
      (record.version !== 1 && record.version !== 2) ||
      typeof record.parentSessionID !== "string" ||
      !record.parentSessionID ||
      typeof record.childSessionID !== "string" ||
      record.childSessionID !== sessionID ||
      record.parentSessionID !== parentID ||
      typeof record.grantID !== "string" ||
      !record.grantID
    )
      throw new Error("Computer task delegation does not match this child")
    if (record.version === 2) {
      const binding = record.binding
      if (!binding || typeof binding !== "object" || Array.isArray(binding))
        throw new Error("Selected Computer Use child binding is missing")
      const selected = binding as Record<string, unknown>
      if (
        selected.version !== 1 ||
        typeof selected.windowID !== "string" ||
        !/^0x[0-9A-F]+$/.test(selected.windowID) ||
        typeof selected.identity !== "string" ||
        !/^[A-F0-9]{64}$/.test(selected.identity)
      )
        throw new Error("Selected Computer Use child binding is invalid")
      return {
        parentSessionID: record.parentSessionID,
        childSessionID: record.childSessionID,
        grantID: record.grantID,
        windowID: selected.windowID,
        identity: selected.identity,
      }
    }
    if (
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

  /** A current user request may authorize ordinary editing without creating a formal goal. */
  export function explicit(request: string | undefined) {
    if (!request) return false
    const text = request.trim()
    if (
      /^(?:please\s+)?(?:do\s+not|don't|never|avoid)\b/i.test(text) &&
      !/[.;]\s*(?:please\s+)?(?:commit|push|fix|implement|edit|modify|patch|refactor|build|write|create|add|update|remove|delete)\b/i.test(
        text,
      )
    )
      return false
    if (/^(?:please\s+)?(?:hold|stop|pause|cancel)\b/i.test(text)) return false
    if (/\bread[- ]only\b|\bno edits?\b(?!\s+(?:outside|beyond|to|in|on|except))/i.test(text)) return false
    // A restriction on *other* files or an old goal does not revoke the requested edit.
    if (
      /\b(?:without|do not) (?:edit|editing|change|changing|modify|modifying)(?=\s*(?:[.!?;:]|$)|\s+(?:anything|any files?|any code|the (?:workspace|repo(?:sitory)?))\b)/i.test(
        text,
      )
    )
      return false
    if (
      /^(?:please\s+)?(?:review|inspect|audit|explain|analyze|summarize|check)\b/i.test(text) &&
      !/\b(?:and|then|also)\s+(?:fix|edit|implement|modify|patch|refactor|build|write|create|add|update|remove|delete)\b/i.test(
        text,
      )
    )
      return false
    // A request to compose an answer is not authority to mutate the workspace.
    // An explicit destination or a separate change instruction still authorizes it.
    if (
      /\b(?:write|create)\s+(?:(?:me|us)\s+)?(?:(?:an?|the)\s+)?(?:summary|explanation|report|answer|response|list|outline|plan|description|message|email|post|poem|story|draft)\b/i.test(
        text,
      ) &&
      !/\b(?:and|then|also)\s+(?:commit|push|fix|implement|edit|modify|patch|refactor|build|add|update|remove|delete)\b/i.test(
        text,
      ) &&
      !/\b(?:in|to|as|at|under)\s+(?:(?:an?|the|new)\s+)?(?:file|document|artifact|repository|repo|folder|directory|[\w./\\-]+\.(?:md|txt|docx|pdf|json|ts|tsx|js|jsx|py|html|css))\b/i.test(
        text,
      )
    )
      return false
    if (
      /\b(?:commit|push|fix|implement|edit|modify|patch|refactor|build|write|create|add|update|remove|delete)\b/i.test(
        text,
      )
    )
      return true
    return (
      !/^(?:what|why|how)\b/i.test(text) &&
      /\b(?:an? (?:issue|bug|problem)|is broken|doesn.t work|can.t work|couldn.t work|shouldn.t|should not)\b/i.test(
        text,
      )
    )
  }

  export function current(request: string | undefined, latest: string | undefined) {
    return !!request && request === latest && explicit(request)
  }

  /** A later in-turn Ask refusal revokes an earlier edit request until the user sends a new request. */
  export function declined(metadata: unknown) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
    const record = metadata as Record<string, unknown>
    if (record.terminal === true || record.dismissed === true) return true
    if (!Array.isArray(record.answers)) return false
    return record.answers.some((answer) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return false
      const row = answer as Record<string, unknown>
      const selected = Array.isArray(row.selected) ? row.selected : []
      return selected.some((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return false
        const id = (option as Record<string, unknown>).id
        return RayaAskOptions.terminalID(id)
      })
    })
  }

  /** Admit Auto children with a durable minimum authority and current-request-bound edits. */
  export function admit(input: {
    auto: boolean
    planned?: Access
    requested?: Access
    saved?: Access
    goalActive: boolean
    userEdit?: boolean
    parent: Permission.Ruleset
  }) {
    const requested = input.planned ?? input.requested ?? input.saved ?? (input.auto ? "read" : undefined)
    if (
      input.auto &&
      !input.planned &&
      (requested === "edit" || input.saved === "edit") &&
      !input.goalActive &&
      !input.userEdit
    )
      throw new Error("Auto editing requires an active goal or an explicit current user request")
    return select({ requested, saved: input.saved, parent: input.parent })
  }
}
