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

const failures = new WeakMap<Page, Error[]>()
test.beforeEach(async ({ page }) => {
  const errors: Error[] = []
  failures.set(page, errors)
  page.on("pageerror", (err) => {
    errors.push(err)
    console.error("Actual App fixture error:", err)
  })
})

test.afterEach(async ({ page }, info) => {
  expect(failures.get(page) ?? [], "Actual App must not produce uncaught browser errors").toEqual([])
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

for (const box of ["sidebar:new-task", "sidebar:fallback"])
  test(`actual restored ${box} draft retains its exact original identity when its discovered tab is selected`, async ({
    page,
  }) => {
    await page.goto(`/?draftBox=${encodeURIComponent(box)}`)
    const tabs = page.getByRole("tablist").getByRole("tab")
    await expect(tabs).toHaveCount(2)
    await tabs.nth(1).click()
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
    const prompt = page.locator("textarea.prompt-input")
    await expect(prompt).toHaveValue("  Restored unsent draft — café 日本語.  ")
    const saved = await page.evaluate(() => {
      const value = (
        window as unknown as {
          restoredDraft: {
            entry: { identity: { box: string; key: string; pendingID: string } }
            messages: { type: string; identity?: { box: string; key: string; pendingID?: string } }[]
          }
        }
      ).restoredDraft
      return {
        identity: value.entry.identity,
        loads: value.messages.filter((item) => item.type === "composerDraftLoad").map((item) => item.identity),
        writes: value.messages.filter((item) =>
          ["composerDraftClear", "composerDraftPromote", "sendMessage", "sendCommand", "routineRun"].includes(
            item.type,
          ),
        ),
      }
    })
    expect(saved.identity).toMatchObject({
      box,
      key: `${box}:pending:sidebar-pending:restored-original`,
      pendingID: "sidebar-pending:restored-original",
    })
    // The genuine catalog can hydrate from its cached entry without another GET.
    // Any subsequent load for that pending ID must keep the exact original box/key.
    for (const load of saved.loads.filter((item) => item?.pendingID === saved.identity.pendingID))
      expect(load).toMatchObject({
        box: saved.identity.box,
        key: saved.identity.key,
        pendingID: saved.identity.pendingID,
      })
    expect(saved.writes).toEqual([])
  })

for (const same of [false, true])
  test(`colliding restored composers ${same ? "same mode" : "different modes"} require an explicit original and preserve both exact drafts and choices`, async ({
    page,
  }) => {
    await page.goto(`/?draftBox=collision${same ? "&sameMode=1" : ""}`)
    const tabs = page.getByRole("tablist").getByRole("tab")
    await expect(tabs).toHaveCount(2)
    await tabs.nth(1).click()
    const prompt = page.locator("textarea.prompt-input")
    await expect(prompt).toHaveValue("")
    await expect(prompt).toHaveAttribute("aria-disabled", "true")
    const selector = page.locator('[data-slot="select-select-trigger"][aria-label="Original saved composer"]')
    const choose = async (box: string, text: string, model: string, variant: string) => {
      await selector.click()
      await page.getByRole("option").filter({ hasText: text.trim() }).click()
      await expect(prompt).toHaveValue(text)
      await expect(page.locator(".model-selector-trigger-label")).toContainText(model)
      await expect(page.locator(".thinking-selector-trigger-label")).toContainText(new RegExp(variant, "i"))
    }
    await choose("sidebar:new-task", "  Primary draft — 一番 café.  ", "Original first model", "low")
    await page.evaluate(() => (window as unknown as { restoredDraft: { hold: () => void } }).restoredDraft.hold())
    await selector.click({ force: true })
    await expect(page.getByRole("option")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(prompt).toHaveValue("  Primary draft — 一番 café.  ")
    await page.evaluate(() => (window as unknown as { restoredDraft: { release: () => void } }).restoredDraft.release())
    await choose("sidebar:fallback", "  Fallback draft — 二番 😀.  ", "Original second model", "high")
    await choose("sidebar:new-task", "  Primary draft — 一番 café.  ", "Original first model", "low")
    const saved = await page.evaluate(() => {
      const value = (
        window as unknown as {
          restoredDraft: {
            entries: { identity: { box: string; key: string; pendingID: string }; content: { text: string } }[]
            messages: { type: string }[]
          }
        }
      ).restoredDraft
      return {
        entries: value.entries,
        work: value.messages.filter((row) =>
          ["sendMessage", "sendCommand", "routineRun", "composerDraftClear", "composerDraftPromote"].includes(row.type),
        ),
      }
    })
    expect(saved.entries).toHaveLength(2)
    expect(saved.entries.map((row) => row.identity.box)).toEqual(["sidebar:new-task", "sidebar:fallback"])
    expect(saved.entries.map((row) => row.content.text)).toEqual([
      "  Primary draft — 一番 café.  ",
      "  Fallback draft — 二番 😀.  ",
    ])
    expect(saved.work).toEqual([])
    await page.getByRole("button", { name: "Discard draft", exact: true }).click()
    await expect(prompt).toHaveValue("")
    await expect(prompt).toHaveAttribute("aria-disabled", "true")
    await choose("sidebar:fallback", "  Fallback draft — 二番 😀.  ", "Original second model", "high")
    const remaining = await page.evaluate(() =>
      (
        window as unknown as { restoredDraft: { entries: { content: null | { text: string } }[] } }
      ).restoredDraft.entries.map((row) => row.content?.text ?? null),
    )
    expect(remaining).toEqual([null, "  Fallback draft — 二番 😀.  "])
  })
