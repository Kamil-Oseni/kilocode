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
      await fixture.getByRole("button", { name: "Review correction" }).click()
      await expect(fixture.getByText("Review memory correction", { exact: true })).toBeVisible()
      await expect(fixture.getByTestId("context-outcome")).toHaveText("No context change submitted")
      await fixture.getByRole("button", { name: "Keep editing" }).click()
      await expect(fixture.getByText("Review memory correction", { exact: true })).toHaveCount(0)
      await fixture.getByRole("button", { name: "Review correction" }).click()
      await fixture.getByRole("button", { name: "Confirm correction" }).click()
      await expect(fixture.getByTestId("context-outcome")).toHaveText("Correction saved: Use the staging API")

      await fixture.getByLabel("Remove remembered context").fill("old production API")
      await fixture.getByRole("button", { name: "Review removal" }).click()
      await expect(fixture.getByText("Review memory removal", { exact: true })).toBeVisible()
      await fixture.getByRole("button", { name: "Confirm removal" }).click()
      await expect(fixture.getByTestId("context-outcome")).toHaveText("Removal requested: old production API")

      await fixture.getByRole("button", { name: "Review correction" }).click()
      await fixture.getByRole("button", { name: "Switch fixture project" }).click()
      await expect(fixture.getByRole("button", { name: "Confirm correction" })).toHaveCount(0)
      const nav = fixture.getByRole("navigation", { name: "Raya workspace" })
      await expect(nav.getByRole("button", { name: "Routines", exact: true })).toBeVisible()
      await nav.getByRole("button", { name: "Tasks", exact: true }).click()
      await expect(nav.getByRole("button", { name: "Tasks", exact: true })).toHaveAttribute("aria-current", "page")

      await fixture.getByRole("button", { name: "Edit proposed changes" }).click()
      const proposal = fixture.getByLabel("Proposed text: Preferences/lighting.md", { exact: true })
      await proposal.fill("Use calm colours")
      await proposal.press("End")
      await proposal.pressSequentially(" slowly")
      await expect(proposal).toBeFocused()
      await expect(proposal).toHaveValue("Use calm colours slowly")
      await fixture.getByRole("button", { name: "Save proposal revision" }).click()
      await expect(fixture.getByTestId("context-outcome")).toHaveText("Proposal edited: Use calm colours slowly")

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
