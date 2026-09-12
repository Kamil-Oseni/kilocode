import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  for (const width of [320, 900]) {
    test(`${theme} routines at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-routines`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      const books = page.locator('.routines-identity[data-routine-worker="routine"]')
      await expect(books).toBeVisible()
      await expect(page.getByText("1 unread").first()).toBeVisible()
      await books.click()
      const thread = page.getByRole("region", { name: "Conversation with Books" })
      await expect(thread).toBeVisible()
      await expect(page.getByRole("button", { name: "Back to Books" })).toBeVisible()
      await expect(thread.getByText("Friday expenses increased in travel.")).toBeVisible()
      const people = page.locator(".routines-people")
      if (width === 320) {
        await expect(people).toBeHidden()
      } else {
        await expect(people).toBeVisible()
        await expect(page.locator('.routines-identity[data-routine-worker="legal"]')).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await page.locator(".routines-line-body").evaluate((node) => {
          const wrap = getComputedStyle(node).overflowWrap
          return wrap === "anywhere" || wrap === "break-word"
        }),
      ).toBe(true)
      await expect(page.getByRole("button", { name: "Open vendor-travel-ledger-q3-close-final.pdf" })).toBeVisible()
      expect(
        await page.locator(".routines-file-name").evaluate((node) => {
          const style = getComputedStyle(node)
          return style.textOverflow === "ellipsis" && node.scrollWidth <= node.clientWidth + 1
        }),
      ).toBe(true)
      const result = await new AxeBuilder({ page })
        .include(".routines-view")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
      expect(result.violations).toEqual([])
      await page.screenshot({ path: info.outputPath("thread.png"), fullPage: true })
    })
  }
}

test("light routines empty state", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-routines&scene=empty")
  await expect(page.getByText("No standing jobs yet.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Assign a routine" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("empty.png"), fullPage: true })
})

test("light routines error state", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-routines&scene=error")
  await expect(page.getByRole("alert")).toContainText("The routine list could not be refreshed")
  await expect(page.getByRole("button", { name: "Dismiss message" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("error.png"), fullPage: true })
})

test("light routines stale history", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines&scene=stale")
  await expect(page.getByText("History may be stale: Recorded history could not be refreshed.")).toBeVisible()
  await page.screenshot({ path: info.outputPath("stale.png"), fullPage: true })
})

test("light routines loading state", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-routines&scene=loading")
  const status = page.locator('[role="status"][aria-busy="true"]')
  await expect(status).toContainText("Refreshing routines and recorded history...")
  await page.screenshot({ path: info.outputPath("loading.png"), fullPage: true })
})

test("light routines keyboard and file cards", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  const search = page.getByLabel("Search workers")
  const books = page.locator('.routines-identity[data-routine-worker="routine"]')
  await search.click()
  for (let i = 0; i < 12; i++) {
    if (await books.evaluate((node) => node === document.activeElement)) break
    await page.keyboard.press("Tab")
  }
  await expect(books).toBeFocused()
  expect(
    await books.evaluate((node) => {
      const style = getComputedStyle(node)
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px"
    }),
  ).toBe(true)
  await page.keyboard.press("Enter")
  const thread = page.getByRole("region", { name: "Conversation with Books" })
  await expect(thread).toBeVisible()
  const card = page.getByRole("button", { name: "Open vendor-travel-ledger-q3-close-final.pdf" })
  await expect(card).toBeVisible()
  await expect(page.getByRole("list", { name: "Attached files" })).toBeVisible()
  await expect(thread).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(thread).toBeHidden()
  await expect(books).toBeFocused()
  await page.screenshot({ path: info.outputPath("keyboard.png"), fullPage: true })
})

test("narrow routines restore the selected worker after reload", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-routines")
  await page.locator('.routines-identity[data-routine-worker="routine"]').click()
  const thread = page.getByRole("region", { name: "Conversation with Books" })
  await expect(thread).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("raya-preview-webview-state"))).toContain('"routine"')
  await page.reload()
  await expect(page.getByRole("region", { name: "Conversation with Books" })).toBeVisible()
  await expect(page.locator(".routines-people")).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("restored.png"), fullPage: true })
})

test("light routines at 200% zoom", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2"
  })
  const books = page.locator('.routines-identity[data-routine-worker="routine"]')
  await expect(books).toBeVisible()
  await books.click()
  await expect(page.getByRole("region", { name: "Conversation with Books" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("zoom.png"), fullPage: true })
})
