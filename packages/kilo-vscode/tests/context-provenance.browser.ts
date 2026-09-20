import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} context provenance at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/?state=${theme}-context`)
      const fixture = page.locator('[data-fixture][data-preview-kind="production-view"]')
      await expect(fixture.getByText(/raya-feature$/)).toBeVisible()
      await expect(fixture.getByText("project", { exact: true })).toBeVisible()
      await expect(fixture.getByText("IDX Error", { exact: true })).toBeVisible()
      await expect(fixture.getByText("Index is stale after the worktree changed.", { exact: true })).toBeVisible()

      await fixture.getByLabel("Correct remembered context").fill("Use the staging API")
      await fixture.getByRole("button", { name: "Save correction" }).click()
      await expect(fixture.getByTestId("context-outcome")).toHaveText("Correction saved: Use the staging API")

      await fixture.getByLabel("Remove remembered context").fill("old production API")
      await fixture.getByRole("button", { name: "Remove" }).click()
      await expect(fixture.getByTestId("context-outcome")).toHaveText("Removal requested: old production API")

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const result = await new AxeBuilder({ page })
        .include('[aria-label="Context provenance"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
      expect(result.violations).toEqual([])
      await page.screenshot({ path: info.outputPath("context.png"), fullPage: true })
    })
  }
}
