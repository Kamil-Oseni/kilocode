import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: ["memory-preview.browser.ts", "routines-preview.browser.ts"],
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5199",
    browserName: "chromium",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run preview",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
