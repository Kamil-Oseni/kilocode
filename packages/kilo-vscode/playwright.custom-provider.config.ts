import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests",
  testMatch: "custom-provider.browser.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5206", browserName: "chromium", reducedMotion: "reduce" },
  webServer: {
    command: "bun tests/fixtures/custom-provider-serve.cjs",
    url: "http://127.0.0.1:5206",
    reuseExistingServer: false,
    timeout: 90000,
  },
})
