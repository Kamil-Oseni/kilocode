import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

declare global {
  interface Window {
    connections: {
      messages: () => { type: string; config?: unknown; projectConfig?: unknown }[]
      actions: () => { type: string; name: string; directory?: string }[]
      offline: () => void
    }
  }
}

test("Connections overview layout and keyboard access at 320px", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 850 })
  for (const theme of ["light", "dark", "contrast"] as const) {
    await page.emulateMedia({
      colorScheme: theme === "light" ? "light" : "dark",
      forcedColors: theme === "contrast" ? "active" : "none",
    })
    await page.goto(`/?theme=${theme}`)
    const hub = page.locator('[data-component="connections-settings"]')
    await expect(hub.getByText("Project", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const buttons = hub.getByRole("button")
    for (const button of await buttons.all()) await expect(button).toHaveAccessibleName(/\S/)
    await page.keyboard.press("Tab")
    await expect(buttons.first()).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(hub.locator("button:not([disabled])").nth(1)).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(buttons.first()).toBeFocused()
    expect(await page.evaluate(() => window.connections.actions())).toEqual([])
    await page.screenshot({ path: info.outputPath(`connections-320-${theme}.png`), fullPage: true })
    await info.attach(`theme-${theme}.json`, {
      contentType: "application/json",
      body: JSON.stringify(
        await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement)
          const button = document.querySelector('[data-component="connections-settings"] button')
          return {
            theme: document.documentElement.dataset.theme,
            scheme: document.documentElement.dataset.colorScheme,
            vscode: root.getPropertyValue("--vscode-editor-foreground"),
            strong: root.getPropertyValue("--text-strong"),
            foreground: button && getComputedStyle(button).color,
            background: button && getComputedStyle(button).backgroundColor,
          }
        }),
      ),
    })
    const audit = await new AxeBuilder({ page })
      .include('[data-component="connections-settings"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()
    expect.soft(audit.violations).toEqual([])
  }
})

test("actual Connections overview is passive and explicit changes retain their configuration scope", async ({
  page,
}) => {
  await page.goto("/")
  const hub = page.locator('[data-component="connections-settings"]')
  const card = (name: string) =>
    hub.locator('[data-component="card"]').filter({ has: page.getByText(name, { exact: true }) })
  await expect(card("Project")).toBeVisible()
  await expect(hub).not.toContainText(/secret-(url|header|command|argument|environment)/)
  expect(await hub.locator("input").count()).toBe(0)
  expect(await page.evaluate(() => window.connections.actions())).toEqual([])
  expect(
    await page.evaluate(() =>
      window.connections.messages().filter((item) => /mcp|discover|auth|connect/i.test(item.type)),
    ),
  ).toEqual([])
  await expect(card("Global")).toContainText("Last reported transport status: connected")
  await expect(card("Global")).toContainText("Paused")
  await card("Global").getByRole("button", { name: "Disconnect", exact: true }).click()
  for (const name of ["System", "Ambiguous"]) {
    await expect(card(name).getByRole("button", { name: "Configure", exact: true })).toBeDisabled()
    await expect(card(name).getByRole("button", { name: "Remove", exact: true })).toBeDisabled()
    await expect(card(name).getByRole("button", { name: "Pause configuration", exact: true })).toBeDisabled()
  }
  await card("Project").getByRole("button", { name: "Sign in", exact: true }).click()
  await card("Project").getByRole("button", { name: "Connect", exact: true }).click()
  expect(await page.evaluate(() => window.connections.actions())).toEqual([
    { type: "disconnect", name: "Global", directory: "C:/fixture/workspace" },
    { type: "authenticate", name: "Project", directory: "C:/fixture/workspace" },
    { type: "connect", name: "Project", directory: "C:/fixture/workspace" },
  ])
  expect(
    await page.evaluate(() => window.connections.messages().filter((item) => item.type === "updateConfig")),
  ).toEqual([])
  await card("Project").getByRole("button", { name: "Pause configuration", exact: true }).click()
  await expect(card("Project").getByRole("button", { name: "Connect", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Save fixture settings" }).click()
  expect(
    await page.evaluate(() =>
      window.connections
        .messages()
        .filter((item) => item.type === "updateConfig")
        .map((item) => ({ config: item.config, project: item.projectConfig })),
    ),
  ).toEqual([{ config: {}, project: { mcp: { Project: { enabled: false } } } }])

  await page.reload()
  await expect(card("Global")).toBeVisible()
  await card("Global").getByRole("button", { name: "Enable configuration", exact: true }).click()
  await page.getByRole("button", { name: "Save fixture settings" }).click()
  expect(
    await page.evaluate(() =>
      window.connections
        .messages()
        .filter((item) => item.type === "updateConfig")
        .map((item) => ({ config: item.config, project: item.projectConfig })),
    ),
  ).toEqual([{ config: { mcp: { Global: { enabled: true } } }, project: {} }])

  await page.reload()
  await card("Project").getByRole("button", { name: "Configure", exact: true }).click()
  const command = hub.getByRole("textbox").first()
  await expect(command).toHaveValue("secret-command")
  await command.fill("new-command")
  await expect(command).toHaveValue("new-command")
  for (const key of ["FIRST", "SECOND"]) {
    await hub.getByPlaceholder("KEY", { exact: true }).fill(key)
    await hub.getByPlaceholder("value", { exact: true }).fill(key.toLowerCase())
    await hub.getByRole("button", { name: "Add", exact: true }).click()
  }
  await expect(hub).toContainText("FIRST=first")
  await expect(hub).toContainText("SECOND=second")
  await page.getByRole("button", { name: "Save fixture settings" }).click()
  expect(
    await page.evaluate(() =>
      window.connections
        .messages()
        .filter((item) => item.type === "updateConfig")
        .map((item) => ({ config: item.config, project: item.projectConfig })),
    ),
  ).toEqual([
    {
      config: {},
      project: {
        mcp: {
          Project: {
            command: ["new-command", "secret-argument"],
            environment: { TOKEN: "secret-environment", FIRST: "first", SECOND: "second" },
          },
        },
      },
    },
  ])

  await page.reload()
  await card("Project").getByRole("button", { name: "Remove", exact: true }).click()
  expect(await page.evaluate(() => window.connections.actions())).toEqual([])
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click()
  expect(await page.evaluate(() => window.connections.actions())).toEqual([
    { type: "remove", name: "Project", directory: "C:/fixture/workspace" },
  ])
  await page.evaluate(() => window.connections.offline())
  await expect(card("Project").getByRole("button", { name: "Configure", exact: true })).toBeDisabled()
  await expect(card("Project").getByRole("button", { name: "Connect", exact: true })).toBeDisabled()
  await expect(card("Project").getByRole("button", { name: "Sign in", exact: true })).toBeDisabled()
})
