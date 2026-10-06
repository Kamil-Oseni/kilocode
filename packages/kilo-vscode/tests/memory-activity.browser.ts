import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const theme of ["dark", "light"]) {
  test(`${theme} consolidation activity retains exact Cancel identity and wraps on narrow screens`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto(`/?state=${theme}-memory-activity`)
    const view = page.getByRole("region", { name: "Consolidation activity" })
    await expect(view.getByText("Model: fixture/model")).toBeVisible()
    const stop = view.getByRole("button", { name: "Cancel consolidation" })
    await stop.focus()
    await expect(stop).toBeFocused()
    await page.keyboard.press("Enter")
    const request = await page.evaluate(() => JSON.parse(document.documentElement.dataset.previewDreamCancel ?? "{}"))
    expect(request).toMatchObject({
      type: "secondBrain",
      action: "dreamCancel",
      target: {
        id: "11111111-1111-4111-8111-111111111111",
        owner: "22222222-2222-4222-8222-222222222222",
      },
    })
    await expect(view.getByRole("button", { name: "Joining cancelled request…" })).toBeDisabled()
    await page.evaluate(
      (id) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "secondBrainState",
              id,
              state: {
                configured: false,
                status: "disconnected",
                results: [],
                dream: {
                  status: "closed",
                  activity: {
                    id: "11111111-1111-4111-8111-111111111111",
                    owner: "22222222-2222-4222-8222-222222222222",
                    project: "C:/Synthetic/ApprovedProject/MemoryConsolidationFixture/LongProjectFolder",
                    model: "fixture/model",
                    revision: 3,
                    phase: "cancelled",
                    lifecycle: "joined",
                  },
                },
              },
            },
          }),
        ),
      request.id,
    )
    await expect(view.getByText("Consolidation cancelled", { exact: true })).toBeVisible()
    await expect(view.getByRole("button", { name: "Cancel consolidation" })).toHaveCount(0)
    await view.getByRole("button", { name: "Refresh activity" }).click()
    await expect(view.getByText("Consolidation cancelled", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Inspect saved checkpoint", exact: true }).click()
    const inspection = await page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.previewDreamInspect ?? "{}"),
    )
    expect(Object.keys(inspection).sort()).toEqual(["action", "id", "type"])
    expect(inspection).toMatchObject({ type: "secondBrain", action: "dreamInspect" })
    await expect(view.getByRole("button", { name: "Opening checkpoint…" })).toBeDisabled()
    for (const status of ["unavailable", "closed"]) {
      if (status === "closed") {
        await view.getByRole("button", { name: "Inspect saved checkpoint", exact: true }).click()
      }
      const id = await page.evaluate(() => JSON.parse(document.documentElement.dataset.previewDreamInspect ?? "{}").id)
      await page.evaluate(
        ({ id, status }) =>
          window.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "secondBrainState",
                id,
                state: {
                  configured: false,
                  status: "disconnected",
                  results: [],
                  dream: { status },
                },
              },
            }),
          ),
        { id, status },
      )
      await expect(
        view.getByText(
          status === "unavailable"
            ? "Saved checkpoint inspection could not finish. Keep the original run and proposal IDs for trusted inspection."
            : "Inspection command returned. Saved history does not clear unresolved cleanup or publish proposals.",
          { exact: true },
        ),
      ).toBeVisible()
      await expect(view.getByText("Consolidation cancelled", { exact: true })).toBeVisible()
      await expect(view.getByRole("button", { name: "Cancel consolidation" })).toHaveCount(0)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const result = await new AxeBuilder({ page })
      .include('[aria-label="Consolidation activity"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
    expect(result.violations).toEqual([])
    await page.screenshot({ path: info.outputPath("consolidation-activity.png"), fullPage: true })
  })
}

test("lost activity read expires without cancelling work and late responses cannot enable Stop", async ({ page }) => {
  await page.goto("/?state=dark-memory-activity")
  const view = page.getByRole("region", { name: "Consolidation activity" })
  const stop = view.getByRole("button", { name: "Cancel consolidation" })
  await expect(stop).toBeEnabled()
  await page.clock.install()
  await page.evaluate(() => {
    document.documentElement.dataset.previewHoldDreamActivity = "true"
  })
  await view.getByRole("button", { name: "Refresh activity" }).click()
  const request = await page.evaluate(() => JSON.parse(document.documentElement.dataset.previewDreamActivity ?? "{}"))
  await page.clock.fastForward(10001)
  await expect(view.getByRole("alert")).toContainText("Activity is unavailable")
  await expect(stop).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.dataset.previewDreamCancel)).toBeUndefined()
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "secondBrainState",
            id,
            state: {
              configured: false,
              status: "disconnected",
              results: [],
              dream: {
                status: "closed",
                activity: {
                  id: "11111111-1111-4111-8111-111111111111",
                  owner: "22222222-2222-4222-8222-222222222222",
                  project: "C:/Synthetic/late",
                  model: "late/model",
                  revision: 99,
                  phase: "generation",
                  lifecycle: "active",
                },
              },
            },
          },
        }),
      ),
    request.id,
  )
  await expect(stop).toBeDisabled()
  await expect(view.getByText("Model: fixture/model")).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset.previewHoldDreamActivity = "false"
  })
  await view.getByRole("button", { name: "Refresh activity" }).click()
  await expect(view.getByRole("alert")).toHaveCount(0)
  await expect(stop).toBeEnabled()
})

test("lost cancellation receipt becomes unconfirmed without replay and its original reply still settles", async ({
  page,
}) => {
  await page.goto("/?state=dark-memory-activity")
  const view = page.getByRole("region", { name: "Consolidation activity" })
  await expect(view.getByRole("button", { name: "Cancel consolidation" })).toBeEnabled()
  await page.clock.install()
  await view.getByRole("button", { name: "Cancel consolidation" }).click()
  const original = await page.evaluate(() => document.documentElement.dataset.previewDreamCancel!)
  await page.clock.fastForward(10001)
  await expect(view.getByRole("button", { name: "Cancellation unconfirmed" })).toBeDisabled()
  await expect(view.getByRole("alert")).toContainText("Cancellation has not been confirmed")
  await view.getByRole("button", { name: "Refresh activity" }).click()
  await expect(view.getByRole("button", { name: "Cancellation unconfirmed" })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.dataset.previewDreamCancel)).toBe(original)
  const request = JSON.parse(original)
  const reply = async (id: string) => {
    await page.evaluate(
      (id) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "secondBrainState",
              id,
              state: {
                configured: false,
                status: "disconnected",
                results: [],
                dream: {
                  status: "closed",
                  activity: {
                    id: "11111111-1111-4111-8111-111111111111",
                    owner: "22222222-2222-4222-8222-222222222222",
                    project: "C:/Synthetic/ApprovedProject/MemoryConsolidationFixture/LongProjectFolder",
                    model: "fixture/model",
                    revision: 3,
                    phase: "cancelled",
                    lifecycle: "joined",
                  },
                },
              },
            },
          }),
        ),
      id,
    )
  }
  await reply("foreign-receipt")
  await expect(view.getByRole("button", { name: "Cancellation unconfirmed" })).toBeDisabled()
  await reply(request.id)
  await expect(view.getByText("Consolidation cancelled", { exact: true })).toBeVisible()
  await expect(view.getByRole("alert")).toHaveCount(0)
  await expect(view.getByRole("button", { name: "Cancellation unconfirmed" })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.dataset.previewDreamCancel)).toBe(original)
})

test("fresh joined activity settles only the original cancellation owner", async ({ page }) => {
  await page.goto("/?state=dark-memory-activity")
  const view = page.getByRole("region", { name: "Consolidation activity" })
  await expect(view.getByRole("button", { name: "Cancel consolidation" })).toBeEnabled()
  await page.clock.install()
  await page.evaluate(() => {
    document.documentElement.dataset.previewHoldDreamActivity = "true"
  })
  await view.getByRole("button", { name: "Cancel consolidation" }).click()
  const original = await page.evaluate(() => document.documentElement.dataset.previewDreamCancel!)
  await page.clock.fastForward(10001)
  for (const row of [
    { revision: 1, owner: "22222222-2222-4222-8222-222222222222", lifecycle: "joined" },
    { revision: 3, owner: "33333333-3333-4333-8333-333333333333", lifecycle: "joined" },
    { revision: 4, owner: "22222222-2222-4222-8222-222222222222", lifecycle: "uncertain" },
    { revision: 5, owner: "22222222-2222-4222-8222-222222222222", lifecycle: "joined" },
  ]) {
    await view.getByRole("button", { name: "Refresh activity" }).click()
    const id = await page.evaluate(() => JSON.parse(document.documentElement.dataset.previewDreamActivity!).id)
    await page.evaluate(
      ({ id, row }) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "secondBrainState",
              id,
              state: {
                configured: false,
                status: "disconnected",
                results: [],
                dream: {
                  status: "closed",
                  activity: {
                    id: "11111111-1111-4111-8111-111111111111",
                    project: "C:/Synthetic/Approved",
                    model: "fixture/model",
                    phase: "cancelled",
                    ...row,
                  },
                },
              },
            },
          }),
        ),
      { id, row },
    )
    const notice = view.getByText(/Cancellation has not been confirmed/)
    if (row.revision === 5) await expect(notice).toHaveCount(0)
    if (row.revision !== 5) await expect(notice).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.dataset.previewDreamCancel)).toBe(original)
  }
  await expect(view.getByRole("button", { name: "Cancel consolidation" })).toHaveCount(0)
})
