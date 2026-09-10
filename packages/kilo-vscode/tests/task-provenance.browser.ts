import { expect, test } from "@playwright/test"

for (const width of [320, 460]) {
  test(`actual task selection wraps and updates at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/")
    const caption = page.locator('[data-slot="task-model-selection"]')
    await expect(caption).toContainText("from agent configuration; Variant")
    await expect(caption).toContainText("from model override")
    const box = await caption.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        width: window.innerWidth,
        scroll: node.scrollWidth,
        client: node.clientWidth,
      }
    })
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(box.width)
    expect(box.scroll).toBeLessThanOrEqual(box.client + 1)
    await page.getByRole("button", { name: "Legacy", exact: true }).click()
    await expect(caption).toHaveText("Model source not recorded")
    await page.getByRole("button", { name: "Malformed", exact: true }).click()
    await expect(caption).toHaveText("Model selection details unavailable")
    await page.getByRole("button", { name: "Current", exact: true }).click()
    await expect(caption).toContainText("from agent configuration; Variant")
    await page.screenshot({ path: test.info().outputPath(`task-provenance-${width}.png`) })
  })
}
