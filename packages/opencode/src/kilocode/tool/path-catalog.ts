import { Permission } from "@/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

/** Discovery is not permission to execute: file tools still authorize the selected path. */
export function visible(id: string, rules: Permission.Ruleset) {
  if (Permission.evaluate(id, "*", rules).action !== "deny") return true
  if (!["read", "write", "edit", "apply_patch"].includes(id)) return false
  return rules.some(
    (rule) =>
      rule.action === "allow" &&
      rule.pattern !== "*" &&
      Wildcard.match(id, rule.permission) &&
      Permission.evaluate(id, rule.pattern, rules).action === "allow",
  )
}
