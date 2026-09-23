import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test("OpenAI voice admission preserves the task agent and displays missing-key recovery", async ({ page }) => {
  await page.goto("/?theme=dark")
  await page.getByRole("button", { name: "Select OpenAI preview without key", exact: true }).click()
  const summary = page.locator('.composer-configuration [data-slot="collapsible-trigger"]')
  await expect(summary).toContainText("Auto")
  await page.getByRole("button", { name: "Start voice", exact: true }).click()
  await expect(page.locator(".prompt-realtime-voice")).toContainText("Add your OpenAI API key")
  await expect(summary).toContainText("Auto")
  await expect(page.getByRole("button", { name: "Start voice", exact: true })).toBeVisible()
  const sent = await page.evaluate(
    () => (window as Window & { __composerMessages: { type: string }[] }).__composerMessages,
  )
  expect(sent.some((message) => message.type === "speechOpenAIStart" || message.type === "speechRealtimeStart")).toBe(
    false,
  )
})

test("busy composer keeps queue and stop actions clear", async ({ page }) => {
  await page.goto("/?theme=dark")
  const prompt = page.locator("textarea.prompt-input")

  await page.getByRole("button", { name: "Toggle busy", exact: true }).click()
  await prompt.fill("Continue with the next section")

  await expect(page.getByRole("status")).toHaveText("Send queues for the next safe step. Stop interrupts current work.")
  await expect(page.getByRole("button", { name: "Queue for the next safe step", exact: true })).toBeVisible()

  await prompt.fill("")
  await expect(page.getByRole("button", { name: "Stop work", exact: true })).toBeVisible()
})

for (const [theme, width] of [
  ["light", 320],
  ["dark", 760],
  ["contrast", 320],
] as const) {
  test(`${theme} first run offers one recommended setup at ${width}px`, async ({ page }, info) => {
    const failures: string[] = []
    page.on("pageerror", (error) => failures.push(error.stack ?? error.message))
    await page.setViewportSize({ width, height: 800 })
    if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
    await page.goto(`/?theme=${theme}&onboarding=1`)

    const setup = page.locator(".work-style-picker")
    const action = setup.getByRole("button", { name: "Review first", exact: true })
    await expect(page.getByRole("heading", { name: "Welcome to Raya" })).toBeVisible()
    await expect(setup.getByRole("heading", { name: "Choose how you want to work" })).toBeVisible()
    await expect(action).toBeVisible()
    await expect(setup.getByRole("button")).toHaveCount(1)
    await expect(setup).not.toContainText("High autonomy")
    await expect(setup).toContainText("Asks before editing files or running commands")
    await page.screenshot({ path: info.outputPath("recommended-setup.png"), fullPage: true })

    await action.click()
    await expect(action).toBeDisabled()
    expect(
      await page.evaluate(() =>
        (window as Window & { __composerMessages: { type: string; style?: string }[] }).__composerMessages.some(
          (message) => message.type === "applyWorkStyle" && message.style === "human-in-the-loop",
        ),
      ),
    ).toBe(true)

    await page.evaluate(() =>
      window.postMessage(
        { type: "workStyleApplyFailed", message: "Your setup was not saved. Try again.", rollbackFailed: false },
        "*",
      ),
    )
    await expect(setup.getByRole("alert")).toContainText("Your setup was not saved. Try again.")
    await expect(action).toBeEnabled()
    await page.screenshot({ path: info.outputPath("setup-error.png"), fullPage: true })

    await setup.getByRole("link", { name: "Settings." }).click()
    expect(
      await page.evaluate(() =>
        (window as Window & { __composerMessages: { type: string; tab?: string }[] }).__composerMessages.some(
          (message) => message.type === "openSettingsPanel" && message.tab === "autoApprove",
        ),
      ),
    ).toBe(true)

    await action.click()
    await page.evaluate(() => window.postMessage({ type: "workStyleApplied", style: "human-in-the-loop" }, "*"))
    await expect(page.getByRole("heading", { name: "What would you like to get done?" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
    const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
    expect(audit.violations).toEqual([])
    if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
    expect(failures).toEqual([])
    await page.screenshot({ path: info.outputPath("outcome-entry.png"), fullPage: true })
  })
}

for (const theme of ["light", "dark", "contrast"])
  for (const width of [320, 760]) {
    test(`${theme} outcome entry and real configuration controls at ${width}px`, async ({ page }, info) => {
      const failures: string[] = []
      page.on("pageerror", (error) => failures.push(error.stack ?? error.message))
      await page.setViewportSize({ width, height: 960 })
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.goto(`/?theme=${theme}`)
      expect(failures).toEqual([])
      const prompt = page.locator("textarea.prompt-input")
      const disclosure = page.locator(".composer-configuration")
      const summary = disclosure.locator('[data-slot="collapsible-trigger"]')
      const logo = page.getByRole("img", { name: "Raya" })
      await expect(page.getByRole("heading", { name: "What would you like to get done?" })).toBeVisible()
      await expect(logo).toBeVisible()
      if (theme === "contrast") {
        const colors = await logo.evaluate((node) => ({
          fill: getComputedStyle(node.querySelector("path")!).fill,
          text: getComputedStyle(document.body).color,
        }))
        expect(colors.fill).toBe(colors.text)
        const controls = await page
          .locator(
            '.prompt-input-hint-actions [data-component="button"], .prompt-input-hint-actions [data-component="icon-button"], .prompt-input-hint-actions .prompt-voice-orb',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              border: getComputedStyle(node).borderTopColor,
              style: getComputedStyle(node).borderTopStyle,
              text: getComputedStyle(document.body).color,
            })),
          )
        expect(controls.length).toBeGreaterThanOrEqual(3)
        expect(controls.every((item) => item.border === item.text && item.style === "solid")).toBe(true)
      }
      await expect(summary).toContainText("Auto · Claude Sonnet 4.6")
      await expect(summary).not.toContainText("Raya Gateway")
      await expect(summary).not.toContainText("Reasoning")
      await page.locator(".prompt-input-container").screenshot({ path: info.outputPath("collapsed.png") })
      await expect(summary).toHaveAttribute("aria-expanded", "false")
      await prompt.fill("Review this material and return a concise summary with caveats.")
      await summary.focus()
      await page.keyboard.press("Enter")
      await expect(summary).toHaveAttribute("aria-expanded", "true")
      await expect(disclosure).not.toContainText("Choose how Raya works")
      await expect(disclosure.locator(".composer-configuration-controls")).toBeVisible()
      await page.locator(".prompt-input-container").screenshot({ path: info.outputPath("expanded.png") })
      await disclosure.getByRole("button", { name: "Auto", exact: true }).click()
      await page.getByRole("option", { name: "Plan", exact: true }).click()
      await expect(summary).toContainText("Plan")
      await expect(prompt).toBeFocused()
      await expect(prompt).toHaveValue("Review this material and return a concise summary with caveats.")
      await summary.focus()
      await page.keyboard.press("Escape")
      await expect(summary).toHaveAttribute("aria-expanded", "false")
      await expect(summary).toBeFocused()
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openModelPicker", { detail: { source: "another-composer" } })),
      )
      await expect(summary).toHaveAttribute("aria-expanded", "false")
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openModelPicker", { detail: { source: "fixture" } })),
      )
      await expect(summary).toHaveAttribute("aria-expanded", "true")
      await expect(page.getByRole("tree", { name: "Select model" })).toBeVisible()
      await expect(page.getByRole("treeitem").filter({ hasText: "Claude Sonnet 4.6" }).first()).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(prompt).toBeFocused()
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openVariantPicker", { detail: { source: "fixture" } })),
      )
      await expect(page.getByRole("option", { name: "Default", exact: true })).toBeFocused()
      // A delayed prior picker callback must not steal the new option's focus.
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("focusPrompt", { detail: { restore: true, source: "fixture" } })),
      )
      await expect(page.getByRole("option", { name: "Default", exact: true })).toBeFocused()
      await page.getByRole("option", { name: "High", exact: true }).click()
      await expect(summary).not.toContainText("Reasoning")
      await expect(prompt).toBeFocused()
      await page.getByRole("button", { name: "Toggle connection", exact: true }).click()
      await prompt.press("Enter")
      await expect(page.locator("[data-sent]")).toHaveText("[]")
      await expect(prompt).toHaveValue("Review this material and return a concise summary with caveats.")
      await page.getByRole("button", { name: "Toggle connection", exact: true }).click()
      await page.getByRole("button", { name: "Switch session", exact: true }).click()
      await expect(prompt).toHaveValue("")
      await prompt.fill("Second session draft")
      await page.getByRole("button", { name: "Switch session", exact: true }).click()
      await expect(prompt).toHaveValue("Review this material and return a concise summary with caveats.")
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: "material.txt", mimeType: "text/plain", buffer: Buffer.from("Material for review") })
      await expect(page.locator(".prompt-input-container")).toContainText("material.txt")
      await prompt.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true })
      await expect(page.locator("[data-sent]")).toHaveText("[]")
      await prompt.press("Enter")
      await expect(page.locator("[data-sent]")).toContainText("material.txt")
      await expect(page.locator("[data-sent]")).toContainText('"agent":"plan"')
      await expect(page.locator("[data-sent]")).toContainText('"variant":"high"')
      await expect(page.locator("[data-sent]")).toContainText("anthropic/claude-sonnet-4-6")
      await prompt.fill("/goal Finish the report")
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("Report evidence") })
      await expect(page.locator(".prompt-input-container")).toContainText("report.txt")
      await prompt.press("Enter")
      await expect(prompt).toHaveValue("")
      await page.evaluate(() => {
        const sends = JSON.parse(document.querySelector("[data-sent]")!.textContent!)
        const args = sends.at(-1).args
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "sendMessageFailed",
              error: "Goal start was not confirmed",
              text: args[0],
              files: args[3],
              sessionID: args[7],
              messageID: "fixture-goal-send",
            },
          }),
        )
      })
      await expect(prompt).toHaveValue("/goal Finish the report")
      await expect(page.locator(".prompt-input-container")).toContainText("report.txt")
      expect(await page.locator("[data-sent]").evaluate((node) => JSON.parse(node.textContent!).length)).toBe(2)
      await prompt.press("Enter")
      await expect(prompt).toHaveValue("")
      expect(await page.locator("[data-sent]").evaluate((node) => JSON.parse(node.textContent!).length)).toBe(3)
      await page.getByRole("button", { name: "Unavailable model", exact: true }).click()
      await expect(summary).not.toContainText("missing-provider")
      await expect(summary).toContainText("missing-model")
      await expect(summary).toContainText("Model unavailable")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      // Axe reads authored foreground values rather than forced system colors.
      // Audit the configured high-contrast palette, then capture system rendering.
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
      const audit = await new AxeBuilder({ page })
        .include(".composer-configuration")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(audit.violations).toEqual([])
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      expect(failures).toEqual([])
      await page.screenshot({ path: info.outputPath("composer.png"), fullPage: true })
    })
  }
