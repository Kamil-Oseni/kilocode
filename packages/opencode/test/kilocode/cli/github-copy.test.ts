import { describe, expect, test } from "bun:test"
import path from "path"
import { GitHubCopy } from "@/kilocode/cli/github-copy"

const root = path.join(__dirname, "..", "..", "..", "src", "cli", "cmd")

describe("GitHub action public copy", () => {
  test("presents the active assistant as Raya while the GitHub integration runs", async () => {
    const handler = await Bun.file(path.join(root, "github.handler.ts")).text()

    expect(GitHubCopy.sending).toBe("Sending message to Raya...")
    expect(GitHubCopy.sending).not.toMatch(/Kilo|OpenCode/i)
    expect(handler).toContain("console.log(GitHubCopy.sending)")
    expect(handler).not.toContain('console.log("Sending message to kilo...")')
  })
})
