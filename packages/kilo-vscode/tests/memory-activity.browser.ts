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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const result = await new AxeBuilder({ page })
      .include('[aria-label="Consolidation activity"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
    expect(result.violations).toEqual([])
    await page.screenshot({ path: info.outputPath("consolidation-activity.png"), fullPage: true })
  })
}
