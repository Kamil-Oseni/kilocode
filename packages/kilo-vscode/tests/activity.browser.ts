import { expect, test } from "@playwright/test"

test("completed chat activity stays calm until expanded", async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 900 })
  await page.goto("/?state=dark-conversation")

  const group = page.locator('[data-row="activity"]')
  const trigger = group.locator(".transcript-activity__trigger")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(group.locator('[data-component="tool-part-wrapper"]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("activity-collapsed.png"), fullPage: true })
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(group.locator('[data-component="tool-part-wrapper"]')).not.toHaveCount(0)
  await page.screenshot({ path: info.outputPath("activity-expanded.png"), fullPage: true })
  await trigger.click()
  await expect(group.locator('[data-component="tool-part-wrapper"]')).toHaveCount(0)
})

test("chat header and answer divider use the same grey hairline", async ({ page }) => {
  await page.goto("/?state=dark-topnav")
  await expect(page.locator(".chat-header-panel")).toHaveCSS("border-bottom-color", "rgb(39, 39, 40)")
  await page.goto("/?state=dark-conversation")
  const line = page.locator("[data-section-break]")
  const color = await line.evaluate((element) => getComputedStyle(element, "::before").borderTopColor)
  const margin = await line.evaluate((element) => getComputedStyle(element, "::before").marginTop)
  expect(color).toBe("rgb(39, 39, 40)")
  expect(margin).toBe("2px")
})
