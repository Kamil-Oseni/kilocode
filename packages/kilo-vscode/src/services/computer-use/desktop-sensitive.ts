import type { SensitiveCategory } from "./lease-store"
import type { DesktopAction, DesktopControl, DesktopSemantics } from "./desktop-session"

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

function infer(control: DesktopControl): SensitiveCategory[] {
  const text = `${control.name ?? ""} ${control.automationID ?? ""}`.trim()
  if (!text) return []
  return rules.filter(([, pattern]) => pattern.test(text)).map(([category]) => category)
}

function at(semantics: DesktopSemantics, x: number, y: number): DesktopControl[] {
  const px = semantics.viewport.x + Math.round(x * (semantics.viewport.width - 1))
  const py = semantics.viewport.y + Math.round(y * (semantics.viewport.height - 1))
  return semantics.controls.filter(
    (control) =>
      control.enabled &&
      px >= control.x &&
      py >= control.y &&
      px < control.x + control.width &&
      py < control.y + control.height &&
      !!(control.name || control.automationID),
  )
}

function targets(action: DesktopAction, semantics: DesktopSemantics): DesktopControl[] {
  if (action.operation === "pointer" && action.action !== "move") {
    return at(semantics, action.x, action.y)
  }
  if (action.operation === "drag") {
    const start = at(semantics, action.startX, action.startY)
    const end = at(semantics, action.endX, action.endY)
    return [...start, ...end]
  }
  if (action.operation === "type" || action.operation === "key")
    return semantics.controls.filter((control) => control.enabled && control.focused)
  return []
}

export function mismatch(action: DesktopAction, semantics: DesktopSemantics | undefined): string | undefined {
  if (!semantics || semantics.status !== "available") return
  const expected = [...new Set(targets(action, semantics).flatMap(infer))]
  if (expected.length === 0) return
  if (expected.length > 1)
    return "Accessible desktop target spans multiple sensitive policy categories; no action was dispatched"
  if (action.sensitive === expected[0]) return
  return `Accessible desktop target semantics require sensitive_category=${expected[0]}`
}
