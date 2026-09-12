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
      await expect(page.getByRole("heading", { name: "What would you like to get done?" })).toBeVisible()
      await expect(summary).toContainText("Preferred model")
      await expect(summary).toContainText("Claude Sonnet 4.6")
      await expect(summary).toContainText("Kilo")
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
      await expect(summary).toContainText("Reasoning: high")
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
      await expect(summary).toContainText("missing-provider")
      await expect(summary).toContainText("missing-model")
      await expect(summary).toContainText("unavailable")
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
