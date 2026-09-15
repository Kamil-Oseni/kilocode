import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const audit = async (page: import("@playwright/test").Page) => {
  const result = await new AxeBuilder({ page })
    .include('[data-component="personal-todo"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

for (const theme of ["light", "dark", "contrast"])
  for (const width of [320, 760]) {
    test(`${theme} TodoView at ${width}px`, async ({ page }, info) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 720 })
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.goto(`/?theme=${theme}`)
      await expect(page.getByRole("heading", { name: "Todo" })).toBeVisible()
      await expect(page.getByRole("list", { name: "Personal todos" })).toBeVisible()
      await expect(page.getByText("1 open", { exact: true })).toBeVisible()
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
      await audit(page)
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.screenshot({ path: info.outputPath("todo.png"), fullPage: true })
      expect(errors).toEqual([])
    })
  }

test("shows loading and empty states", async ({ page }) => {
  await page.goto("/?state=loading")
  await expect(page.getByRole("status")).toContainText("Loading your todos")
  await page.goto("/?state=empty")
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toBeVisible()
  await expect(page.getByText("Add one clear next step above.", { exact: true })).toBeVisible()
  await audit(page)
})

test("adds, completes, reopens and confirms deletion from the keyboard", async ({ page }) => {
  await page.goto("/?state=empty")
  const draft = page.getByLabel("New todo")
  await draft.fill("Ship the verified fixture")
  await draft.press("Enter")
  await expect(page.getByText("Ship the verified fixture", { exact: true })).toBeVisible()
  const complete = page.getByRole("checkbox", { name: "Complete Ship the verified fixture" })
  await complete.focus()
  await page.keyboard.press("Space")
  const reopen = page.getByRole("checkbox", { name: "Reopen Ship the verified fixture" })
  await expect(reopen).toBeChecked()
  await reopen.focus()
  await page.keyboard.press("Space")
  await expect(complete).not.toBeChecked()
  const remove = page.getByRole("button", { name: "Delete Ship the verified fixture" })
  await remove.focus()
  await page.keyboard.press("Enter")
  const confirm = page.getByRole("group", { name: "Confirm deleting Ship the verified fixture" })
  await expect(confirm).toBeVisible()
  const button = confirm.getByRole("button", { name: "Delete", exact: true })
  await button.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Ship the verified fixture", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toBeVisible()
})

test("recovers from offline list loading", async ({ page }) => {
  await page.goto("/?state=offline")
  await expect(page.getByRole("alert")).toHaveText(/Raya is offline\. Reconnect to load your todos\.Try again/)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toBeVisible()
})

test("recovers an exact stale completion intent without losing the draft", async ({ page }) => {
  await page.goto("/?state=stale")
  const draft = page.getByLabel("New todo")
  await draft.fill("Keep this draft while reviewing")
  const complete = page.getByRole("checkbox", { name: "Complete Review the launch checklist" })
  await complete.focus()
  await page.keyboard.press("Space")
  await expect(page.getByRole("alert")).toContainText(
    "This todo changed since you loaded it. Saved version 2 replaced version 1.",
  )
  await expect(draft).toHaveValue("Keep this draft while reviewing")
  const sent = async () => JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect((await sent()).filter((message) => message.type === "personalTodoUpdate")).toMatchObject([
    { todoID: "todo-open", revision: 1, done: true },
  ])
  await page.getByRole("button", { name: "Review and retry" }).click()
  await expect(page.getByRole("checkbox", { name: "Reopen Review the launch checklist" })).toBeChecked()
  await expect(draft).toHaveValue("Keep this draft while reviewing")
  expect((await sent()).filter((message) => message.type === "personalTodoUpdate")).toMatchObject([
    { todoID: "todo-open", revision: 1, done: true },
    { todoID: "todo-open", revision: 2, done: true },
  ])
  await audit(page)
})
