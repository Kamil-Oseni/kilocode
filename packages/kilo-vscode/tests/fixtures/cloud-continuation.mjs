import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "@playwright/test"

await mkdir("../../.tmp", { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
    await page.goto(`http://127.0.0.1:5201/?cloud&theme=${theme}`)
    const notice = page.getByRole("status").filter({ hasText: "Cloud preview" })
    await notice.waitFor()
    assert.match(await notice.textContent(), /C:\/projects\/a-very-long-unbroken-workspace-directory-name/)
    const input = page.locator("textarea.prompt-input")
    await input.fill("Continue with my recovery draft")
    await page.locator('input[type="file"]').setInputFiles({
      name: "draft.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
        "base64",
      ),
    })
    await page.locator(".prompt-send-button").click()
    await page.waitForFunction(() => JSON.parse(document.querySelector("[data-sent]").textContent).length === 1)
    assert.equal(await input.inputValue(), "Continue with my recovery draft")
    assert.equal(await page.locator(".prompt-send-button").getAttribute("aria-disabled"), "true")
    const sent = JSON.parse(await page.locator("[data-sent]").textContent())
    assert.equal(sent[0].args[3][0].filename, "draft.png")
    await page.getByRole("button", { name: "Uncertain cloud import", exact: true }).click()
    assert.match(await notice.textContent(), /Import outcome unknown/)
    assert.equal(await input.inputValue(), "Continue with my recovery draft")
    await input.press("Enter")
    assert.equal(JSON.parse(await page.locator("[data-sent]").textContent()).length, 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `../../.tmp/cloud-continuation-${theme}.png`, fullPage: true })
    await page.getByRole("button", { name: "Acknowledge local copy", exact: true }).click()
    assert.equal(await input.inputValue(), "")
    await page.getByRole("button", { name: "Fail local copy send", exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector("textarea.prompt-input").value === "Continue with my recovery draft",
    )
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    console.log(
      `${theme}: actual composer preserves cloud draft and attachment; discloses destination; blocks pending/uncertain duplicate submission; clears on local transition and restores failed local send; no horizontal overflow`,
    )
    await page.close()
  }
} finally {
  await browser.close()
}
