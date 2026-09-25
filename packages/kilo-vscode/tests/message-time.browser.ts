import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

async function semantic(page: Page, selector: string, count: number) {
  const times = page.locator(selector)
  await expect(times).toHaveCount(count)
  for (const time of await times.all()) {
    await expect(time).toBeVisible()
    await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/)
    const title = await time.getAttribute("title")
    expect(title).toBeTruthy()
    await expect(time).toHaveAttribute("aria-label", title!)
    await expect(time).not.toHaveText("")
  }
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} semantic chat time at ${width}px`, async ({ page }, info) => {
      test.setTimeout(60_000)
      await page.setViewportSize({ width, height: 900 })

      await page.goto(`/?state=${theme}-conversation`)
      await semantic(page, '[data-fixture] [data-component="message-time"]', 2)
      const meta = page.locator('[data-slot="assistant-copy-wrapper"] [data-component="message-time"]')
      await expect(meta).toHaveCount(1)
      await expect(page.locator('[data-component="assistant-throughput"]')).toHaveCount(0)
      const copy = await page.locator('[data-slot="assistant-copy-wrapper"] [data-component="icon-button"]').first().boundingBox()
      const time = await meta.boundingBox()
      expect(copy && time && Math.abs(copy.y - time.y) < 10).toBeTruthy()
      const user = page.locator('[data-fixture] [data-row="user"]')
      const footer = user.locator('[data-component="message-time"]')
      await expect(footer).toHaveCSS("opacity", "0")
      await user.hover()
      await expect(footer).toHaveCSS("opacity", "1")
      await page.locator('[data-component="message-timeline"]').hover()
      await expect(footer).toHaveCSS("opacity", "0")
      await semantic(page, '[data-fixture] [data-component="message-timeline"] time', 1)
      await expect(page.locator('[data-component="message-timeline"]')).toContainText("Today")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      expect((await new AxeBuilder({ page }).include(".chat-view").analyze()).violations).toEqual([])
      await page.screenshot({ path: info.outputPath("conversation-timeline.png"), fullPage: true })

      await page.goto(`/?state=${theme}-transcript`)
      await semantic(page, '[data-fixture] [data-component="message-time"]', 1)

      await page.goto(`/?state=${theme}-routines`)
      await page.locator('.routines-identity[data-routine-worker="routine"]').click()
      await semantic(page, '[data-routine-message] [data-component="message-time"]', 1)

      await page.goto(`/?state=${theme}-messenger`)
      await semantic(page, '[data-messenger-message] [data-component="message-time"]', 2)
      await expect(page.locator('[data-messenger-message="assistant"] time')).toHaveAttribute(
        "datetime",
        "2016-07-30T23:54:10.259Z",
      )
      await expect(page.locator('[data-messenger-message="invalid"] time')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      expect((await new AxeBuilder({ page }).include(".pv-messenger").analyze()).violations).toEqual([])
      await page.screenshot({ path: info.outputPath("messenger-time.png"), fullPage: true })
    })
  }
}
