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
      await page.setViewportSize({ width, height: 900 })

      await page.goto(`/?state=${theme}-conversation`)
      await semantic(page, '[data-fixture] [data-component="message-time"]', 2)

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
