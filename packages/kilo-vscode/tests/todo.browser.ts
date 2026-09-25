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
      await expect(
        page.getByText("Confirm owners, rollout order, and rollback signals.", { exact: true }),
      ).toBeVisible()
      await expect(page.getByText(/^Due /)).toBeVisible()
      await expect(page.locator('[data-slot="personal-todo-reminder"]')).toBeVisible()
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
      await audit(page)
      await page.getByRole("button", { name: "Edit Review the launch checklist" }).click()
      await expect(page.getByRole("form", { name: "Edit Review the launch checklist" })).toBeVisible()
      await audit(page)
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.screenshot({ path: info.outputPath("todo.png"), fullPage: true })
      expect(errors).toEqual([])
    })
  }

for (const theme of ["light", "dark", "contrast"])
  for (const width of [320, 760]) {
    test(`${theme} Todo proposal review at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 760 })
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.goto(`/?theme=${theme}&proposal=open`)
      await expect(page.getByRole("heading", { name: "For review" })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Plan the move" })).toBeVisible()
      await expect(page.getByText("Compare neighborhoods and prepare the application.", { exact: true })).toBeVisible()
      await expect(page.getByText("Book viewings", { exact: true })).toBeVisible()
      await expect(page.getByText("ses_fixture", { exact: true })).toBeVisible()
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
      await audit(page)
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.screenshot({ path: info.outputPath("todo-proposal.png"), fullPage: true })
    })
  }

test("Todo planning sends the user's goal through Raya and filters priorities", async ({ page }) => {
  await page.goto("/")
  await page.locator('[data-slot="todo-overview-grid"] button').filter({ hasText: "Completed" }).click()
  await expect(page.locator('[data-slot="personal-todo-item"]')).toHaveCount(1)
  await expect(page.getByText("Confirm the release owner", { exact: true })).toBeVisible()
  await page.locator('[data-slot="todo-overview-grid"] button').filter({ hasText: "All tasks" }).click()
  await page.getByRole("textbox", { name: "Ask Raya to plan a todo" }).fill("I want to learn violin")
  await page.getByRole("button", { name: "Continue in chat", exact: true }).click()
  await expect(page.locator("body")).toHaveAttribute("data-asked-raya", /I want to learn violin/)
  await expect(page.locator("body")).toHaveAttribute("data-asked-raya", /reviewable proposal before saving/)
})

test("subtasks save independently and stale steps refresh without replay", async ({ page }) => {
  await page.goto("/?state=subtasks")
  const step = page.getByRole("checkbox", { name: "Check the release notes" })
  await expect(step).not.toBeChecked()
  await page.getByText("Check the release notes", { exact: true }).click()
  await expect(step).toBeChecked()
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message) => message.type === "personalTodoSubtask")).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole("checkbox", { name: "Check the release notes" })).toBeChecked()

  await page.evaluate(() => localStorage.removeItem("raya-todo-fixture-items"))
  await page.goto("/?state=subtask-stale")
  await page.getByText("Check the release notes", { exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Check the release notes" })).toBeChecked()
  await expect(page.getByRole("alert")).toContainText("This step changed elsewhere.")
  const before = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(before.filter((message) => message.type === "personalTodoSubtask")).toHaveLength(1)
})

test("applies and rejects exact Todo proposals from the keyboard", async ({ page }) => {
  await page.goto("/?proposal=open")
  const apply = page.getByRole("button", { name: "Apply" })
  await apply.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Proposal applied", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0)

  await page.goto("/?proposal=open")
  const reject = page.getByRole("button", { name: "Reject" })
  await reject.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Proposal rejected", { exact: true })).toBeVisible()
  await audit(page)
})

test("resumes only after an uncertain decision is reconciled as pending", async ({ page }) => {
  await page.goto("/?proposal=uncertain")
  await page.getByRole("button", { name: "Apply" }).click()
  await expect(page.getByText("Application pending", { exact: true })).toBeVisible()
  await expect(page.getByText("Result is uncertain.")).toBeVisible()
  const retry = page.getByRole("button", { name: "Try again" })
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect(page.getByText("Proposal applied", { exact: true })).toBeVisible()
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message) => message.type === "personalTodoProposalApply")).toHaveLength(2)
})

test("offers exact continuation for a durable pending proposal", async ({ page }) => {
  await page.goto("/?proposal=pending")
  const resume = page.getByRole("button", { name: "Continue applying" })
  await expect(resume).toBeEnabled()
  await resume.click()
  await expect(page.getByText("Proposal applied", { exact: true })).toBeVisible()
})

test("keeps Edit available when a proposal is stale", async ({ page }) => {
  await page.goto("/?proposal=stale")
  await page.getByRole("button", { name: "Apply" }).click()
  await expect(page.getByText("Proposal is out of date.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled()
  const edit = page.getByRole("button", { name: "Edit", exact: true })
  await expect(edit).toBeEnabled()
  await edit.click()
  await expect(page.locator("body")).toHaveAttribute(
    "data-edited-proposal",
    "proposal_11111111-1111-4111-8111-111111111111",
  )
})

test("shows the authoritative terminal decision after a conflict", async ({ page }) => {
  await page.goto("/?proposal=conflict")
  await page.getByRole("button", { name: "Apply" }).click()
  await expect(page.getByText("Proposal rejected", { exact: true })).toBeVisible()
  await expect(page.getByText("Proposal conflict.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0)
})

test("keeps proposal actions disabled while a request is in flight", async ({ page }) => {
  await page.goto("/?proposal=hold")
  await page.getByRole("button", { name: "Apply" }).click()
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled()
  await expect(page.getByText("Applying proposal.")).toBeVisible()
})

test("recovers proposal list loading after an offline response", async ({ page }) => {
  await page.goto("/?proposal=offline")
  await expect(page.getByRole("alert")).toContainText("Your saved plans are unchanged.")
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByText("No plans are waiting for review.", { exact: true })).toBeVisible()
  await audit(page)
})

test("keeps a matching focused proposal reachable", async ({ page }) => {
  await page.goto("/?proposal=open&focus=true")
  await expect(page.getByRole("heading", { name: "Plan the move" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply" })).toBeFocused()
})

test("shows loading and empty states", async ({ page }) => {
  await page.goto("/?state=loading")
  await expect(page.locator('[data-slot="personal-todo-loading"]')).toContainText("Loading your todos")
  await page.goto("/?state=empty")
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toBeVisible()
  await expect(page.getByText("Add one clear next step above.", { exact: true })).toBeVisible()
  await audit(page)
})

test("displays a saved reminder at the Unix epoch", async ({ page }) => {
  await page.goto("/?state=epoch")
  const reminder = page.locator('[data-slot="personal-todo-reminder"]')
  await expect(reminder).toBeVisible()
  await expect(reminder).toHaveAttribute("datetime", new Date(0).toISOString())
})

test("adds, completes, reopens and confirms deletion from the keyboard", async ({ page }) => {
  await page.goto("/?state=empty")
  const draft = page.getByLabel("New todo")
  await draft.fill("Ship the verified fixture")
  await page.getByLabel("Reminder date and time").fill("2031-01-02T08:30")
  await page.getByRole("button", { name: "Add" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Ship the verified fixture", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="personal-todo-reminder"]')).toBeVisible()
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message) => message.type === "personalTodoCreate")).toMatchObject([
    { title: "Ship the verified fixture", reminderAt: new Date("2031-01-02T08:30").getTime() },
  ])
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

test("edits title, details, due date, and reminder from the keyboard and reloads the saved result", async ({
  page,
}) => {
  await page.goto("/")
  const edit = page.getByRole("button", { name: "Edit Review the launch checklist" })
  await edit.focus()
  await page.keyboard.press("Enter")
  const form = page.getByRole("form", { name: "Edit Review the launch checklist" })
  await form.getByLabel("Title").fill("Review the release plan")
  await form.getByLabel("Details").fill("Check ownership, rollout, and rollback.")
  await form.getByLabel("Due date and time").fill("2031-06-07T09:45")
  await form.getByLabel("Reminder date and time").fill("2031-06-07T08:45")
  await form.getByRole("button", { name: "Save" }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("list", { name: "Personal todos" }).getByText("Review the release plan", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Check ownership, rollout, and rollback.", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="personal-todo-reminder"]')).toBeVisible()
  const sent = async () => JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect((await sent()).filter((message) => message.type === "personalTodoUpdate")).toMatchObject([
    {
      todoID: "todo-open",
      revision: 1,
      title: "Review the release plan",
      detail: "Check ownership, rollout, and rollback.",
      dueAt: new Date("2031-06-07T09:45").getTime(),
      reminderAt: new Date("2031-06-07T08:45").getTime(),
    },
  ])
  await page.reload()
  await expect(
    page.getByRole("list", { name: "Personal todos" }).getByText("Review the release plan", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Check ownership, rollout, and rollback.", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="personal-todo-reminder"]')).toBeVisible()
  await audit(page)
})

test("cancels an edit with Escape without sending or losing the saved item", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Edit Review the launch checklist" }).click()
  const form = page.getByRole("form", { name: "Edit Review the launch checklist" })
  await form.getByLabel("Title").fill("Unsaved title")
  await form.getByLabel("Details").fill("Unsaved details")
  await form.getByLabel("Details").press("Escape")
  await expect(form).toHaveCount(0)
  await expect(
    page.getByRole("list", { name: "Personal todos" }).getByText("Review the launch checklist", { exact: true }),
  ).toBeVisible()
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message) => message.type === "personalTodoUpdate")).toEqual([])
})

for (const state of ["edit-offline", "edit-error"] as const) {
  test(`retains the complete ${state} edit until an explicit retry`, async ({ page }) => {
    await page.goto(`/?state=${state}`)
    await page.getByRole("button", { name: "Edit Review the launch checklist" }).click()
    const form = page.getByRole("form", { name: "Edit Review the launch checklist" })
    await form.getByLabel("Title").fill("Retained edit")
    await form.getByLabel("Details").fill("This exact detail stays visible.")
    await form.getByLabel("Due date and time").fill("2032-08-09T11:15")
    await form.getByLabel("Reminder date and time").fill("2032-08-09T10:15")
    await form.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("alert")).toContainText(state === "edit-offline" ? "still here" : "could not save")
    await expect(form.getByLabel("Title")).toHaveValue("Retained edit")
    await expect(form.getByLabel("Details")).toHaveValue("This exact detail stays visible.")
    await expect(form.getByLabel("Due date and time")).toHaveValue("2032-08-09T11:15")
    await expect(form.getByLabel("Reminder date and time")).toHaveValue("2032-08-09T10:15")
    await page.getByRole("button", { name: "Try again" }).click()
    await expect(
      page.getByRole("list", { name: "Personal todos" }).getByText("Retained edit", { exact: true }),
    ).toBeVisible()
    await expect(page.getByText("This exact detail stays visible.", { exact: true })).toBeVisible()
    await audit(page)
  })
}

test("keeps an exact stale edit visible and retries against the adopted revision after review", async ({ page }) => {
  await page.goto("/?state=stale")
  await page.getByRole("button", { name: "Edit Review the launch checklist" }).click()
  const form = page.getByRole("form", { name: "Edit Review the launch checklist" })
  await form.getByLabel("Title").fill("Reviewed stale edit")
  await form.getByLabel("Details").fill("Preserve this context through reconciliation.")
  await form.getByLabel("Due date and time").fill("2033-10-11T13:20")
  await form.getByLabel("Reminder date and time").fill("2033-10-11T12:20")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("alert")).toContainText("Saved version 2 replaced version 1.")
  await expect(form.getByLabel("Title")).toHaveValue("Reviewed stale edit")
  await expect(form.getByLabel("Details")).toHaveValue("Preserve this context through reconciliation.")
  await expect(form.getByLabel("Reminder date and time")).toHaveValue("2033-10-11T12:20")
  const sent = async () => JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect((await sent()).filter((message) => message.type === "personalTodoUpdate")).toMatchObject([
    {
      todoID: "todo-open",
      revision: 1,
      title: "Reviewed stale edit",
      reminderAt: new Date("2033-10-11T12:20").getTime(),
    },
  ])
  await page.getByRole("button", { name: "Review and retry" }).click()
  await expect(
    page.getByRole("list", { name: "Personal todos" }).getByText("Reviewed stale edit", { exact: true }),
  ).toBeVisible()
  expect((await sent()).filter((message) => message.type === "personalTodoUpdate")).toMatchObject([
    { todoID: "todo-open", revision: 1, title: "Reviewed stale edit" },
    {
      todoID: "todo-open",
      revision: 2,
      title: "Reviewed stale edit",
      reminderAt: new Date("2033-10-11T12:20").getTime(),
    },
  ])
  await page.reload()
  await expect(
    page.getByRole("list", { name: "Personal todos" }).getByText("Reviewed stale edit", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Preserve this context through reconciliation.", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="personal-todo-reminder"]')).toBeVisible()
  await audit(page)
})

test("clears optional detail, due date, and reminder explicitly", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Edit Review the launch checklist" }).click()
  const form = page.getByRole("form", { name: "Edit Review the launch checklist" })
  await form.getByLabel("Details").fill("")
  await form.getByLabel("Due date and time").fill("")
  await form.getByLabel("Reminder date and time").fill("")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Confirm owners, rollout order, and rollback signals.", { exact: true })).toHaveCount(0)
  await expect(page.getByText(/^Due /)).toHaveCount(0)
  await expect(page.locator('[data-slot="personal-todo-reminder"]')).toHaveCount(0)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message) => message.type === "personalTodoUpdate")).toMatchObject([
    { detail: null, dueAt: null, reminderAt: null },
  ])
})

for (const state of ["idle", "running", "paused", "completed"] as const) {
  test(`renders the authoritative ${state} focus timer state`, async ({ page }) => {
    await page.goto(`/?timer=${state}`)
    await expect(page.getByRole("heading", { name: "Focus timer" })).toBeVisible()
    const labels = {
      idle: "Ready when you are",
      running: "Focusing",
      paused: "Paused",
      completed: "Focus complete",
    }
    await expect(page.getByText(labels[state], { exact: true })).toBeVisible()
    await expect(page.getByLabel("Focus time remaining")).toHaveText(state === "completed" ? "00:00" : /\d\d:\d\d/)
    await audit(page)
  })
}

test("recovers the timer after an offline authoritative read", async ({ page }) => {
  await page.goto("/?timer=offline")
  await expect(page.getByRole("alert")).toContainText("Raya is offline. The saved focus timer is unchanged.")
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByText("Focusing", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled()
})

test("reconciles a stale timer action and reloads the persisted backend state", async ({ page }) => {
  await page.goto("/?timer=stale")
  const pause = page.getByRole("button", { name: "Pause" })
  await pause.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alert")).toContainText(
    "The focus timer changed before this action. Saved version 3 replaced version 2.",
  )
  const sent = async () => JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect((await sent()).filter((message) => message.type === "focusTimerPause")).toMatchObject([{ revision: 2 }])
  await page.getByRole("button", { name: "Review and retry" }).click()
  await expect(page.getByText("Paused", { exact: true })).toBeVisible()
  expect((await sent()).filter((message) => message.type === "focusTimerPause")).toMatchObject([
    { revision: 2 },
    { revision: 3 },
  ])
  await page.reload()
  await expect(page.getByText("Paused", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Focus time remaining")).toHaveText(/\d\d:\d\d/)
  await audit(page)
})

test("starts, pauses, resumes and resets the timer from the keyboard", async ({ page }) => {
  await page.goto("/?timer=idle")
  const start = page.getByRole("button", { name: "Start focus" })
  await start.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Focusing", { exact: true })).toBeVisible()
  const pause = page.getByRole("button", { name: "Pause" })
  await pause.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Paused", { exact: true })).toBeVisible()
  const resume = page.getByRole("button", { name: "Resume" })
  await resume.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Focusing", { exact: true })).toBeVisible()
  const reset = page.getByRole("button", { name: "Reset" })
  await reset.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Ready when you are", { exact: true })).toBeVisible()
})

test("keeps a pending timer action disabled", async ({ page }) => {
  await page.goto("/?timer=idle&holdTimer=true")
  const start = page.getByRole("button", { name: "Start focus" })
  await start.click()
  await expect(start).toBeDisabled()
  await expect(page.getByText("Ready when you are", { exact: true })).toBeVisible()
})
