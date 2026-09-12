import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} composer at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-composer`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      const prompt = page.locator("textarea.prompt-input")
      await expect(prompt).toBeVisible()
      await expect(prompt).toHaveAttribute("placeholder", /Describe the result you need/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      const result = await new AxeBuilder({ page }).include(".prompt-input-container").analyze()
      expect(result.violations).toEqual([])
      await page.screenshot({ path: info.outputPath("composer.png"), fullPage: true })
    })

    test(`${theme} history at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-history`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByRole("tab", { name: "Local" })).toBeVisible()
      await expect(page.getByPlaceholder("Search sessions...")).toBeVisible()
      await expect(page.getByText("Inline edit-review chrome")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath("history.png"), fullPage: true })
    })

    test(`${theme} topnav at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-topnav`)
      await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByText("Redesign Raya into an editorial system")).toBeVisible()
      await expect(page.getByRole("button", { name: "Compact session" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Toggle timeline" })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath("topnav.png"), fullPage: true })
    })
  }
}

test("light review cluster and file chrome", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-review")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByText("Review changes")).toBeVisible()
  await expect(page.getByText("+128")).toBeVisible()
  await expect(page.getByRole("button", { name: "Keep all" })).toBeVisible()
  await page.goto("/?state=light-review-undo")
  await expect(page.getByRole("button", { name: "Confirm undo" })).toBeVisible()
  await page.goto("/?state=light-edit-review")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByRole("button", { name: "Undo file" }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Keep file" }).first()).toBeVisible()
  await expect(page.getByText("Renamed file")).toBeVisible()
  await expect(page.getByText("Deleted file")).toBeVisible()
  await expect(page.getByRole("button", { name: "Open src/review/rename.ts in the editor" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open src/styles/legacy-composer.css in the editor" })).toBeVisible()
  await expect(page.getByText("1 of 4").first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("review.png"), fullPage: true })
})

test("light slash, transcript, and conversation", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-slash")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.locator('[data-highlight="slash"][data-command="goal"]')).toHaveText("/goal")
  await expect(page.locator('[data-highlight="slash"][data-command="loop"]')).toHaveText("/loop")
  await page.goto("/?state=light-transcript")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByText("prompt-input.css")).toBeVisible()
  await expect(page.getByText("bun run typecheck")).toBeVisible()
  await page.goto("/?state=light-conversation")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.locator('[data-highlight="slash"][data-command="goal"]')).toBeVisible()
  await expect(page.locator(".tool-group__count").first()).toContainText("steps")
  await expect(page.getByText("Here's the change to the composer stylesheet.")).toBeVisible()
  await page.screenshot({ path: info.outputPath("chrome.png"), fullPage: true })
})

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} result package at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-result`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByText("Goal accepted through review")).toBeVisible()
      await expect(page.getByText("Evidence references accepted", { exact: true })).toBeVisible()
      await expect(page.getByText("bunx playwright test --config playwright.preview.config.ts").first()).toBeVisible()
      await expect(page.getByText("Not verified. Optional criteria do not prevent goal completion.")).toBeVisible()
      await expect(page.getByRole("button", { name: "Copy goal report" })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath("result.png"), fullPage: true })
    })
  }
}

test("light criteria editor", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-editing")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByRole("textbox", { name: "Update the goal" })).toBeVisible()
  await expect(page.locator("legend", { hasText: "Acceptance criteria" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Criterion 1", exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Command for criterion 1", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Update goal" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath("editor.png"), fullPage: true })
})
