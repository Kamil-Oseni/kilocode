import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test("actual composer saves and sends a reactive model selection without clone errors", async ({ page }) => {
  const failures: string[] = []
  page.on("pageerror", (error) => failures.push(error.message))
  await page.goto(`/?theme=dark&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  const text = "Private isolated chat check — café. Reply briefly."
  await prompt.fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator("[data-sent]")).toContainText(text)
  await expect(page.locator("[data-sent]")).toContainText("anthropic/claude-sonnet-4-6")
  expect(failures).toEqual([])
})

test("actual composer restores rich exact-whitespace drafts from disk after a fresh browser load", async ({
  page,
}, info) => {
  const failures: string[] = []
  page.on("pageerror", (error) => failures.push(error.message))
  const profile = crypto.randomUUID()
  await page.goto(`/?theme=dark&draft=${profile}`)
  const prompt = page.locator("textarea.prompt-input")
  const text = `  Learn violin\n${Array.from({ length: 30 }, (_, index) => `Practice ${index}: 你好 🎻`).join("\n")}  `
  await prompt.fill(text)
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name: "violin.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a5FAAAAAASUVORK5CYII=",
        "base64",
      ),
    })
  await page.evaluate(() =>
    window.postMessage(
      {
        type: "appendReviewComments",
        comments: [
          {
            id: "durable-review",
            file: "src/app.ts",
            side: "additions",
            line: 1,
            comment: "Keep this",
            selectedText: "x()",
          },
        ],
      },
      "*",
    ),
  )
  await page.getByRole("button", { name: "Unavailable model", exact: true }).click()
  await prompt.evaluate((node: HTMLTextAreaElement) => {
    node.scrollTop = 42
    node.setSelectionRange(2, 7)
    node.dispatchEvent(new Event("scroll"))
    node.dispatchEvent(new Event("select"))
  })
  const read = async () =>
    page.evaluate(async () => {
      const host = window as Window & {
        __readDraft: (identity: {
          box: string
          key: string
          sessionID: string
        }) => Promise<{
          entry?: {
            content: {
              text: string
              scroll: number
              selection?: { start: number; end: number }
              images: unknown[]
              comments: unknown[]
              model?: { providerID: string; modelID: string }
            }
          }
        }>
      }
      return (await host.__readDraft({ box: "fixture", key: "fixture:session:first", sessionID: "first" })).entry
        ?.content
    })
  await expect
    .poll(read)
    .toMatchObject({
      text,
      images: [{ filename: "violin.png" }],
      comments: [{ id: "durable-review" }],
      selection: { start: 2, end: 7 },
      model: { providerID: "missing-provider", modelID: "missing-model" },
    })
  const saved = await read()
  await page.reload()
  await expect(prompt).toHaveValue(text)
  await expect.poll(read).toEqual(saved)
  expect(
    await prompt.evaluate((node: HTMLTextAreaElement) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
      scroll: node.scrollTop,
    })),
  ).toEqual({ start: 2, end: 7, scroll: saved!.scroll })
  await page.screenshot({ path: info.outputPath("durable-rich-draft.png"), fullPage: true })
  expect(failures).toEqual([])
})

test("actual composer waits for accepted-user receipt and keeps typing made after send", async ({ page }) => {
  await page.goto(`/?theme=dark&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  await prompt.fill("First saved message")
  await page.evaluate(() => {
    ;(window as Window & { __holdDraftAcceptance: boolean }).__holdDraftAcceptance = true
  })
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(prompt).toHaveValue("First saved message")
  await prompt.fill("New typing after send")
  await expect
    .poll(() => page.evaluate(() => typeof (window as Window & { __acceptDraft?: () => void }).__acceptDraft))
    .toBe("function")
  await page.evaluate(() => (window as Window & { __acceptDraft: () => void }).__acceptDraft())
  await expect(prompt).toHaveValue("New typing after send")
  await page.reload()
  await expect(prompt).toHaveValue("New typing after send")
})

test("OpenAI voice admission preserves the task agent and displays missing-key recovery", async ({ page }) => {
  await page.goto("/?theme=dark")
  await page.getByRole("button", { name: "Select OpenAI preview without key", exact: true }).click()
  const summary = page.locator('.composer-configuration [data-slot="collapsible-trigger"]')
  await expect(summary).toContainText("Auto")
  await page.getByRole("button", { name: "Start voice", exact: true }).click()
  await expect(page.locator(".prompt-realtime-voice")).toContainText("Add your OpenAI API key")
  await expect(summary).toContainText("Auto")
  await expect(page.getByRole("button", { name: "Start voice", exact: true })).toBeVisible()
  const sent = await page.evaluate(
    () => (window as Window & { __composerMessages: { type: string }[] }).__composerMessages,
  )
  expect(sent.some((message) => message.type === "speechOpenAIStart" || message.type === "speechRealtimeStart")).toBe(
    false,
  )
})

test("busy composer keeps queue and stop actions clear", async ({ page }) => {
  await page.goto("/?theme=dark")
  const prompt = page.locator("textarea.prompt-input")

  await page.getByRole("button", { name: "Toggle busy", exact: true }).click()
  await prompt.fill("Continue with the next section")

  await expect(page.getByRole("status")).toHaveText("Send queues for the next safe step. Stop interrupts current work.")
  await expect(page.getByRole("button", { name: "Queue for the next safe step", exact: true })).toBeVisible()

  await prompt.fill("")
  await expect(page.getByRole("button", { name: "Stop work", exact: true })).toBeVisible()
})

test("composer keeps a steady edge and shows configuration inline when it fits", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 800 })
  await page.goto("/?theme=dark")
  const container = page.locator(".prompt-input-container")
  const prompt = container.locator("textarea.prompt-input")
  const disclosure = container.locator(".composer-configuration")
  const summary = disclosure.locator('[data-slot="collapsible-trigger"]')
  await expect(summary).toBeHidden()
  await expect(disclosure.locator(".composer-configuration-controls")).toBeVisible()
  await expect(container).not.toContainText("Starting voice shares recent saved task context")
  expect(
    await disclosure
      .getByRole("button", { name: "Auto", exact: true })
      .evaluate((node) => getComputedStyle(node).borderTopStyle),
  ).toBe("dashed")
  await container.screenshot({ path: info.outputPath("wide-inline.png") })
  const before = await container.evaluate((node) => getComputedStyle(node).borderTopColor)
  await prompt.focus()
  expect(await container.evaluate((node) => getComputedStyle(node).borderTopColor)).toBe(before)
  await disclosure.getByRole("button", { name: "Auto", exact: true }).click()
  await expect(page.getByRole("option", { name: "Plan", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 320, height: 800 })
  await expect(summary).toBeVisible()
  await expect(disclosure.locator(".composer-configuration-controls")).toBeHidden()
  await summary.click()
  await expect(disclosure.locator(".composer-configuration-controls")).toBeVisible()
  const popover = await disclosure.locator(".composer-configuration-body").boundingBox()
  expect(popover).not.toBeNull()
  expect(popover!.x).toBeGreaterThanOrEqual(0)
  expect(popover!.x + popover!.width).toBeLessThanOrEqual(320)
  await page.screenshot({ path: info.outputPath("narrow-popover.png"), fullPage: true })
  const tops = await disclosure.locator(".composer-configuration-controls").evaluate((node) => {
    const items = [node.children[0], node.children[1], node.querySelector(".prompt-status-button")]
    return items.map((item) => Math.round(item!.getBoundingClientRect().top))
  })
  expect(new Set(tops).size).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const [theme, width] of [
  ["light", 320],
  ["dark", 760],
  ["contrast", 320],
] as const) {
  test(`${theme} first run offers one recommended setup at ${width}px`, async ({ page }, info) => {
    const failures: string[] = []
    page.on("pageerror", (error) => failures.push(error.stack ?? error.message))
    await page.setViewportSize({ width, height: 800 })
    if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
    await page.goto(`/?theme=${theme}&onboarding=1`)

    const setup = page.locator(".work-style-picker")
    const action = setup.getByRole("button", { name: "Review first", exact: true })
    await expect(page.getByRole("heading", { name: "Welcome to Raya" })).toBeVisible()
    await expect(setup.getByRole("heading", { name: "Choose how you want to work" })).toBeVisible()
    await expect(action).toBeVisible()
    await expect(setup.getByRole("button")).toHaveCount(1)
    await expect(setup).not.toContainText("High autonomy")
    await expect(setup).toContainText("Asks before editing files or running commands")
    await page.screenshot({ path: info.outputPath("recommended-setup.png"), fullPage: true })

    await action.click()
    await expect(action).toBeDisabled()
    expect(
      await page.evaluate(() =>
        (window as Window & { __composerMessages: { type: string; style?: string }[] }).__composerMessages.some(
          (message) => message.type === "applyWorkStyle" && message.style === "human-in-the-loop",
        ),
      ),
    ).toBe(true)

    await page.evaluate(() =>
      window.postMessage(
        { type: "workStyleApplyFailed", message: "Your setup was not saved. Try again.", rollbackFailed: false },
        "*",
      ),
    )
    await expect(setup.getByRole("alert")).toContainText("Your setup was not saved. Try again.")
    await expect(action).toBeEnabled()
    await page.screenshot({ path: info.outputPath("setup-error.png"), fullPage: true })

    await setup.getByRole("link", { name: "Settings." }).click()
    expect(
      await page.evaluate(() =>
        (window as Window & { __composerMessages: { type: string; tab?: string }[] }).__composerMessages.some(
          (message) => message.type === "openSettingsPanel" && message.tab === "autoApprove",
        ),
      ),
    ).toBe(true)

    await action.click()
    await page.evaluate(() => window.postMessage({ type: "workStyleApplied", style: "human-in-the-loop" }, "*"))
    await expect(page.locator(".raya-home__heading")).toHaveText("Chats")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
    const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
    expect(audit.violations).toEqual([])
    if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
    expect(failures).toEqual([])
    await page.screenshot({ path: info.outputPath("outcome-entry.png"), fullPage: true })
  })
}

for (const theme of ["light", "dark", "contrast"])
  for (const width of [320]) {
    test(`${theme} outcome entry and real configuration controls at ${width}px`, async ({ page }, info) => {
      const failures: string[] = []
      page.on("pageerror", (error) => failures.push(error.stack ?? error.message))
      await page.setViewportSize({ width, height: 960 })
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      await page.goto(`/?theme=${theme}`)
      expect(failures).toEqual([])
      const prompt = page.locator("textarea.prompt-input")
      const disclosure = page.locator(".composer-configuration")
      const summary = disclosure.locator('[data-slot="collapsible-trigger"]')
      const logo = page.getByRole("img", { name: "Raya" })
      await expect(page.locator(".raya-home__heading")).toHaveText("Chats")
      await expect(logo).toBeVisible()
      if (theme === "contrast") {
        const colors = await logo.evaluate((node) => ({
          fill: getComputedStyle(node.querySelector("path")!).fill,
          text: getComputedStyle(document.body).color,
        }))
        expect(colors.fill).toBe(colors.text)
        const controls = await page
          .locator(
            '.prompt-input-hint-actions [data-component="button"], .prompt-input-hint-actions [data-component="icon-button"], .prompt-input-hint-actions .prompt-voice-orb',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              border: getComputedStyle(node).borderTopColor,
              style: getComputedStyle(node).borderTopStyle,
              text: getComputedStyle(document.body).color,
            })),
          )
        expect(controls.length).toBeGreaterThanOrEqual(1)
        expect(controls.every((item) => item.border === item.text && item.style === "solid")).toBe(true)
      }
      await expect(summary).toContainText("Auto · Claude Sonnet 4.6")
      await expect(summary).not.toContainText("Raya Gateway")
      await expect(summary).not.toContainText("Reasoning")
      await page.locator(".prompt-input-container").screenshot({ path: info.outputPath("collapsed.png") })
      await expect(summary).toHaveAttribute("aria-expanded", "false")
      await prompt.fill("Review this material and return a concise summary with caveats.")
      await summary.focus()
      await page.keyboard.press("Enter")
      await expect(summary).toHaveAttribute("aria-expanded", "true")
      await expect(disclosure).not.toContainText("Choose how Raya works")
      await expect(disclosure.locator(".composer-configuration-controls")).toBeVisible()
      await page.locator(".prompt-input-container").screenshot({ path: info.outputPath("expanded.png") })
      await disclosure.getByRole("button", { name: "Auto", exact: true }).click()
      await page.getByRole("option", { name: "Plan", exact: true }).click()
      await expect(summary).toContainText("Plan")
      await expect(prompt).toBeFocused()
      await expect(prompt).toHaveValue("Review this material and return a concise summary with caveats.")
      await summary.focus()
      await page.keyboard.press("Escape")
      await expect(summary).toHaveAttribute("aria-expanded", "false")
      await expect(summary).toBeFocused()
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openModelPicker", { detail: { source: "another-composer" } })),
      )
      await expect(summary).toHaveAttribute("aria-expanded", "false")
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openModelPicker", { detail: { source: "fixture" } })),
      )
      await expect(summary).toHaveAttribute("aria-expanded", "true")
      await expect(page.getByRole("tree", { name: "Select model" })).toBeVisible()
      await expect(page.getByRole("treeitem").filter({ hasText: "Claude Sonnet 4.6" }).first()).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(prompt).toBeFocused()
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openVariantPicker", { detail: { source: "fixture" } })),
      )
      await expect(page.getByRole("option", { name: "Default", exact: true })).toBeFocused()
      // A delayed prior picker callback must not steal the new option's focus.
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("focusPrompt", { detail: { restore: true, source: "fixture" } })),
      )
      await expect(page.getByRole("option", { name: "Default", exact: true })).toBeFocused()
      await page.getByRole("option", { name: "High", exact: true }).click()
      await expect(summary).not.toContainText("Reasoning")
      await expect(prompt).toBeFocused()
      await page.getByRole("button", { name: "Toggle connection", exact: true }).click()
      await prompt.press("Enter")
      await expect(page.locator("[data-sent]")).toHaveText("[]")
      await expect(prompt).toHaveValue("Review this material and return a concise summary with caveats.")
      await page.getByRole("button", { name: "Toggle connection", exact: true }).click()
      await page.getByRole("button", { name: "Switch session", exact: true }).click()
      await expect(prompt).toHaveValue("")
      await prompt.fill("Second session draft")
      await page.getByRole("button", { name: "Switch session", exact: true }).click()
      await expect(prompt).toHaveValue("Review this material and return a concise summary with caveats.")
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: "material.txt", mimeType: "text/plain", buffer: Buffer.from("Material for review") })
      await expect(page.locator(".prompt-input-container")).toContainText("material.txt")
      await prompt.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true })
      await expect(page.locator("[data-sent]")).toHaveText("[]")
      await prompt.press("Enter")
      await expect(page.locator("[data-sent]")).toContainText("material.txt")
      await expect(page.locator("[data-sent]")).toContainText('"agent":"plan"')
      await expect(page.locator("[data-sent]")).toContainText('"variant":"high"')
      await expect(page.locator("[data-sent]")).toContainText("anthropic/claude-sonnet-4-6")
      await expect(prompt).toHaveValue("")
      await prompt.fill("/goal Finish the report")
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("Report evidence") })
      await expect(page.locator(".prompt-input-container")).toContainText("report.txt")
      await prompt.press("Enter")
      await expect(prompt).toHaveValue("")
      await page.evaluate(() => {
        const sends = JSON.parse(document.querySelector("[data-sent]")!.textContent!)
        const args = sends.at(-1).args
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "sendMessageFailed",
              error: "Goal start was not confirmed",
              text: args[0],
              files: args[3],
              sessionID: args[7],
              messageID: "fixture-goal-send",
            },
          }),
        )
      })
      await expect(prompt).toHaveValue("/goal Finish the report")
      await expect(page.locator(".prompt-input-container")).toContainText("report.txt")
      expect(await page.locator("[data-sent]").evaluate((node) => JSON.parse(node.textContent!).length)).toBe(2)
      await prompt.press("Enter")
      await expect(prompt).toHaveValue("")
      expect(await page.locator("[data-sent]").evaluate((node) => JSON.parse(node.textContent!).length)).toBe(3)
      await page.getByRole("button", { name: "Unavailable model", exact: true }).click()
      await expect(summary).not.toContainText("missing-provider")
      await expect(summary).toContainText("missing-model")
      await expect(summary).toContainText("Model unavailable")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      // Axe reads authored foreground values rather than forced system colors.
      // Audit the configured high-contrast palette, then capture system rendering.
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "none" })
      const audit = await new AxeBuilder({ page })
        .include(".composer-configuration")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(audit.violations).toEqual([])
      if (theme === "contrast") await page.emulateMedia({ forcedColors: "active" })
      expect(failures).toEqual([])
      await page.screenshot({ path: info.outputPath("composer.png"), fullPage: true })
    })
  }

test("actual composer keeps conflicting edits as a separate durable pending draft", async ({ page }) => {
  const profile = crypto.randomUUID()
  await page.goto(`/?theme=dark&draft=${profile}`)
  const prompt = page.locator("textarea.prompt-input")
  await prompt.fill("Original saved draft")
  const identity = { box: "fixture", key: "fixture:session:first", sessionID: "first" }
  await expect
    .poll(() =>
      page.evaluate(async (identity) => {
        const host = window as Window & {
          __readDraft: (identity: unknown) => Promise<{ entry?: { content?: { text: string } } }>
        }
        return (await host.__readDraft(identity)).entry?.content?.text
      }, identity),
    )
    .toBe("Original saved draft")
  await page.evaluate(async (identity) => {
    const host = window as Window & { __changeRemoteDraft: (identity: unknown, text: string) => Promise<unknown> }
    const reply = await host.__changeRemoteDraft(identity, "Other pane draft")
    if (!reply || typeof reply !== "object" || "error" in reply)
      throw new Error(
        `Competing pane save failed: ${JSON.stringify(reply && typeof reply === "object" && "error" in reply ? reply.error : "missing-receipt")}`,
      )
  }, identity)
  await prompt.fill("  My conflicting edits  ")
  await expect(page.getByRole("button", { name: "Save as new draft", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Save as new draft", exact: true }).click()
  await expect(prompt).toHaveValue("  My conflicting edits  ")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __pendingDraft?: string }).__pendingDraft))
    .toBeTruthy()
  const pending = await page.evaluate(() => (window as Window & { __pendingDraft: string }).__pendingDraft)
  await page.goto(`/?theme=dark&draft=${profile}&pending=${encodeURIComponent(pending)}`)
  await expect(prompt).toHaveValue("  My conflicting edits  ")
  await page.getByRole("button", { name: "Discard draft", exact: true }).click()
  await expect(prompt).toHaveValue("")
  await expect
    .poll(() =>
      page.evaluate(async (pending) => {
        const host = window as Window & {
          __readDraft: (identity: unknown) => Promise<{ entry?: { content: unknown } }>
        }
        return (await host.__readDraft({ box: "fixture", key: `fixture:${pending}`, pendingID: pending })).entry
          ?.content
      }, pending),
    )
    .toBeNull()
  await page.reload()
  await expect(prompt).toHaveValue("")
  await page.goto(`/?theme=dark&draft=${profile}`)
  await expect(prompt).toHaveValue("Other pane draft")
})

test("actual composer restores text and PDF attachments and sends their exact bytes", async ({ page }) => {
  const failures: string[] = []
  page.on("pageerror", (error) => failures.push(error.message))
  await page.goto(`/?theme=dark&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  await prompt.fill("  Review these files  ")
  await page.locator('input[type="file"]').setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("  exact notes\n你好  ", "utf8") },
    { name: "lesson.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nfixture\n%%EOF") },
  ])
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const host = window as Window & {
          __readDraft: (
            identity: unknown,
          ) => Promise<{ entry?: { content?: { images: Array<{ filename: string; mime: string; dataUrl: string }> } } }>
        }
        return (await host.__readDraft({ box: "fixture", key: "fixture:session:first", sessionID: "first" })).entry
          ?.content?.images
      }),
    )
    .toMatchObject([
      {
        filename: "notes.txt",
        mime: "text/plain",
        dataUrl: `data:text/plain;base64,${Buffer.from("  exact notes\n你好  ", "utf8").toString("base64")}`,
      },
      {
        filename: "lesson.pdf",
        mime: "application/pdf",
        dataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.7\nfixture\n%%EOF").toString("base64")}`,
      },
    ])
  await page.reload()
  await expect(prompt).toHaveValue("  Review these files  ")
  await expect(page.locator(".image-attachment")).toHaveCount(2)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(prompt).toHaveValue("")
  await expect(page.locator("[data-sent]")).toContainText(
    Buffer.from("  exact notes\n你好  ", "utf8").toString("base64"),
  )
  await expect(page.locator("[data-sent]")).toContainText(Buffer.from("%PDF-1.7\nfixture\n%%EOF").toString("base64"))
  expect(failures).toEqual([])
})

test("actual composer carries rich choices into an explicitly captured new task without cross-owner apply", async ({
  page,
}) => {
  await page.goto(`/?theme=dark&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  await prompt.fill("  New task carry  ")
  await page.getByRole("button", { name: "Unavailable model", exact: true }).click()
  const task = crypto.randomUUID()
  await page.evaluate((task) => {
    const host = window as Window & { __draftProfile: string }
    window.dispatchEvent(
      new CustomEvent("agentManagerCaptureDraft", { detail: { id: task, owner: host.__draftProfile } }),
    )
    window.dispatchEvent(
      new CustomEvent("agentManagerApplyDraft", {
        detail: { id: task, sessionId: "second", boxId: "fixture", owner: "another-owner" },
      }),
    )
  }, task)
  expect(
    await page.evaluate(async () => {
      const host = window as Window & { __readDraft: (identity: unknown) => Promise<{ entry?: unknown }> }
      return (await host.__readDraft({ box: "fixture", key: "fixture:session:second", sessionID: "second" })).entry
    }),
  ).toBeUndefined()
  const valid = crypto.randomUUID()
  await page.evaluate((task) => {
    const host = window as Window & { __draftProfile: string }
    window.dispatchEvent(
      new CustomEvent("agentManagerCaptureDraft", { detail: { id: task, owner: host.__draftProfile } }),
    )
    window.dispatchEvent(
      new CustomEvent("agentManagerApplyDraft", {
        detail: { id: task, sessionId: "second", boxId: "fixture", owner: host.__draftProfile },
      }),
    )
  }, valid)
  await page.getByRole("button", { name: "Switch session", exact: true }).click()
  await expect(prompt).toHaveValue("  New task carry  ")
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const host = window as Window & {
          __readDraft: (
            identity: unknown,
          ) => Promise<{ entry?: { content?: { model?: { providerID: string; modelID: string } } } }>
        }
        return (await host.__readDraft({ box: "fixture", key: "fixture:session:second", sessionID: "second" })).entry
          ?.content?.model
      }),
    )
    .toEqual({ providerID: "missing-provider", modelID: "missing-model" })
})

test("actual composer leaves an untouched mount pristine but retains an explicit model-only choice", async ({
  page,
}) => {
  await page.goto(`/?theme=dark&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  await expect(prompt).toHaveValue("")
  const list = () =>
    page.evaluate(async () =>
      (window as Window & { __listDrafts: () => Promise<{ entries: unknown[] }> }).__listDrafts(),
    )
  await expect.poll(list).toMatchObject({ entries: [] })
  await page.reload()
  await expect.poll(list).toMatchObject({ entries: [] })
  await page.getByRole("button", { name: /Claude Sonnet 4.6/ }).click()
  await page.getByRole("treeitem").filter({ hasText: "Claude Sonnet 4.6" }).last().click()
  await page.keyboard.press("Enter")
  await expect
    .poll(list)
    .toMatchObject({
      entries: [{ content: { text: "", model: { providerID: "kilo", modelID: "anthropic/claude-sonnet-4-6" } } }],
    })
  await page.reload()
  await expect
    .poll(list)
    .toMatchObject({
      entries: [{ content: { text: "", model: { providerID: "kilo", modelID: "anthropic/claude-sonnet-4-6" } } }],
    })
  await prompt.press("Shift+Tab")
  await expect.poll(list).toMatchObject({ entries: [{ content: { text: "", variant: "low" } }] })
  await page.reload()
  await expect.poll(list).toMatchObject({ entries: [{ content: { text: "", variant: "low" } }] })
})

test("actual composer hides ownerless A drafts immediately in B before first owner hydration", async ({ page }) => {
  await page.goto(`/?theme=dark&cold=1&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  await expect(page.getByRole("button", { name: /Select model:/ })).toBeDisabled()
  await prompt.fill("  A before owner  ")
  await page.evaluate(() =>
    (window as Window & { __switchDraftWorkspace: (value: string) => void }).__switchDraftWorkspace("fixture-B"),
  )
  await expect(prompt).toHaveValue("")
  await prompt.fill("B before owner")
  await page.evaluate(() =>
    (window as Window & { __switchDraftWorkspace: (value: string) => void }).__switchDraftWorkspace("fixture-A"),
  )
  await expect(prompt).toHaveValue("  A before owner  ")
  await page.evaluate(() => (window as Window & { __releaseDraftOwner: () => void }).__releaseDraftOwner())
  await expect(page.getByRole("button", { name: /Select model:/ })).toBeEnabled()
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (window as Window & { __listDrafts: () => Promise<{ entries: unknown[] }> }).__listDrafts(),
      ),
    )
    .toMatchObject({ entries: [{ content: { text: "  A before owner  " } }] })
})

test("actual composer delivers delayed FileReader attachments only to the captured session", async ({ page }) => {
  await page.goto(`/?theme=dark&draft=${crypto.randomUUID()}`)
  const prompt = page.locator("textarea.prompt-input")
  await prompt.fill("A attachment draft")
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (file) {
      const reader = this
      ;(window as Window & { __resumeFile?: () => void }).__resumeFile = () => read.call(reader, file)
    }
  })
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "captured.txt", mimeType: "text/plain", buffer: Buffer.from("captured A bytes") })
  await page.getByRole("button", { name: "Switch session", exact: true }).click()
  await expect(prompt).toHaveValue("")
  await prompt.fill("B separate draft")
  await page.evaluate(() => (window as Window & { __resumeFile?: () => void }).__resumeFile?.())
  const read = (sessionID: string) =>
    page.evaluate(async (sessionID) => {
      const host = window as Window & {
        __readDraft: (
          identity: unknown,
        ) => Promise<{ entry?: { content?: { text: string; images: { filename: string; dataUrl: string }[] } } }>
      }
      return (await host.__readDraft({ box: "fixture", key: `fixture:session:${sessionID}`, sessionID })).entry?.content
    }, sessionID)
  await expect
    .poll(() => read("first"))
    .toMatchObject({
      text: "A attachment draft",
      images: [
        {
          filename: "captured.txt",
          dataUrl: `data:text/plain;base64,${Buffer.from("captured A bytes").toString("base64")}`,
        },
      ],
    })
  await expect.poll(() => read("second")).toMatchObject({ text: "B separate draft", images: [] })
  await expect(prompt).toHaveValue("B separate draft")
  await page.getByRole("button", { name: "Switch session", exact: true }).click()
  await expect(prompt).toHaveValue("A attachment draft")
  await page.reload()
  await expect.poll(() => read("first")).toMatchObject({ images: [{ filename: "captured.txt" }] })
})
