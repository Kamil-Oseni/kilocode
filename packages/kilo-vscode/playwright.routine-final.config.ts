import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "routine-final.browser.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5212",
    browserName: "chromium",
    timezoneId: "America/Toronto",
    locale: "en-US",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/routine-final-serve.cjs",
    url: "http://127.0.0.1:5212",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
