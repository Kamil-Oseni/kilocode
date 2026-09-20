import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test("representative routine workload stays responsive and recovers", async ({ context, page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  const devtools = await context.newCDPSession(page)
  await devtools.send("Performance.enable")
  await page.goto("/?state=light-routines&scene=performance")
  const workers = page.locator(".routines-identity[data-routine-worker]")
  await expect(workers).toHaveCount(40)
  await devtools.send("HeapProfiler.collectGarbage")
  const initial = await devtools.send("Performance.getMetrics")
  const baseline = initial.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0

  const search = page.getByLabel("Search workers")
  const samples = await search.evaluate(async (node) => {
    const field = node as HTMLInputElement
    const times: number[] = []
    for (const value of ["Worker 1", "Worker 2", "Worker 3", "Worker", ""]) {
      const start = performance.now()
      field.value = value
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      times.push(performance.now() - start)
    }
    return times
  })
  const ordered = [...samples].sort((a, b) => a - b)
  const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  expect(p95).toBeLessThan(100)
  await expect(workers).toHaveCount(40)

  const start = await page.evaluate(() => performance.now())
  await page.locator('.routines-identity[data-routine-worker="routine"]').click()
  const log = page.getByRole("log", { name: "Messages with Books" })
  await expect(log.locator("[data-routine-message]")).toHaveCount(1_000, { timeout: 15_000 })
  const rendered = await page.evaluate((value) => performance.now() - value, start)
  expect(rendered).toBeLessThan(3_000)

  const composer = page.getByLabel("Message this worker")
  const typed = await composer.evaluate(async (node) => {
    const field = node as HTMLTextAreaElement
    const start = performance.now()
    field.value = "Follow up on report 1000"
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: field.value, inputType: "insertText" }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return performance.now() - start
  })
  expect(typed).toBeLessThan(100)
  await expect(composer).toHaveValue("Follow up on report 1000")

  await page.evaluate(() =>
    window.dispatchEvent(new MessageEvent("message", { data: { type: "connectionState", state: "disconnected" } })),
  )
  const offline = page.getByText("Disconnected. Previously loaded routine information may be stale.")
  await expect(offline).toBeVisible()
  await expect(page.getByText("Offline. Your messages and draft stay here.")).toBeVisible()
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveValue("Follow up on report 1000")
  await expect(page.getByLabel("Search messages with Books")).toBeDisabled()
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  const reconnect = await page.evaluate(() => performance.now())
  await page.evaluate(() =>
    window.dispatchEvent(new MessageEvent("message", { data: { type: "connectionState", state: "connected" } })),
  )
  await expect(offline).toBeHidden()
  await expect(page.getByText("Offline. Your messages and draft stay here.")).toBeHidden()
  await expect(page.getByLabel("Search messages with Books")).toBeEnabled()
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await expect(workers).toHaveCount(40)
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  const recovered = await page.evaluate((value) => performance.now() - value, reconnect)
  expect(recovered).toBeLessThan(1_000)
  expect(
    await log.locator("[data-routine-message]").evaluateAll((nodes) => {
      const ids = nodes.map((node) => (node as HTMLElement).dataset.routineMessage)
      return new Set(ids).size
    }),
  ).toBe(1_000)

  await devtools.send("HeapProfiler.collectGarbage")
  const final = await devtools.send("Performance.getMetrics")
  const heap = final.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0
  const growth = Math.max(0, heap - baseline)
  expect(growth).toBeLessThan(64 * 1024 * 1024)
  console.log(
    JSON.stringify({
      workers: 40,
      messages: 1_000,
      inputP95Ms: p95,
      composerMs: typed,
      renderMs: rendered,
      reconnectMs: recovered,
      heapGrowthBytes: growth,
    }),
  )
})

for (const theme of ["light", "dark"]) {
  for (const width of [320, 900]) {
    test(`${theme} routines at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-routines`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      const books = page.locator('.routines-identity[data-routine-worker="routine"]')
      await expect(books).toBeVisible()
      await expect(page.getByRole("button", { name: "Website Builders 3" })).toBeVisible()
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
      const time = thread.locator('[data-routine-message] [data-component="message-time"]').first()
      await expect(time).toBeVisible()
      await expect(time).toHaveAttribute("data-side", "routine")
      await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/)
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
      await expect(page.getByLabel("finance-update.wav")).toBeVisible()
      await expect(page.getByRole("button", { name: "Open file" })).toBeVisible()
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
      await expect(panel.getByRole("heading", { name: "Reports to you" })).toBeVisible()
      await panel.getByRole("button", { name: "Set quiet hours" }).click()
      await panel.getByLabel("From").fill("23:00")
      await panel.getByLabel("Until").fill("23:00")
      await panel.getByRole("button", { name: "Save quiet hours" }).click()
      await expect(panel.getByRole("alert")).toHaveText("Choose two different quiet-hour times.")
      await panel.getByLabel("Until").fill("06:30")
      await panel.getByRole("button", { name: "Save quiet hours" }).click()
      await expect(panel.getByText(/New reports are held 23:00–06:30/)).toBeVisible()
      await panel.getByRole("button", { name: "Edit quiet hours" }).click()
      await panel.getByRole("button", { name: "No quiet hours" }).click()
      await expect(panel.getByText("This worker can send reports to this conversation at any time.")).toBeVisible()
      await expect(panel.getByRole("button", { name: "Set quiet hours" })).toBeVisible()
      const reports = panel.getByRole("button", { name: "Stop reports" })
      await expect(reports).toBeVisible()
      await reports.click()
      await expect(panel.getByRole("button", { name: "Allow reports" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Media" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Files" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Links" })).toBeVisible()
      await expect(panel.getByRole("heading", { name: "Worker communication" })).toBeVisible()
      await expect(panel.getByText("stripe.com", { exact: true })).toBeVisible()
      await expect(panel.getByText("receipt.pdf", { exact: true })).toBeVisible()
      await expect(panel.getByRole("img", { name: "travel-receipt.png" })).toBeVisible()
      await expect(panel.getByLabel("finance-update.wav")).toBeVisible()
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
      await page.getByRole("button", { name: "Info", exact: true }).click()
      const shared = panel
        .locator('.routines-info-section[aria-labelledby="routine-info-files"] li')
        .filter({ hasText: "vendor-travel-ledger-q3-close-final.pdf" })
      await shared.getByRole("button", { name: "Show in conversation" }).click()
      await expect(panel).toBeHidden()
      await expect(page.getByText("Showing where vendor-travel-ledger-q3-close-final.pdf was shared.")).toBeVisible()
      await expect(draft).toHaveValue("Keep this follow-up draft")
      await page.screenshot({ path: info.outputPath("shared-message.png"), fullPage: true })
      await page.getByRole("button", { name: "Return to latest" }).click()
      await expect(page.getByText("Showing where vendor-travel-ledger-q3-close-final.pdf was shared.")).toBeHidden()
      await page.getByRole("button", { name: "Info", exact: true }).click()
      await panel.getByRole("button", { name: "View request chain" }).click()
      await expect(panel).toBeHidden()
      const lineage = page.getByRole("region", { name: "Request chain with Counsel" })
      await expect(lineage).toBeVisible()
      await expect(lineage.getByText("Review Friday travel expenses and return a reconciled ledger.")).toBeVisible()
      await page.screenshot({ path: info.outputPath("lineage.png"), fullPage: true })
      await lineage.getByRole("button", { name: "Close" }).click()
      await expect(lineage).toBeHidden()
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
  await page.getByRole("button", { name: "Website Builders 3" }).click()
  await expect(page.getByRole("heading", { name: "Website Builders" })).toBeVisible()
  await expect(page.getByText("Find, design, build, and support better client websites.")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Operating policy" })).toBeVisible()
  await expect(
    page.getByText("Do not contact a prospect until the proposed website has passed design and legal review."),
  ).toBeVisible()
  const reports = page.getByRole("region", { name: "Reports to you" })
  await expect(
    reports.getByText("Workers in this organization can send reports to their conversations at any time."),
  ).toBeVisible()
  await reports.getByRole("button", { name: "Stop reports" }).click()
  await expect(
    reports.getByText("Allow workers in this organization to send reports to their conversations."),
  ).toBeVisible()
  await reports.getByRole("button", { name: "Allow reports" }).click()
  await expect(
    reports.getByText("Workers in this organization can send reports to their conversations at any time."),
  ).toBeVisible()
  await expect(page.getByText("Reports to Counsel")).toHaveCount(2)
  await expect(page.getByText("Can create workers", { exact: true })).toBeVisible()
  await expect(page.getByText("Cannot create workers", { exact: true })).toHaveCount(2)
  const work = page.locator(".routines-organization-work")
  await expect(work.getByRole("heading", { name: "Work" })).toBeVisible()
  await expect(work.getByLabel("Organization work totals")).toContainText("1 active · 1 need attention · 3 requests")
  await expect(work.getByLabel("Organization work totals")).toContainText("$0.42 spent")
  await expect(work.getByLabel("Organization work totals")).toContainText("$0.42 committed")
  await expect(work.getByText("Review Friday travel expenses and return a reconciled ledger.")).toBeVisible()
  await expect(work.locator('.routines-organization-work-state[data-state="completed"]')).toBeVisible()
  await expect(work.getByText("The ledger is reconciled and the receipt exception is documented.")).toBeVisible()
  await expect(work.getByText("Prepare a client-ready summary of the approved close package.")).toBeVisible()
  await expect(work.getByRole("button", { name: "Counsel" })).toHaveCount(1)
  await expect(work.getByRole("button", { name: "Books" })).toHaveCount(2)
  await expect(work.getByRole("button", { name: "Studio" })).toHaveCount(1)
  await work.getByRole("button", { name: "Assign work" }).click()
  const assignment = page.getByRole("dialog", { name: "Assign work in Website Builders" })
  await expect(assignment.getByLabel("Responsible worker")).toBeFocused()
  await expect(page.locator('[data-dialog-layer="0"]')).toHaveCSS("z-index", "50")
  await expect(assignment.getByLabel("Responsible worker")).toHaveValue("routine")
  await expect(assignment.getByLabel("Assigned by")).toHaveValue("legal")
  await expect(assignment.getByText("$99.58 remains available across organization work.")).toBeVisible()
  await assignment.getByLabel("Outcome").fill("Prepare the September close package.")
  await expect(assignment.getByRole("button", { name: "Assign work" })).toBeDisabled()
  await assignment.getByLabel("Expected result").fill("A reconciled close package.")
  await assignment.getByLabel("Context").fill("Use the approved finance workspace.")
  await assignment.getByLabel("Budget (USD)").fill("40")
  const form = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(form.violations).toEqual([])
  await page.screenshot({ path: info.outputPath("organization-assignment.png"), fullPage: true })
  await assignment.getByRole("button", { name: "Assign work" }).click()
  await expect(assignment).toBeHidden()
  await expect(work.getByText("Work assigned to Books.")).toBeVisible()
  await expect(work.getByRole("button", { name: "Open worker chat" })).toBeVisible()
  await expect(work.getByText("Prepare the September close package.")).toBeVisible()
  const root = work
    .locator(".routines-organization-work-list > li")
    .filter({ hasText: "Review Friday travel expenses" })
  await root.getByRole("button", { name: "Show chain" }).click()
  const chain = root.getByRole("list", { name: "Request chain" })
  await expect(chain.getByText("This request", { exact: false })).toBeVisible()
  await expect(chain.getByText("Follow-on request", { exact: false })).toBeVisible()
  await expect(chain.getByText("Prepare a client-ready summary of the approved close package.")).toBeVisible()
  await root.getByRole("button", { name: "Assign follow-on" }).click()
  const followup = page.getByRole("dialog", { name: "Assign follow-on in Website Builders" })
  await expect(followup.getByText("Review Friday travel expenses and return a reconciled ledger.")).toBeVisible()
  await expect(followup.getByLabel("Responsible worker")).toHaveValue("design")
  await expect(followup.getByLabel("Responsible worker").locator("option")).toHaveCount(1)
  await expect(followup.getByText("Books · Accounting", { exact: true })).toBeVisible()
  await followup.getByLabel("Outcome").fill("Prepare the client review deck.")
  const followAxe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(followAxe.violations).toEqual([])
  await page.screenshot({ path: info.outputPath("organization-follow-on.png"), fullPage: true })
  await followup.getByRole("button", { name: "Assign follow-on" }).click()
  await expect(followup).toBeHidden()
  await expect(work.getByText("Work assigned to Studio.")).toBeVisible()
  await expect(work.getByText("Prepare the client review deck.")).toBeVisible()
  await root.getByRole("button", { name: "Show chain" }).click()
  await expect(
    root.getByRole("list", { name: "Request chain" }).getByText("Prepare the client review deck."),
  ).toBeVisible()
  const follow = work
    .locator(".routines-organization-work-list > li")
    .filter({ hasText: "Prepare a client-ready summary" })
  await follow.getByRole("button", { name: "Stop work" }).click()
  await expect(follow.getByText("This stops this request and live follow-on work.")).toBeVisible()
  await follow.getByRole("button", { name: "Keep running" }).dispatchEvent("click")
  await expect(follow.getByText("This stops this request and live follow-on work.")).toBeHidden()
  await follow.getByRole("button", { name: "Stop work" }).click()
  await follow.getByRole("button", { name: "Stop work and follow-ons" }).dispatchEvent("click")
  await expect(follow.getByText("Cancelled", { exact: true })).toBeVisible()
  await expect(follow.getByRole("button", { name: "Stop work" })).toBeHidden()
  const organization = await new AxeBuilder({ page })
    .include(".routines-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(organization.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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

test("routine access review saves selected tool groups", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  const review = page.getByRole("region", { name: "Tool access for Books" })
  await expect(review).toBeVisible()
  await review.locator("select").first().selectOption("selected")
  await expect(review.getByRole("group", { name: "Allowed tools" })).toBeVisible()
  await expect(review.getByText("GitHub (2 tools)", { exact: true })).toBeVisible()
  await expect(review.getByText("Saved tool: mcp_accounting", { exact: true })).toBeVisible()
  await review.getByText("Saved tool: mcp_accounting", { exact: true }).click()
  await review.getByText("GitHub (2 tools)", { exact: true }).click()
  await review.getByText("Change files", { exact: true }).click()
  await review.getByText("Browser and web", { exact: true }).click()
  await review.getByRole("button", { name: "Save access" }).click()
  await expect(review.getByRole("status")).toHaveText("Access saved. The routine list is refreshing.")
  const result = await new AxeBuilder({ page })
    .include(".routines-instructions")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("routine-access-tools.png"), fullPage: true })
  await review.getByRole("button", { name: "Close" }).click()
  await page.locator('.routines-identity[data-routine-worker="routine"]').click()
  await page.getByRole("button", { name: "Info", exact: true }).click()
  await expect(page.getByText("Selected tools", { exact: true })).toBeVisible()
})

test("uncertain routine follow-up is reviewed without resending", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines&scene=followup-recovery")
  await expect(
    page.getByText("A follow-up may have reached this worker. Review it before more work starts.", { exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Books options" }).click()
  await expect(page.getByRole("menuitem", { name: "Review follow-up" })).toBeVisible()
  await page.getByRole("menuitem", { name: "Review runs" }).click()
  const review = page.getByRole("region", { name: "Run review for Books" })
  await expect(review.getByRole("heading", { name: "Follow-up delivery" })).toBeVisible()
  await expect(page.locator(".routines-inbox")).toBeHidden()
  await expect(review).toContainText("Raya couldn't prove whether this follow-up reached the worker.")
  await review.getByRole("button", { name: "Resolve follow-up" }).click()
  await expect(review.getByRole("button", { name: "Close without resending" })).toBeVisible()
  await expect(review).toContainText("This won't resend the follow-up or accept an unverified result.")
  const result = await new AxeBuilder({ page })
    .include(".routines-instructions")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("routine-followup-recovery.png"), fullPage: true })
  await review.getByRole("button", { name: "Close without resending" }).click()
  await expect(review.getByRole("status")).toContainText("This follow-up review is closed")
  await expect(review.getByRole("status")).toContainText("The message was not resent")
})

test("narrow routine access review keeps every tool group in view", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  const review = page.getByRole("region", { name: "Tool access for Books" })
  await review.locator("select").first().selectOption("selected")
  await expect(review.getByText("Read workspace", { exact: true })).toBeVisible()
  await expect(review.getByText("Connected services", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const result = await new AxeBuilder({ page })
    .include(".routines-instructions")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
})

test("routine folder review fails closed on stale access and recovers after reload", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines&scene=access-stale")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  let review = page.getByRole("region", { name: "Tool access for Books" })
  await expect(review.getByText("Primary write folder: Reports", { exact: true })).toBeVisible()
  await review.locator("select").first().selectOption("selected")
  await review.getByRole("button", { name: "Add folder" }).click()
  await expect(review.getByLabel("Access for C:/Workspace/Records")).toBeVisible()
  await review.getByLabel("Access for C:/Workspace/Records").selectOption("write")
  await expect(review.getByRole("checkbox", { name: "Commands" })).toHaveCount(0)
  await expect(
    review.getByText("Commands and workspace-wide code navigation are unavailable", { exact: false }),
  ).toBeVisible()
  await review.getByRole("button", { name: "Save access" }).click()
  await expect(review.getByRole("alert")).toHaveText(
    "This routine's folder access changed. Reload it before reviewing access again. Your access choices are unchanged.",
  )
  await expect(review.getByRole("status")).toHaveCount(0)

  await review.getByRole("button", { name: "Close" }).click()
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  review = page.getByRole("region", { name: "Tool access for Books" })
  await expect(review.getByLabel("Access for C:/Workspace/Shared")).toHaveValue("read")
  await review.locator("select").first().selectOption("selected")
  await review.getByLabel("Access for C:/Workspace/Shared").selectOption("write")
  await review.getByRole("button", { name: "Save access" }).click()
  await expect(review.getByRole("status")).toHaveText("Access saved. The routine list is refreshing.")
  const result = await new AxeBuilder({ page })
    .include(".routines-instructions")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
  await page.screenshot({ path: info.outputPath("routine-folder-access.png"), fullPage: true })
})

test("routine service access recovers from error, empty, stale and timeout catalog states", async ({ page }, info) => {
  info.setTimeout(60_000)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines&scene=services-error")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  let review = page.getByRole("region", { name: "Tool access for Books" })
  await review.getByLabel("Access").selectOption("selected")
  await expect(review.getByRole("alert")).toHaveText("The connected service list is unavailable. Try again.")
  await review.getByRole("button", { name: "Retry connected services" }).click()
  await expect(review.getByText("GitHub (2 tools)", { exact: true })).toBeVisible()
  await expect(review.getByRole("alert")).toBeHidden()

  await page.goto("/?state=light-routines&scene=services-empty")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  review = page.getByRole("region", { name: "Tool access for Books" })
  await review.getByLabel("Access").selectOption("selected")
  await expect(review.getByText("No connected services are available.", { exact: true })).toBeVisible()
  await expect(review.getByRole("button", { name: "Retry connected services" })).toBeHidden()

  await page.goto("/?state=light-routines&scene=services-stale")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  review = page.getByRole("region", { name: "Tool access for Books" })
  await review.getByLabel("Access").selectOption("selected")
  await expect(review.getByText("Checking connected services.", { exact: true })).toBeVisible()
  await expect(review.getByText("Wrong response", { exact: false })).toBeHidden()
  await expect(review.getByText("GitHub (2 tools)", { exact: true })).toBeVisible()
  await expect(review.getByText("Some connected tools aren't shown.", { exact: false })).toBeVisible()

  await page.goto("/?state=light-routines&scene=services-timeout")
  await page.getByRole("button", { name: "Books options" }).click()
  await page.getByRole("menuitem", { name: "Review access" }).click()
  review = page.getByRole("region", { name: "Tool access for Books" })
  await review.getByLabel("Access").selectOption("selected")
  await expect(review.getByText("Checking connected services.", { exact: true })).toBeVisible()
  await expect(review.getByRole("alert")).toHaveText("Connected services could not be confirmed. Try again.", {
    timeout: 20_000,
  })
  await review.getByRole("button", { name: "Retry connected services" }).click()
  await expect(review.getByText("GitHub (2 tools)", { exact: true })).toBeVisible()
  await expect(review.getByRole("alert")).toBeHidden()
  const result = await new AxeBuilder({ page })
    .include(".routines-instructions")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
})

test("organization assignment requires an authorized route", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Finance 1" }).click()
  const work = page.locator(".routines-organization-work")
  await work.getByRole("button", { name: "Assign work" }).click()
  const assignment = page.getByRole("dialog", { name: "Assign work in Finance" })
  await expect(assignment).toContainText("No active worker has an authorized route.")
  await expect(assignment.getByRole("button", { name: "Close", exact: true }).last()).toBeFocused()
  await assignment.getByRole("button", { name: "Edit organization" }).click()
  await expect(assignment).toBeHidden()
  await expect(page.getByRole("heading", { name: "Edit organization" })).toBeVisible()
})

test("organization work filters loaded and earlier activity", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Website Builders 3" }).click()
  const work = page.locator(".routines-organization-work")
  const search = work.getByLabel("Search work")
  await search.fill("hosting provider")
  await expect(work.getByText("Showing 0 of 2 loaded")).toBeVisible()
  await expect(work.getByText("No work matches these filters.")).toBeVisible()
  await work.getByRole("button", { name: "Load earlier work" }).click()
  await expect(work.getByText("Showing 1 of 3 loaded")).toBeVisible()
  await expect(work.getByText("The hosting provider was unavailable.", { exact: false })).toBeVisible()
  await work.getByLabel("State").selectOption("failed")
  await work.getByLabel("Worker").selectOption("design")
  await expect(work.getByText("Recover the interrupted hosting handoff.")).toBeVisible()
  await work.getByRole("button", { name: "Clear filters" }).click()
  await expect(search).toHaveValue("")
  await expect(work.getByLabel("State")).toHaveValue("all")
  await expect(work.getByLabel("Worker")).toHaveValue("all")
  await expect(work.getByText("Showing 3 of 3 loaded")).toBeVisible()
  await page.screenshot({ path: info.outputPath("organization-work-filters.png"), fullPage: true })
  const result = await new AxeBuilder({ page })
    .include(".routines-organization-work")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(result.violations).toEqual([])
})

test("routines organization editor separates reporting, delegation, and archive", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto("/?state=light-routines")
  await page.getByRole("button", { name: "Website Builders 3" }).click()
  await page.getByRole("button", { name: "Edit organization" }).click()
  await expect(page.getByRole("heading", { name: "Team and reporting" })).toBeVisible()
  await expect(page.getByLabel("Operating policy")).toHaveValue(
    "Do not contact a prospect until the proposed website has passed design and legal review.",
  )
  await expect(page.getByLabel("Operating policy")).toHaveAccessibleDescription(
    "Applied to delegated work in this organization. It cannot grant tools, folders, spending access, or delegation authority.",
  )
  await expect(page.getByLabel("Organization model budget ($)")).toHaveValue("100")
  await expect(page.getByLabel("Organization model budget ($)")).toHaveAccessibleDescription(
    "Caps committed model cost across all work in this organization. Leave blank for no limit.",
  )
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
  await page
    .getByLabel("Operating policy")
    .fill("Only contact prospects after design review, legal review, and an approved outreach brief.")
  await page.getByLabel("Organization model budget ($)").fill("250")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Edit organization" })).toBeHidden()
  await expect(
    page.getByText("Only contact prospects after design review, legal review, and an approved outreach brief."),
  ).toBeVisible()
  await expect(page.getByText(/available of \$250\.00/)).toBeVisible()

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
  await page.getByRole("button", { name: "Website Builders 3" }).click()
  await expect(page.getByRole("heading", { name: "Website Builders" })).toBeVisible()
  await expect(page.locator(".routines-people")).toBeHidden()
  const work = page.locator(".routines-organization-work")
  await work.getByRole("button", { name: "Assign work" }).click()
  const assignment = page.getByRole("dialog", { name: "Assign work in Website Builders" })
  await expect(assignment).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await assignment.getByRole("button", { name: "Cancel" }).click()
  await expect(assignment).toBeHidden()
  await expect(work.getByRole("button", { name: "Assign work" })).toBeFocused()
  const root = work
    .locator(".routines-organization-work-list > li")
    .filter({ hasText: "Review Friday travel expenses" })
  await root.getByRole("button", { name: "Show chain" }).click()
  await expect(root.getByRole("list", { name: "Request chain" })).toBeVisible()
  await root.getByRole("button", { name: "Assign follow-on" }).click()
  const followup = page.getByRole("dialog", { name: "Assign follow-on in Website Builders" })
  await expect(followup.getByLabel("Responsible worker")).toBeFocused()
  await expect(followup.getByLabel("Responsible worker")).toHaveValue("design")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await followup.getByRole("button", { name: "Cancel" }).click()
  await expect(followup).toBeHidden()
  await expect(root.getByRole("button", { name: "Assign follow-on" })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole("button", { name: "Back to organizations from Website Builders" }).click()
  await expect(page.getByRole("button", { name: "Website Builders 3" })).toBeFocused()
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
  await page.getByRole("button", { name: "Website Builders 3" }).click()
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
  await page.goto("http://127.0.0.1:5199/?state=light-routines&target=organization")
  const work = page.locator(".routines-organization-work")
  await expect(work.getByLabel("Search work")).toBeVisible()
  await expect(work.getByLabel("State")).toBeVisible()
  await expect(work.getByLabel("Worker")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await context.close()
})
