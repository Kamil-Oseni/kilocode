// raya_change - local semantic sensitivity checks for autonomous Computer Use
import type { ActionClassification, SensitiveCategory } from "./lease"

const rules: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = [
  ["credentials", /\b(password|passcode|credential|api key|secret)\b/i],
  ["financial", /\b(pay|payment|purchase|buy|checkout|transfer funds?)\b/i],
  ["software", /\b(install|uninstall)\b/i],
  ["system", /\b(firewall|security settings?|administrator settings?)\b/i],
  ["deletion", /\b(delete|erase permanently|permanently delete)\b/i],
  ["disclosure", /\b(upload|attach files?|choose files?)\b/i],
  ["legal", /\b(accept terms|agree to terms|sign contract)\b/i],
  ["publishing", /\b(publish|deploy|push changes?|commit changes?|public post)\b/i],
  ["communications", /\b(send|email|message|reply)\b/i],
]

export function infer(target: unknown): SensitiveCategory | undefined {
  if (!target || typeof target !== "object" || !("kind" in target)) return undefined
  const text =
    target.kind === "role" && "name" in target && typeof target.name === "string"
      ? target.name
      : target.kind === "label" && "text" in target && typeof target.text === "string"
        ? target.text
        : undefined
  if (!text) return undefined
  return rules.find(([, pattern]) => pattern.test(text))?.[0]
}

export function mismatch(value: ActionClassification, expected: SensitiveCategory | undefined): string | undefined {
  return !expected || value === expected
    ? undefined
    : `Accessible target semantics require sensitive_category=${expected}`
}
