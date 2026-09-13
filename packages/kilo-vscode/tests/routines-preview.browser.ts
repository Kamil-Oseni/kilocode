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
      await expect(page.getByRole("button", { name: "Website Builders 2" })).toBeVisible()
      await expect(page.locator('.routines-unread[aria-label="1 unread"]').first()).toBeVisible()
      await expect(page.locator(".routines-row [data-component='checkbox']")).toHaveCount(0)
      await page.getByRole("button", { name: "Manage" }).click()
      await expect(page.locator(".routines-row [data-component='checkbox']").first()).toBeVisible()
      await page.getByRole("button", { name: "Done" }).click()
      await expect(page.locator(".routines-row [data-component='checkbox']")).toHaveCount(0)
      if (width === 900) {
        await page.getByRole("button", { name: "Books options" }).click()
        await expect(page.getByRole("menu")).toBeVisible()
        await expect(page.getByRole("menuitem", { name: "Edit schedule" })).toBeVisible()
        await page.keyboard.press("Escape")
        await expect(page.getByRole("menu")).toBeHidden()
      }
      await books.click()
      const thread = page.getByRole("region", { name: "Conversation with Books" })
      await expect(thread).toBeVisible()
      await expect(thread.getByLabel("Ask another worker")).toBeHidden()
      if (width === 320) await expect(page.getByRole("button", { name: "Back to Books" })).toBeVisible()
      else await expect(page.getByRole("button", { name: "Back to Books" })).toBeHidden()
      await expect(thread.getByText("Friday expenses increased in travel.")).toBeVisible()
      const people = page.locator(".routines-people")
      if (width === 320) {
        await expect(people).toBeHidden()
      } else {
        await expect(people).toBeVisible()
        await expect(page.locator('.routines-identity[data-routine-worker="legal"]')).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(
        await page.locator(".routines-line-body").evaluate((node) => {
          const wrap = getComputedStyle(node).overflowWrap
          return wrap === "anywhere" || wrap === "break-word"
        }),
      ).toBe(true)
      await expect(page.getByRole("button", { name: "Open vendor-travel-ledger-q3-close-final.pdf" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Open receipt.pdf" })).toBeVisible()
      const image = page.getByRole("button", { name: "Open travel-receipt.png" })
      await expect(image.getByRole("img", { name: "travel-receipt.png" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Attach" })).toBeVisible()
      expect(
        await page
          .locator(".routines-file-name")
          .first()
          .evaluate((node) => {
            const style = getComputedStyle(node)
            return style.textOverflow === "ellipsis" && node.clientWidth > 0
          }),
      ).toBe(true)
      const draft = page.getByLabel("Message this worker")
      await draft.fill("Keep this follow-up draft")
      await page.getByRole("button", { name: "Info", exact: true }).click()
      const panel = page.getByLabel("Chat info for Books")
      await expect(panel).toBeVisible()
      await expect(panel.getByRole("heading", { name: "About" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Files" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Links" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Worker communication" })).toBeVisible()
      await expect(panel.getByText("stripe.com", { exact: true })).toBeVisible()
      await expect(panel.getByText("receipt.pdf", { exact: true })).toBeVisible()
      await expect(panel.getByText("Counsel", { exact: true })).toBeVisible()
      await expect(panel.getByText("Website Builders · organization revision 1", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const infoResult = await new AxeBuilder({ page })
        .include(".routines-view")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
      expect(infoResult.violations).toEqual([])
      await page.screenshot({ path: info.outputPath("info.png"), fullPage: true })
      await page.keyboard.press("Escape")
      await expect(panel).toBeHidden()
      await expect(page.getByRole("button", { name: "Info", exact: true })).toBeFocused()
      await expect(draft).toHaveValue("Keep this follow-up draft")
      const result = await new AxeBuilder({ page })
        .include(".routines-view")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
      expect(result.violations).toEqual([])
      await page.screenshot({ path: info.outputPath("thread.png"), fullPage: true })
    })
  }
}

test("wide routines organization filters and opens worker DMs", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Website Builders 2" }).click()
  await expect(page.getByRole("heading", { name: "Website Builders" })).toBeVisible()
  await expect(page.getByText("Find, design, build, and support better client websites.")).toBeVisible()
  await expect(page.getByText("Reports to Counsel")).toBeVisible()
  await expect(page.getByText("Can create workers", { exact: true })).toBeVisible()
  await expect(page.getByText("Cannot create workers", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Finance 1" }).click()
  await expect(page.locator('.routines-identity[data-routine-worker="routine"]')).toBeVisible()
  await expect(page.locator('.routines-identity[data-routine-worker="legal"]')).toBeHidden()
  await page.getByRole("button", { name: /Books Accountant/ }).click()
  await expect(page.getByRole("region", { name: "Conversation with Books" })).toBeVisible()
  const result = await new AxeBuilder({ page })
    .include(".routines-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("organization.png"), fullPage: true })
})

test("routines organization editor separates reporting, delegation, and archive", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Website Builders 2" }).click()
  await page.getByRole("button", { name: "Edit organization" }).click()
  await expect(page.getByRole("heading", { name: "Team and reporting" })).toBeVisible()
  const counsel = page.locator(".routines-organization-edit-members li").filter({ hasText: "Counsel" })
  const authority = counsel.getByRole("checkbox", { name: "Can create workers" }).first()
  await expect(authority).toBeChecked()
  await counsel.getByText("Can create workers", { exact: true }).first().click()
  await expect(authority).not.toBeChecked()
  await expect(counsel.getByText("Changed by you", { exact: false })).toBeVisible()
  await expect(
    page.getByText("Reporting lines organize the team. They don’t grant permission to delegate work."),
  ).toBeVisible()
  await expect(page.getByRole("heading", { name: "Delegation permissions" })).toBeVisible()
  const lead = page.getByRole("group", { name: "Counsel can assign work to" })
  await expect(lead.getByRole("checkbox", { name: "Books" })).toBeChecked()
  await lead.getByText("Books", { exact: true }).click()
  await expect(lead.getByRole("checkbox", { name: "Books" })).not.toBeChecked()
  await page.getByLabel("Name").fill("Website Studio")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Edit organization" })).toBeHidden()

  await page.getByRole("button", { name: "Edit organization" }).click()
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Archive Website Builders?" })).toContainText(
    "Scheduled workers keep their current schedules",
  )
  await page.getByRole("button", { name: "Keep organization" }).click()
  await expect(page.getByRole("dialog", { name: "Archive Website Builders?" })).toBeHidden()
  const result = await new AxeBuilder({ page })
    .include(".routines-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("organization-editor.png"), fullPage: true })
})

test("production schedule preview keeps selected weekdays and timezone before confirmation", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Edit schedule" }).click()
  await expect(page.getByRole("heading", { name: "Edit schedule" })).toBeVisible()

  await page.getByLabel("Repeat").selectOption({ label: "Selected weekdays" })
  for (const day of ["Tuesday", "Wednesday", "Thursday"]) await page.getByLabel(day, { exact: true }).uncheck()
  await page.getByLabel("Time of day").fill("09:00")
  await page.getByLabel("Calendar timezone").fill("America/Toronto")
  await page.getByRole("button", { name: "Preview schedule" }).click()

  const preview = page.getByRole("status")
  await expect(preview).toContainText("0 9 * * 1,5")
  await expect(preview).toContainText("Timezone: America/Toronto")
  await expect(preview.locator("span").filter({ hasText: "2030" })).toHaveCount(3)
  await expect(page.getByRole("button", { name: "Confirm schedule change" })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const result = await new AxeBuilder({ page })
    .include(".routines-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
  await page.screenshot({ path: info.outputPath("schedule.png"), fullPage: true })

  await page.getByRole("button", { name: "Confirm schedule change" }).click()
  await expect(page.getByRole("heading", { name: "Edit schedule" })).toBeHidden()
})

test("narrow organization overview can return to the organization list", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Website Builders 2" }).click()
  await expect(page.getByRole("heading", { name: "Website Builders" })).toBeVisible()
  await expect(page.locator(".routines-people")).toBeHidden()
  await page.getByRole("button", { name: "Back to organizations from Website Builders" }).click()
  await expect(page.getByRole("button", { name: "Website Builders 2" })).toBeFocused()
  await expect(page.locator(".routines-people")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test("chat result target opens the matching organization", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines&target=organization")
  await expect(page.getByRole("heading", { name: "Website Builders" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Website Builders" })).toBeFocused()
})

test("organization revision conflict stays in the editor with recovery guidance", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines&scene=conflict")
  await page.getByRole("button", { name: "Website Builders 2" }).click()
  await page.getByRole("button", { name: "Edit organization" }).click()
  await page.getByLabel("Purpose").fill("A newer purpose")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("This organization changed after you opened it.")
  await expect(page.getByRole("alert")).toContainText("Review the refreshed team before saving again.")
  await expect(page.getByRole("heading", { name: "Edit organization" })).toBeVisible()
})

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
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("raya-preview-webview-state")))
    .toContain('"routine"')
  await page.reload()
  await expect(page.getByRole("region", { name: "Conversation with Books" })).toBeVisible()
  await expect(page.locator(".routines-people")).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("restored.png"), fullPage: true })
})

test("light routines at 200% zoom", async ({ browser }, info) => {
  const context = await browser.newContext({
    viewport: { width: 450, height: 450 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  })
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:5199/?state=light-routines")
  const books = page.locator('.routines-identity[data-routine-worker="routine"]')
  await expect(books).toBeVisible()
  await books.click()
  await expect(page.getByRole("region", { name: "Conversation with Books" })).toBeVisible()
  await page.getByRole("button", { name: "Info", exact: true }).click()
  const panel = page.getByLabel("Chat info for Books")
  await expect(panel.getByRole("heading", { name: "Worker communication" })).toBeVisible()
  const overflow = await panel.locator("*").evaluateAll((nodes) =>
    nodes
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({
        tag: node.tagName,
        className: node.className,
        client: node.clientWidth,
        scroll: node.scrollWidth,
      })),
  )
  expect(overflow).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("zoom.png"), fullPage: true })
  await context.close()
})
