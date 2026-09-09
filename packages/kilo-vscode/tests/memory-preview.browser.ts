import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  for (const width of [320, 460]) {
    for (const state of ["memory", "memory-legacy"]) {
      test(`${theme} ${state} at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/?state=${theme}-${state}`)
        const fixture = page.locator("[data-fixture]")
        await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
        const receipt = fixture.locator('[data-component="memory-provenance"]')
        const trigger = receipt.getByRole("button")
        await expect(trigger).toHaveAttribute("aria-expanded", "false")
        await page.keyboard.press("Tab")
        await expect(trigger).toBeFocused()
        expect(await trigger.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid")
        expect(
          await trigger.evaluate((node) => {
            const labels = node.querySelectorAll(":scope > span")
            return labels[1].getBoundingClientRect().top >= labels[0].getBoundingClientRect().bottom
          }),
        ).toBe(true)
        await page.keyboard.press("Enter")
        await expect(trigger).toHaveAttribute("aria-expanded", "true")
        await expect(receipt.getByText("This historical receipt is read-only.", { exact: false })).toBeVisible()
        await expect(
          receipt.getByText(state === "memory" ? "720 estimated tokens recorded." : "Token estimate was not recorded."),
        ).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        const result = await new AxeBuilder({ page })
          .include('[data-component="memory-provenance"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze()
        expect(result.violations).toEqual([])
        await page.screenshot({ path: info.outputPath("expanded.png"), fullPage: true })
        await page.keyboard.press("Space")
        await expect(trigger).toHaveAttribute("aria-expanded", "false")
        await expect(trigger).toBeFocused()
      })
    }
  }
}
