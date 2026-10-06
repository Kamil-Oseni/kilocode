import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test("lost health reads expire and late replies cannot replace a fresh retry", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.clock.install()
  await page.goto("/?state=health-held")
  const refresh = page.getByRole("button", { name: "Refresh", exact: true })
  await expect(refresh).toBeDisabled()
  await page.clock.fastForward(15_001)
  await expect(page.locator(".admin-notice[role=alert]")).toContainText("System health did not reply")
  await expect(refresh).toBeEnabled()
  await audit(page)
  await page.evaluate(() => (window as unknown as { __healthReplies: (() => void)[] }).__healthReplies[0]())
  await expect(page.locator(".admin-notice[role=alert]")).toContainText("System health did not reply")
  await refresh.click()
  await expect(refresh).toBeDisabled()
  await page.evaluate(() => (window as unknown as { __healthReplies: (() => void)[] }).__healthReplies[0]())
  await expect(refresh).toBeDisabled()
  await page.evaluate(() => (window as unknown as { __healthReplies: (() => void)[] }).__healthReplies[1]())
  await expect(refresh).toBeEnabled()
  await expect(page.locator(".admin-notice[role=alert]")).toHaveCount(0)
  await page.clock.fastForward(20_000)
  await expect(page.locator(".admin-notice[role=alert]")).toHaveCount(0)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message: { type: string }) => message.type === "requestAdmin")).toHaveLength(2)
})

test("disconnect invalidates outstanding health reads before reconnect", async ({ page }) => {
  await page.clock.install()
  await page.goto("/?state=health-held")
  const refresh = page.getByRole("button", { name: "Refresh", exact: true })
  await expect(refresh).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as { __healthConnection: (connected: boolean) => void }).__healthConnection(false),
  )
  await expect(page.locator(".admin-notice[role=status]")).toContainText("Raya is disconnected")
  await page.evaluate(() => (window as unknown as { __healthReplies: (() => void)[] }).__healthReplies[0]())
  await expect(page.locator(".admin-notice[role=status]")).toContainText("Raya is disconnected")
  await page.clock.fastForward(20_000)
  await expect(page.locator(".admin-notice[role=alert]")).toHaveCount(0)
  await page.evaluate(() =>
    (window as unknown as { __healthConnection: (connected: boolean) => void }).__healthConnection(true),
  )
  await expect(refresh).toBeDisabled()
  await page.evaluate(() => (window as unknown as { __healthReplies: (() => void)[] }).__healthReplies[0]())
  await expect(refresh).toBeDisabled()
  await page.evaluate(() => (window as unknown as { __healthReplies: (() => void)[] }).__healthReplies[1]())
  await expect(refresh).toBeEnabled()
  await expect(page.getByText("Raya is disconnected", { exact: false })).toHaveCount(0)
})

test("Voice attention explains observed retained state without asserting a server outage", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto("/?state=voice-failed")
  await expect(
    page.getByText("Recorded voice state: 0 active · 1 failed · 0 incomplete", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText(
      "A voice failure or incomplete result is retained. Successful voice work is needed to confirm recovery.",
      {
        exact: true,
      },
    ),
  ).toBeVisible()
  await expect(page.getByText("Voice needs attention", { exact: true })).toBeVisible()
  await audit(page)
  await page.goto("/?state=voice-incomplete")
  await expect(
    page.getByText("Recorded voice state: 0 active · 0 failed · 1 incomplete", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Voice result incomplete", { exact: true })).toBeVisible()
  await page.goto("/?state=voice-invalid")
  await expect(page.getByText("Recorded voice state:", { exact: false })).toHaveCount(0)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(
    sent.some((message: { type: string }) => message.type.startsWith("speech") || message.type.startsWith("voice")),
  ).toBe(false)
})

test("rollback availability shows checked metadata without installing or asserting a tested restore", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto("/?state=rollback-available")
  await expect(page.getByText("Earlier version: 1.2.2 · win32-x64", { exact: true })).toBeVisible()
  await page.getByText("Verified package checksums", { exact: true }).click()
  await expect(page.getByText(`Package SHA-256: ${"a".repeat(64)}`, { exact: true })).toBeVisible()
  await expect(page.getByText("This verifies retained files.", { exact: false })).toBeVisible()
  await audit(page)
  for (const state of ["rollback-invalid", "rollback-progress"]) {
    await page.goto(`/?state=${state}`)
    await expect(page.getByText("Earlier version:", { exact: false })).toHaveCount(0)
    await expect(page.getByText("Verified package checksums", { exact: true })).toHaveCount(0)
  }
})

test("a lost Stop receipt refreshes observed worker state without replaying cancellation", async ({ page }) => {
  await page.clock.install()
  await page.goto("/?state=workers-delayed")
  const workers = page.getByRole("region", { name: "Current conversation workers" })
  await workers.locator('[data-slot="task-header-todos-trigger"]').click()
  await workers.getByRole("button", { name: "Stop: Code", exact: true }).click()
  await page.clock.fastForward(20_000)
  await expect(workers.getByText("Cancelled", { exact: true })).toBeVisible()
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message: { type: string }) => message.type === "cancelBackgroundJob")).toHaveLength(1)
  expect(sent.filter((message: { type: string }) => message.type === "requestBackgroundJobs").length).toBeGreaterThan(1)
  await page.evaluate(() => (window as unknown as { __confirmStop: () => void }).__confirmStop())
  await expect(workers.getByText("Cancelled", { exact: true })).toBeVisible()
})

test("Activity and health exposes the actual worker strip and scoped Stop command", async ({ page }) => {
  await page.goto("/?state=workers-delayed")
  const workers = page.getByRole("region", { name: "Current conversation workers" })
  await workers.locator('[data-slot="task-header-todos-trigger"]').click()
  await expect(workers.getByText("Write daily summary", { exact: true })).toBeVisible()
  await workers.getByRole("button", { name: "Stop: Code", exact: true }).click()
  await expect(workers.getByRole("button", { name: "Stop: Code", exact: true })).toBeDisabled()
  await expect(workers.getByText("Stopping…", { exact: true })).toBeVisible()
  await expect(workers.getByText("Cancelled", { exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __confirmStop: () => void }).__confirmStop())
  await expect(workers.getByText("Cancelled", { exact: true })).toBeVisible()
  await expect(workers.getByRole("button", { name: "Stop: Code", exact: true })).toHaveCount(0)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message: { type: string }) => message.type === "cancelBackgroundJob")).toEqual([
    expect.objectContaining({ jobID: "synthetic-worker", sessionID: "story-session-001" }),
  ])
  await audit(page)
})

test("shared resource observations render without claiming worker or GPU attribution", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto("/?state=resources")
  await expect(page.getByText("Backend memory: 1.00 GiB · Process 42", { exact: true })).toBeVisible()
  await expect(page.getByText("PC RAM available: 12.00 GiB of 32.00 GiB", { exact: true })).toBeVisible()
  await expect(page.getByText("Local inference: 1 active · 2 waiting", { exact: true })).toBeVisible()
  await expect(page.getByText("GPU memory is not reported here.", { exact: false })).toBeVisible()
  await audit(page)
  await page.goto("/?state=resources-invalid")
  await expect(page.getByText("Resource readings are not available", { exact: false })).toBeVisible()
  await expect(page.getByText("Backend memory:", { exact: false })).toHaveCount(0)
})

const audit = async (page: import("@playwright/test").Page) => {
  const result = await new AxeBuilder({ page })
    .include(".admin-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()
  expect(result.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test("proposal transport reviews an exact revision, preserves source hashes and clears on project change", async ({
  page,
}) => {
  await page.goto("/?state=proposals")
  await page.getByRole("button", { name: "Refresh proposals" }).click()
  await page.getByRole("button", { name: "Review Preferences/lights.md", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Proposed memory changes" })).toBeVisible()
  await page.getByRole("button", { name: "Edit proposed changes" }).click()
  await page.getByLabel("Proposed text: Preferences/lights.md", { exact: true }).fill("Prefer calm amber")
  await page.getByRole("button", { name: "Save proposal revision" }).click()
  await expect(page.getByText("Prefer calm amber", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Open full review and apply" }).click()
  await expect(page.getByText("applied · Automatic capture is off", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open full review and apply" })).toBeDisabled()
  const requests = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]").filter(
    (message: { type: string; action: string }) => message.type === "secondBrain" && message.action === "proposal",
  )
  expect(requests.at(-1).command).toEqual({
    action: "apply",
    project: "C:\\work\\raya-feature",
    id: "a".repeat(32),
    digest: "d".repeat(64),
  })
  expect(requests.some((message: { command: Record<string, unknown> }) => "approved" in message.command)).toBe(false)
  await page.getByRole("button", { name: "Switch fixture workspace" }).click()
  await expect(page.getByRole("heading", { name: "Proposed memory changes" })).toHaveCount(0)
})

test("dismissed native review settles the UI without claiming an applied note", async ({ page }) => {
  await page.goto("/?state=proposals-dismiss")
  await page.getByRole("button", { name: "Refresh proposals" }).click()
  await page.getByRole("button", { name: "Review Preferences/lights.md", exact: true }).click()
  await page.getByRole("button", { name: "Open full review and apply" }).click()
  await expect(page.getByText("pending · Automatic capture is off", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh proposals" })).toBeEnabled()
})

test("published memories use separate source review and index sync without replaying publication", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=proposals-index")
  await page.getByRole("button", { name: "Refresh proposals" }).click()
  await page.getByRole("button", { name: "Review Preferences/lights.md", exact: true }).click()
  await expect(page.getByRole("button", { name: "Confirm index sync" })).toHaveCount(0)
  await page.getByRole("button", { name: "Open full review and apply" }).click()
  await expect(page.getByText("applied · Automatic capture is off", { exact: true })).toBeVisible()
  const review = page.getByRole("button", { name: "Review sources for indexing", exact: true })
  const sync = page.getByRole("button", { name: "Confirm index sync", exact: true })
  await review.click()
  await expect(review).toBeDisabled()
  await expect(sync).toBeDisabled()
  await expect(page.getByText("Reviewing sources in native review…", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh proposals" })).toBeDisabled()
  await page.evaluate(() => window.__finishIndex())
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect(sync).toBeDisabled()
  await expect(page.getByText("Waiting for confirmed index sync…", { exact: true })).toBeVisible()
  await page.evaluate(() => window.__finishIndex("transport_error"))
  await expect(page.getByText("The local Memory service could not finish the request.", { exact: true })).toBeVisible()
  await expect(page.getByText("applied · Automatic capture is off", { exact: true })).toBeVisible()
  await sync.click()
  await page.evaluate(() => window.__finishIndex())
  await expect(page.getByText("Source policy: synced", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Changes are published. Search-index freshness is not verified by this proposal view.", {
      exact: true,
    }),
  ).toBeVisible()
  const messages = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  const indexing = messages.filter((row) => row.type === "secondBrain" && ["review", "sync"].includes(row.action))
  expect(indexing.map((row) => row.action)).toEqual(["review", "sync", "sync"])
  expect(indexing.every((row) => Object.keys(row).sort().join("|") === "action|id|type")).toBe(true)
  expect(messages.filter((row) => row.action === "proposal" && row.command.action === "apply")).toHaveLength(1)
  expect(messages.filter((row) => row.action === "cancel")).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
  expect(accessibility.violations).toEqual([])
  await page.screenshot({ path: info.outputPath("published-memory-indexing.png"), fullPage: true })
  await page.getByRole("button", { name: "Switch fixture workspace" }).click()
  await expect(sync).toHaveCount(0)
})

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
      await expect(page.locator(".admin-row")).toHaveCount(17)
      await expect(page.getByText("Healthy", { exact: true })).toHaveCount(17)
      await expect(page.getByText("contact authorized", { exact: true })).toBeVisible()
      await expect(page.getByText("Routines, Raya inbox, One worker", { exact: true })).toBeVisible()
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
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(16)
  const sent = JSON.parse((await page.locator("[data-messages]").textContent()) ?? "[]")
  expect(sent.filter((message: { type: string }) => message.type === "requestAdmin")).toEqual([])
  await audit(page)
})

test("keeps current health visible when diagnostics fail", async ({ page }) => {
  await page.goto("/?state=logs-error")
  await expect(page.getByText("All systems ready", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Recent diagnostics could not be loaded")
  await expect(page.locator(".admin-row")).toHaveCount(17)
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
  const refresh = page.getByRole("button", { name: "Refresh", exact: true })
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
