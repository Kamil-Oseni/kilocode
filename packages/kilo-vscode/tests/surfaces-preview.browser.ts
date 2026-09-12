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
  await expect(page.getByText("1 of 3").first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("review.png"), fullPage: true })
})
