import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const audit = async (page: import("@playwright/test").Page) => {
  const result = await new AxeBuilder({ page })
    .include(".admin-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

for (const theme of ["light", "dark", "contrast"])
  for (const width of [320, 760]) {
    test(`${theme} System Health at ${width}px`, async ({ page }, info) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 720 })
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.goto(`/?theme=${theme}`)
      await expect(page.getByRole("heading", { name: "System health" })).toBeVisible()
      await expect(page.getByText("All systems ready", { exact: true })).toBeVisible()
      await expect(page.locator(".admin-row")).toHaveCount(6)
      await expect(page.getByText("Healthy", { exact: true })).toHaveCount(6)
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
      await audit(page)
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.screenshot({ path: info.outputPath("system-health.png"), fullPage: true })
      expect(errors).toEqual([])
    })
  }

test("renders partial and unknown services without hiding known results", async ({ page }) => {
  await page.goto("/?state=partial")
  await expect(page.getByText("Partial", { exact: true })).toBeVisible()
  await expect(page.getByText("Needs attention", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(2)
  await expect(page.getByText("No signal available", { exact: true })).toHaveCount(2)
  await audit(page)
})

test("shows disconnected services and does not send an admin request", async ({ page }) => {
  await page.goto("/?state=disconnected")
  await expect(page.locator(".admin-intro strong")).toHaveText("Disconnected")
  await expect(page.getByText("Offline", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(5)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message: { type: string }) => message.type === "requestAdmin")).toEqual([])
  await audit(page)
})

test("keeps current health visible when diagnostics fail", async ({ page }) => {
  await page.goto("/?state=logs-error")
  await expect(page.getByText("All systems ready", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Recent diagnostics could not be loaded")
  await expect(page.locator(".admin-row")).toHaveCount(6)
  await expect(page.getByText("No diagnostic entries yet", { exact: false })).toBeVisible()
  await audit(page)
})

test("shows an empty diagnostic state", async ({ page }) => {
  await page.goto("/?state=empty")
  await expect(
    page.getByText("No diagnostic entries yet. Refresh to run a health check.", { exact: true }),
  ).toBeVisible()
  await audit(page)
})

test("retries a failed request from the keyboard", async ({ page }) => {
  await page.goto("/?state=retry")
  await expect(page.getByRole("alert")).toContainText("System health could not be checked")
  const retry = page.getByRole("button", { name: "Try again" })
  await retry.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("All systems ready", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message: { type: string }) => message.type === "requestAdmin")).toHaveLength(2)
  await audit(page)
})

test("keeps 48 diagnostics inside the view and preserves keyboard navigation", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 520 })
  await page.goto("/?state=long")
  await expect(page.locator(".admin-log > li")).toHaveCount(48)
  const refresh = page.getByRole("button", { name: "Refresh" })
  await refresh.focus()
  await expect(refresh).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(page.getByRole("button", { name: "Back" })).toBeFocused()
  expect(await page.locator(".admin-view").evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
  await audit(page)
  await page.screenshot({ path: info.outputPath("system-health-long.png"), fullPage: true })
  await page.locator(".admin-view").evaluate((node) => node.scrollTo(0, node.scrollHeight))
  await page.screenshot({ path: info.outputPath("system-health-long-bottom.png") })
})
