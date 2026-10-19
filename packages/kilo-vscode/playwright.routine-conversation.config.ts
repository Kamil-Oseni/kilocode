import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "routine-conversation.browser.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5214",
    browserName: "chromium",
    timezoneId: "America/Toronto",
    locale: "en-US",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/routine-conversation-serve.cjs",
    url: "http://127.0.0.1:5214",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
