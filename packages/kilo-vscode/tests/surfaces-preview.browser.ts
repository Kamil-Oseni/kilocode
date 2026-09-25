import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { resolve } from "node:path"

test("long specialist names fit narrow receipts and messages", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  const name = "PersistenceVerificationSpecialistWithAnUnbrokenModelGeneratedName".repeat(2)
  await page.setContent(`
    <main style="width: calc(100vw - 32px); margin-inline: 16px; font: 12px sans-serif">
      <ul class="chief-receipt"><li>
        <span data-component="icon">◆</span>
        <span class="chief-receipt__name">${name}</span>
        <span class="chief-receipt__status">Report ready</span>
      </li></ul>
      <section class="chief-notes"><div class="chief-notes__message">
        <span data-component="icon">◆</span>
        <div><div class="chief-notes__name">${name} <span>sent a message</span></div><p>Finished.</p></div>
      </div></section>
    </main>
  `)
  await page.addStyleTag({ path: resolve("webview-ui/src/styles/tool-overrides.css") })
  for (const selector of [".chief-receipt li", ".chief-notes__message"]) {
    const box = page.locator(selector)
    expect(await box.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} recovery vocabulary at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-recovery`)
      await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.locator(".startup-error-recovery")).toContainText("Your conversations and drafts remain saved.")
      await expect(page.locator(".startup-error-recovery")).toContainText(
        "Retry the connection. Open technical details if it fails again.",
      )
      await expect(page.getByText("Turn interrupted.", { exact: true })).toBeVisible()
      await expect(page.getByText("Your prompt, conversation, and completed work remain available.")).toHaveCount(2)
      await expect(
        page.getByText("Review the partial result, then continue the conversation when ready."),
      ).toBeVisible()
      await expect(
        page.getByText("Review the technical details, then retry or choose another configured model."),
      ).toBeVisible()
      await expect(page.getByText("Your prompt and conversation remain available while you reconnect.")).toBeVisible()
      await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible()
      await page.getByRole("button", { name: "Details", exact: true }).click()
      await expect(page.locator(".error-detail-pre")).toContainText("UnknownError")
      await expect(page.getByText("spawn C:/Raya/bin/kilo.exe ENOENT", { exact: true })).toBeHidden()
      await page.locator(".startup-error-disclosure").click()
      await expect(page.getByText("spawn C:/Raya/bin/kilo.exe ENOENT", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      expect((await new AxeBuilder({ page }).include("[data-recovery-preview]").analyze()).violations).toEqual([])
      await page.screenshot({ path: info.outputPath("recovery-vocabulary.png"), fullPage: true })
    })

    test(`${theme} goal progress decisions at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })

      await page.goto(`/?state=${theme}-default`)
      const goal = page.getByRole("region", { name: "Goal status" })
      await expect(goal.getByText("Latest result", { exact: true })).toBeVisible()
      await expect(goal.getByText("Verified the preview serves cleanly on localhost.", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

      await page.goto(`/?state=${theme}-expanded`)
      await expect(goal).toHaveAttribute("data-status", "active")
      await expect(goal.getByText("Current work", { exact: true })).toBeVisible()
      await expect(
        goal.getByText("Plan task in progress: Verify every state in both themes", { exact: true }),
      ).toBeVisible()
      await expect(goal.locator(".goal-banner__usage")).toContainText("Plan: 1/3 tasks completed")
      await expect(goal.getByRole("button", { name: "Steer" })).toBeVisible()
      await expect(goal.getByRole("button", { name: "Pause" })).toBeVisible()
      await expect(goal.getByRole("button", { name: "Stop goal" })).toBeVisible()
      const activity = goal.locator(".goal-banner__activity")
      await expect(
        activity.getByText("12 turns · 87 tool calls. These counts describe activity, not goal completion."),
      ).toBeHidden()
      await activity.locator("summary").click()
      await expect(
        activity.getByText("12 turns · 87 tool calls. These counts describe activity, not goal completion."),
      ).toBeVisible()

      await page.goto(`/?state=${theme}-disabled`)
      await expect(goal).toHaveAttribute("aria-busy", "true")
      await expect(goal.getByText("Current work", { exact: true })).toBeVisible()
      await expect(goal.getByRole("button", { name: "Pause" })).toBeDisabled()

      await page.goto(`/?state=${theme}-paused`)
      await expect(goal).toHaveAttribute("data-status", "paused")
      await expect(goal.getByText("Paused", { exact: true })).toBeVisible()
      await expect(goal.getByText("Next decision", { exact: true })).toBeVisible()
      await expect(goal.getByText("Paused. Resume when ready, or steer the goal before continuing.")).toBeVisible()
      await expect(goal.getByRole("button", { name: "Resume" })).toBeVisible()

      await page.goto(`/?state=${theme}-waiting`)
      await expect(goal.getByText("Ready for review", { exact: true })).toBeVisible()
      await expect(goal.getByText("Next decision", { exact: true })).toBeVisible()
      await expect(
        goal.getByText("Your review is needed. Inspect the result, then accept it or request changes."),
      ).toBeVisible()

      await page.goto(`/?state=${theme}-blocked`)
      await expect(goal).toHaveAttribute("data-status", "blocked")
      await expect(goal.getByText("Blocked", { exact: true })).toBeVisible()
      await expect(goal.getByText("Next decision", { exact: true })).toBeVisible()
      await expect(
        goal.getByText("Compile failed. Fix the type errors, then run the smoke run again.").first(),
      ).toBeVisible()
      await expect(goal.getByRole("button", { name: "Resume" })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      expect((await new AxeBuilder({ page }).include(".goal-banner").analyze()).violations).toEqual([])
      await page.screenshot({ path: info.outputPath("goal-decisions.png"), fullPage: true })
    })
  }
}

test("uncertain cloud continuation requires an explicit duplicate-risk acknowledgement", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 })
  await page.goto("/?state=light-cloud-recovery")
  const card = page.locator('[data-slot="cloud-continuation"]')
  await expect(card).toContainText("Import pending or outcome unknown")
  await expect(card).toContainText("C:/work/raya")
  await page.getByRole("button", { name: "Allow a new copy" }).click()
  await expect(card).toContainText("The earlier import may have succeeded")
  await page.getByRole("button", { name: "Confirm new copy" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-preview-message", "reset-cloud")
  expect((await new AxeBuilder({ page }).include('[data-slot="cloud-continuation"]').analyze()).violations).toEqual([])
})

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} composer at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-composer`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      const prompt = page.locator("textarea.prompt-input")
      await expect(prompt).toBeVisible()
      await expect(prompt).toHaveAttribute("placeholder", "Message Raya")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      const result = await new AxeBuilder({ page }).include(".prompt-input-container").analyze()
      expect(result.violations).toEqual([])
      await page.screenshot({ path: info.outputPath("composer.png"), fullPage: true })
    })

    test(`${theme} history at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-history`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByRole("tab", { name: "Local" })).toBeVisible()
      await expect(page.getByPlaceholder("Search sessions...")).toBeVisible()
      await expect(page.getByText("Inline edit-review chrome")).toBeVisible()
      await expect(page.getByText("2 files changed")).toBeVisible()
      await expect(page.getByText("Open here")).toBeVisible()
      await expect(page.getByText("Continue task")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      expect((await new AxeBuilder({ page }).include(".history-view").analyze()).violations).toEqual([])
      await page.screenshot({ path: info.outputPath("history.png"), fullPage: true })
    })

    test(`${theme} topnav at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-topnav`)
      await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByText("Redesign Raya into an editorial system")).toBeVisible()
      await expect(page.getByRole("button", { name: "Compact session" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Toggle timeline" })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath("topnav.png"), fullPage: true })
    })
  }
}

test("light review cluster", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-review")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByText("Review changes")).toBeVisible()
  await expect(page.getByText("+128")).toBeVisible()
  await expect(page.getByRole("button", { name: "Keep all" })).toBeVisible()
  await page.goto("/?state=light-review-undo")
  await expect(page.getByRole("button", { name: "Confirm undo" })).toBeVisible()
})

for (const width of [320, 760]) {
  test(`workspace-only review has no futile actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/?state=light-review-workspace")
    await expect(page.getByRole("status")).toHaveText("Workspace changes. Keep and Undo aren't available here.")
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Keep all" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Undo all" })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })

  test(`review details load, fail, and retry without exposing bulk actions at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/?state=light-review-loading")
    await expect(page.getByRole("status")).toHaveText("Checking review details")
    await expect(page.getByRole("button", { name: "Keep all" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Undo all" })).toHaveCount(0)
    await page.goto("/?state=light-review-unavailable")
    await expect(page.getByRole("status")).toHaveText("Review details unavailable")
    await page.screenshot({ path: info.outputPath(`review-unavailable-${width}.png`), fullPage: true })
    await page.getByRole("button", { name: "Retry" }).click()
    await expect(page.getByRole("status")).toHaveText("Checking review details")
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Keep all" })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} production file review at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-edit-review`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByText("Edit files")).toBeVisible()
      await expect(page.getByText("Renamed file")).toBeVisible()
      await expect(page.getByText("Deleted file")).toBeVisible()
      await expect(page.getByRole("button", { name: "Open src/review/renamed.ts in the editor" })).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Open src/styles/legacy-composer.css in the editor" }),
      ).toBeVisible()
      await expect(page.getByText("C:/Users/example/project")).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Previous edit" }).first()).toBeVisible()
      await expect(page.getByRole("button", { name: "Next edit" }).first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      const result = await new AxeBuilder({ page }).include(".chat-view").analyze()
      expect(result.violations).toEqual([])
      await page.getByRole("button", { name: "Undo file" }).first().click()
      await expect(page.locator(".chat-view")).toHaveAttribute("data-review-request", "undo:src/review/renamed.ts")
      await page.screenshot({ path: info.outputPath("review.png"), fullPage: true })
    })
  }
}

test("light slash, transcript, and conversation", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-slash")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.locator('[data-highlight="slash"][data-command="goal"]')).toHaveText("/goal")
  await expect(page.locator('[data-highlight="slash"][data-command="loop"]')).toHaveText("/loop")
  await page.goto("/?state=light-transcript")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByText("prompt-input.css")).toBeVisible()
  await expect(page.getByText("bun run typecheck")).toBeVisible()
  await page.goto("/?state=light-conversation")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.locator('[data-highlight="slash"][data-command="goal"]')).toBeVisible()
  await expect(page.locator(".tool-group__count").first()).toContainText("steps")
  await expect(page.getByText("Here's the change to the composer stylesheet.")).toBeVisible()
  const times = page.locator('[data-fixture] [data-component="message-time"]')
  await expect(times).toHaveCount(2)
  await expect(times.nth(0)).toHaveAttribute("data-side", "user")
  await expect(times.nth(1)).toHaveAttribute("data-side", "assistant")
  for (const time of await times.all()) {
    await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/)
    await expect(time).toHaveAttribute("aria-label", /\d/)
    await expect(time).toBeVisible()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect((await new AxeBuilder({ page }).include('[data-component="message-time"]').analyze()).violations).toEqual([])
  await page.screenshot({ path: info.outputPath("chrome.png"), fullPage: true })
})

for (const width of [320, 760]) {
  test(`background agents remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/?state=light-background-agents")
    const fixture = page.locator("[data-fixture]")
    const agents = page.locator('[data-component="task-header-agents"]')
    const trigger = agents.locator('[data-slot="task-header-todos-trigger"]')
    await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
    await expect(trigger).toContainText("7 of 12 background agents running")
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(agents.locator('[data-slot="task-header-agent"]')).toHaveCount(12)
    await expect(agents.locator('[data-slot="task-header-agent-label"]').first()).toHaveText(
      "Review authentication boundaries",
    )
    await expect(agents.locator('[data-slot="task-header-agent-status-label"]').first()).toHaveText("Running")
    await expect(agents.locator('[data-slot="task-header-agent-role-icon"]').first()).toBeVisible()
    await expect(agents.locator('[data-slot="task-header-agent-role-icon"] use').nth(1)).toHaveAttribute(
      "href",
      "#opencode-icon-magnifying-glass",
    )
    await expect(page.getByText("The delegated check failed. Review its saved output before retrying.")).toBeVisible()
    await page.getByRole("button", { name: "Open background agent: Review authentication boundaries, Running" }).focus()
    await page.keyboard.press("Enter")
    await expect(page.locator("html")).toHaveAttribute("data-preview-message", /openSubAgentViewer.*child-1/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect(
      (await new AxeBuilder({ page }).include('[data-component="task-header-agents"]').analyze()).violations,
    ).toEqual([])
    await page.screenshot({ path: info.outputPath("background-agents.png"), fullPage: true })
  })
}

test("background agent disclosure and dismissal survive reload without hiding a restarted job", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-background-agents")
  const agents = page.locator('[data-component="task-header-agents"]')
  const trigger = agents.locator('[data-slot="task-header-todos-trigger"]')
  await trigger.click()
  await page.getByRole("button", { name: "Dismiss: Worker 10" }).click()
  await expect(page.getByText("Worker 10", { exact: true })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("raya-preview-webview-state")))
    .toContain("job-child-10")

  await page.reload()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByText("Worker 10", { exact: true })).toHaveCount(0)

  await page.goto("/?state=light-background-agents&scene=restart-running")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByText("Worker 10", { exact: true })).toBeVisible()
})

for (const width of [320, 760]) {
  test(`Agent Manager restores twelve child tabs and selection at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/?state=light-agent-manager-subagents")
    const panel = page.getByRole("region", { name: "Subagents" })
    const tabs = page.getByRole("tablist", { name: "Subagent sessions" })
    await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
    await expect(tabs.getByRole("tab")).toHaveCount(12)
    await expect(tabs.getByRole("tab", { name: "Worker 7" })).toHaveAttribute("aria-selected", "true")

    await tabs.getByRole("tab", { name: "Worker 10" }).click()
    await expect(tabs.getByRole("tab", { name: "Worker 10" })).toHaveAttribute("aria-selected", "true")
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = sessionStorage.getItem("raya-preview-webview-state")
          if (!raw) return undefined
          const state = JSON.parse(raw) as { rayaSubagents?: { active?: Record<string, string> } }
          return state.rayaSubagents?.active?.["single:parent"]
        }),
      )
      .toBe("child-10")

    await page.reload()
    await expect(tabs.getByRole("tab")).toHaveCount(12)
    await expect(tabs.getByRole("tab", { name: "Worker 10" })).toHaveAttribute("aria-selected", "true")
    await tabs.getByRole("tab", { name: "Worker 10" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(tabs.getByRole("tab", { name: "Worker 11" })).toHaveAttribute("aria-selected", "true")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect((await new AxeBuilder({ page }).include(".am-subagent-panel").analyze()).violations).toEqual([])
    await panel.screenshot({ path: info.outputPath("agent-manager-subagents.png") })
  })
}

for (const width of [320, 760]) {
  test(`standalone child steering remains usable at ${width}px`, async ({ page }, info) => {
    page.on("pageerror", (error) => console.error(error))
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/?state=light-child-viewer")
    const input = page.getByPlaceholder("Send an instruction to this sub-agent")
    await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
    await expect(page.getByRole("navigation", { name: "Conversation path" })).toContainText(
      "Ship delegated-agent monitoring",
    )
    await expect(page.getByRole("navigation", { name: "Conversation path" })).toContainText(
      "Review authentication boundaries",
    )
    await input.fill("Check the saved boundary before continuing.")
    await input.press("Enter")
    await expect(page.getByText("Instruction sent.")).toBeVisible()
    await expect(input).toHaveValue("")
    await expect(input).toBeFocused()
    await page.getByRole("button", { name: "Ship delegated-agent monitoring" }).click()
    await expect(page.locator("html")).toHaveAttribute("data-preview-message", /closePanel/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect((await new AxeBuilder({ page }).include('[data-component="subagent-viewer"]').analyze()).violations).toEqual(
      [],
    )
    await page.screenshot({ path: info.outputPath("child-viewer.png"), fullPage: true })
  })
}

test("failed child steering keeps the exact draft and explains recovery", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?state=light-child-viewer&scene=steer-failure")
  const input = page.getByPlaceholder("Send an instruction to this sub-agent")
  const text = "Keep the current draft and inspect the failed request."
  await input.fill(text)
  await page.getByRole("button", { name: "Send instruction" }).click()
  await expect(page.getByRole("alert")).toHaveText("The child connection was interrupted. Try again.")
  await expect(input).toHaveValue(text)
  await expect(page.getByRole("button", { name: "Send instruction" })).toBeEnabled()
})

for (const theme of ["light", "dark"]) {
  for (const width of [320, 760]) {
    test(`${theme} result package at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?state=${theme}-result`)
      const fixture = page.locator("[data-fixture]")
      await expect(fixture).toHaveAttribute("data-preview-kind", "production-view")
      await expect(page.getByText("Goal accepted through review")).toBeVisible()
      await expect(page.getByText("Evidence references accepted", { exact: true })).toBeVisible()
      await expect(page.getByText("bunx playwright test --config playwright.preview.config.ts").first()).toBeVisible()
      await expect(page.getByText("Not verified. Optional criteria do not prevent goal completion.")).toBeVisible()
      await expect(page.getByText("C:\\browser-artifacts\\monthly-report\\artifact")).toBeVisible()
      await expect(page.getByText("Verified download, 2,048 bytes, SHA-256 bbbbbbbbbbbb.")).toBeVisible()
      await expect(page.getByRole("button", { name: "Copy goal report" })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await page.screenshot({ path: info.outputPath("result.png"), fullPage: true })
    })
  }
}

test("light criteria editor", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto("/?state=light-editing")
  await expect(page.locator("[data-fixture]")).toHaveAttribute("data-preview-kind", "production-view")
  await expect(page.getByRole("textbox", { name: "Update the goal" })).toBeVisible()
  await expect(page.locator("legend", { hasText: "Acceptance criteria" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Criterion 1", exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Command for criterion 1", exact: true })).toBeVisible()
  await page.getByRole("textbox", { name: "Recorded charge limit", exact: true }).fill("5")
  const reason = page.getByRole("textbox", { name: "Why are these limits changing?", exact: true })
  await expect(reason).toBeVisible()
  await expect(page.getByRole("button", { name: "Update goal" })).toBeDisabled()
  await reason.fill("Allow the reviewed final operation.")
  await expect(page.getByRole("button", { name: "Update goal" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Update goal" })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath("editor.png"), fullPage: true })
})
