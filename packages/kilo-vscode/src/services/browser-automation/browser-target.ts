export type BrowserTarget =
  | string
  | ({ kind: "role"; role: string; name: string } & { scope?: string })
  | ({ kind: "label"; text: string } & { scope?: string })
  | ({ kind: "testid"; value: string } & { scope?: string })

export class TargetError extends Error {
  readonly name = "BrowserTargetError"
}

export interface TargetLocator {
  elementHandle?(): Promise<TargetElement | null>
  ariaSnapshot?(options?: { timeout?: number }): Promise<string>
  count?(): Promise<number>
  getByRole?(role: string, options?: { name?: string | RegExp; exact?: boolean }): TargetLocator
  getByLabel?(text: string, options?: { exact?: boolean }): TargetLocator
  getByTestId?(value: string): TargetLocator
  click(options?: { timeout?: number }): Promise<void>
  fill(text: string, options?: { timeout?: number }): Promise<void>
  press(key: string, options?: { timeout?: number }): Promise<void>
  selectOption(values: string[], options?: { timeout?: number }): Promise<unknown>
  isVisible(options?: { timeout?: number }): Promise<boolean>
  textContent(options?: { timeout?: number }): Promise<string | null>
  evaluate?<R, A>(fn: (element: HTMLElement, arg: A) => R, arg: A): Promise<R>
}

export interface TargetPage {
  locator(selector: string): TargetLocator
  getByRole?(role: string, options?: { name?: string | RegExp; exact?: boolean }): TargetLocator
  getByLabel?(text: string, options?: { exact?: boolean }): TargetLocator
  getByTestId?(value: string): TargetLocator
}

const sensitive: ReadonlyArray<readonly [string, RegExp]> = [
  ["credentials", /\b(password|passcode|credential|api key|secret)\b/i],
  ["financial", /\b(pay|payment|purchase|buy|checkout|transfer funds?)\b/i],
  ["software", /\b(install|uninstall)\b/i],
  ["system", /\b(firewall|security settings?|administrator settings?)\b/i],
  ["deletion", /\b(delete|erase permanently|permanently delete)\b/i],
  ["disclosure", /\b(upload|attach files?|choose files?)\b/i],
  ["legal", /\b(accept terms|agree to terms|sign contract)\b/i],
  ["publishing", /\b(publish|deploy|push changes?|commit changes?|public post)\b/i],
  ["communications", /\b(send|reply|post)\b/i],
]

/** Recheck the resolved element's browser-owned accessible name, including CSS and test-ID targets. */
export async function checkSensitive(locator: TargetLocator, category: string | false): Promise<void> {
  if (!locator.ariaSnapshot) throw new TargetError("Browser host cannot inspect the target before input")
  const snapshot = await locator.ariaSnapshot({ timeout: 5_000 })
  const line = snapshot.split("\n", 1)[0]?.trim()
  if (!line) throw new TargetError("Browser target has no accessible semantics before input")
  if (/^-\s*(generic|group)\b/i.test(line))
    throw new TargetError("Browser target has no actionable accessible role; select the exact control before input")
  const matches = sensitive
    .filter(([name, pattern]) =>
      name === "communications"
        ? /^-\s*(button|link|menuitem|option|tab)\b/i.test(line) && pattern.test(line)
        : pattern.test(line),
    )
    .map(([name]) => name)
  if (matches.length > 1)
    throw new TargetError("Browser target spans multiple sensitive policy categories; no action was dispatched")
  if (matches.length === 1 && matches[0] !== category)
    throw new TargetError(`Browser target semantics require sensitive_category=${matches[0]}; no action was dispatched`)
}

async function unique(locator: TargetLocator, description: string) {
  if (!locator.count) throw new TargetError("Browser host cannot verify semantic target uniqueness")
  const count = await locator.count()
  if (count !== 1) throw new TargetError(`Browser ${description} matched ${count} elements; expected exactly one`)
  return locator
}

export async function locate(page: TargetPage, target: BrowserTarget): Promise<TargetLocator> {
  if (typeof target === "string") return page.locator(target)
  if (!target || typeof target !== "object") throw new TargetError("Invalid browser target")
  const fields =
    target.kind === "role"
      ? ["role", "name"]
      : target.kind === "label"
        ? ["text"]
        : target.kind === "testid"
          ? ["value"]
          : []
  const values = target as unknown as Record<string, unknown>
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 10_000
  if (
    fields.length === 0 ||
    fields.some((field) => !text(values[field])) ||
    (target.scope !== undefined && !text(target.scope)) ||
    Object.keys(target).some((key) => !["kind", "scope", ...fields].includes(key))
  )
    throw new TargetError("Invalid browser semantic target")
  const scope = target.scope ? await unique(page.locator(target.scope), "target scope") : page
  const locator =
    target.kind === "role"
      ? scope.getByRole?.(target.role, { name: target.name, exact: true })
      : target.kind === "label"
        ? scope.getByLabel?.(target.text, { exact: true })
        : scope.getByTestId?.(target.value)
  if (!locator) throw new TargetError(`Browser host does not support ${target.kind} targets`)
  return unique(locator, `${target.kind} target`)
}

export function describe(target: BrowserTarget): string {
  return typeof target === "string" ? target : JSON.stringify(target)
}

export interface TargetElement extends TargetLocator {
  setInputFiles?(files: string[], options?: { timeout?: number }): Promise<void>
  contentFrame?(): Promise<import("./browser-frame").DocumentFrame | null>
  dispose?(): Promise<void>
}
