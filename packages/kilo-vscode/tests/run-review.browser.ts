import { expect, test, type Page } from "@playwright/test"

type Request = { type: "routineSnapshot"; agentID: string; runID: string; requestID: string }
type Fixture = {
  review: { clone: () => void; reorder: () => void; reply: (request: Request, objective: string) => void }
}

const requests = (page: Page) =>
  page
    .locator("body")
    .getAttribute("data-messages")
    .then((text) => {
      const rows: Request[] = JSON.parse(text ?? "[]")
      return rows.filter((row) => row.type === "routineSnapshot")
    })

const reply = (page: Page, request: Request, objective: string) =>
  page.evaluate(({ request, objective }) => (window as unknown as Fixture).review.reply(request, objective), {
    request,
    objective,
  })

const ready = async (page: Page) => {
  await page.goto("/")
  await expect(page.getByRole("combobox", { name: "Saved run" })).toHaveValue("third")
  await expect.poll(async () => (await requests(page)).length).toBe(1)
  const request = (await requests(page))[0]
  expect(request).toMatchObject({ agentID: "worker", runID: "third" })
  await reply(page, request, "Original third instructions")
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveText("Original third instructions")
  return request
}

const coherent = async (page: Page, id: string, minute: number) => {
  await expect(page.getByRole("combobox", { name: "Saved run" })).toHaveValue(id)
  await expect(page.getByText(`Exact ${id} final report`, { exact: true })).toBeVisible()
  await expect(page.locator(".routines-result > p").first()).toHaveText(
    `Scheduled for 10/19/2026, 8:${minute}:00 AM EDT · Startup began 10/19/2026, 8:${minute}:17 AM EDT`,
  )
}

test("cloned saved history preserves the selected run and its displayed instructions", async ({ page }) => {
  await ready(page)
  await coherent(page, "third", 48)
  await page.evaluate(() => (window as unknown as Fixture).review.clone())
  // Fresh history objects must not reset the native option independently of selected run metadata.
  await coherent(page, "third", 48)
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveText("Original third instructions")
  expect(await requests(page)).toHaveLength(1)
  await page.getByRole("button", { name: "Open conversation" }).click()
  await expect(page.locator("body")).toHaveAttribute("data-opened", "session-third")
  await page.evaluate(() => (window as unknown as Fixture).review.reorder())
  await coherent(page, "third", 48)
  await expect(page.getByRole("combobox", { name: "Saved run" }).locator("option")).toHaveText([
    /second$/,
    /fourth$/,
    /Stopped · third$/,
    /first$/,
  ])
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveText("Original third instructions")
  expect(await requests(page)).toHaveLength(1)
})

test("native Home and Enter selection binds request, result, times, conversation and instructions", async ({
  page,
}) => {
  const previous = await ready(page)
  const select = page.getByRole("combobox", { name: "Saved run" })
  await select.focus()
  await select.press("Home")
  await select.press("Enter")
  // No synthetic change event: this asserts the actual Chromium keyboard selection contract.
  await coherent(page, "first", 46)
  await expect.poll(async () => (await requests(page)).length).toBe(2)
  const request = (await requests(page))[1]
  expect(request).toMatchObject({ agentID: "worker", runID: "first" })
  expect(request.requestID).not.toBe(previous.requestID)
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveCount(0)
  await reply(page, previous, "Delayed third instructions")
  await coherent(page, "first", 46)
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveCount(0)
  await reply(page, request, "Original first instructions")
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveText("Original first instructions")
  await page.getByRole("button", { name: "Open conversation" }).click()
  await expect(page.locator("body")).toHaveAttribute("data-opened", "session-first")
  await reply(page, previous, "Duplicate delayed third instructions")
  await expect(page.getByLabel("Original instructions", { exact: true })).toHaveText("Original first instructions")
})
