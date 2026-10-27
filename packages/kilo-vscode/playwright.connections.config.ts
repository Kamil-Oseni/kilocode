import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests",
  testMatch: "connections.browser.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5221", browserName: "chromium", channel: "msedge", reducedMotion: "reduce" },
  webServer: {
    command: "bun tests/fixtures/connections-serve.cjs",
    url: "http://127.0.0.1:5221",
    reuseExistingServer: false,
    timeout: 90000,
  },
})
