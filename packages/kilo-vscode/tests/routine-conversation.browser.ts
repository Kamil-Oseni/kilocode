import { expect, test, type Page } from "@playwright/test"

type Fixture = {
  conversation: {
    refresh: (mode?: string) => Promise<void>
    hold: () => Promise<void>
    finish: () => Promise<void>
    release: () => void
    remove: () => void
  }
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("Actual App fixture error:", err))
})

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return
  await info.attach("actual-dom", { body: await page.locator("body").innerHTML(), contentType: "text/html" })
})

async function open(page: Page) {
  await page
    .getByRole("navigation", { name: "Raya workspace" })
    .getByRole("button", { name: "Routines", exact: true })
    .click()
  await page.getByRole("button", { name: "Conversation worker options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Review runs", exact: true }).click()
  await page.getByRole("button", { name: "Open conversation", exact: true }).click()
  await expect(page.locator("body")).toHaveAttribute("data-held", "session-routine")
  await expect(page.locator("body")).toHaveAttribute("data-opened", /session-routine/)
}

test("explicit Routine conversation survives a filtered ordinary catalog while original messages load", async ({
  page,
}) => {
  await page.goto("/")
  await open(page)
  await page.evaluate(() => (window as unknown as Fixture).conversation.refresh())
  await expect(page.locator("body")).toHaveAttribute("data-opened", /session-routine/)
  await page.evaluate(() => (window as unknown as Fixture).conversation.release())
  await expect(page.getByText("Original saved question", { exact: true })).toBeVisible()
  await expect(page.getByText("Original saved answer — café 日本語.", { exact: true })).toBeVisible()
  await page.evaluate(() => (window as unknown as Fixture).conversation.refresh())
  await expect(page.getByText("Original saved answer — café 日本語.", { exact: true })).toBeVisible()
  await page.evaluate(() => (window as unknown as Fixture).conversation.remove())
  await expect(page.getByText("Original saved answer — café 日本語.", { exact: true })).toHaveCount(0)
})

test("an older filtered catalog cannot evict a Routine opened while its request was held", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => (window as unknown as Fixture).conversation.hold())
  await open(page)
  await page.evaluate(() => (window as unknown as Fixture).conversation.finish())
  await expect(page.locator("body")).toHaveAttribute("data-opened", /session-routine/)
  await page.evaluate(() => (window as unknown as Fixture).conversation.release())
  await expect(page.getByText("Original saved question", { exact: true })).toBeVisible()
  await expect(page.getByText("Original saved answer — café 日本語.", { exact: true })).toBeVisible()
})

test("an unknown omitted-session lookup retains the selected conversation and its saved messages", async ({ page }) => {
  await page.goto("/")
  await open(page)
  const failed = await page.evaluate(async () => {
    try {
      await (window as unknown as Fixture).conversation.refresh("unknown")
      return false
    } catch (err) {
      return err instanceof Error && err.message === "Catalog fixture failed"
    }
  })
  expect(failed).toBe(true)
  await expect(page.locator("body")).toHaveAttribute("data-opened", /session-routine/)
  await page.evaluate(() => (window as unknown as Fixture).conversation.release())
  await expect(page.getByText("Original saved answer — café 日本語.", { exact: true })).toBeVisible()
})

for (const mode of ["missing", "archived", "identity", "foreign"])
  test(`a ${mode} direct lookup cannot preserve a filtered Routine tab`, async ({ page }) => {
    await page.goto("/")
    await open(page)
    await page.evaluate((value) => (window as unknown as Fixture).conversation.refresh(value), mode)
    await expect(page.locator("body")).not.toHaveAttribute("data-opened", /session-routine/)
    await page.evaluate(() => (window as unknown as Fixture).conversation.release())
    await expect(page.getByText("Original saved answer — café 日本語.", { exact: true })).toHaveCount(0)
  })
