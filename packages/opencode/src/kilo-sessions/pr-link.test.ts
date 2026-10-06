import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { detectPrLink, overrideKey, parsePrUrl } from "@/kilo-sessions/pr-link"
import { Instance } from "@/kilocode/instance"
import type { InstanceContext } from "@/project/instance-context"

function restoreWorktree<T>(worktree: string, fn: () => T): T {
  const ctx = {} as InstanceContext
  ctx.worktree = worktree
  ctx.directory = worktree
  return Instance.restore(ctx, fn)
}

describe("parsePrUrl", () => {
  test("GitHub pull", () => {
    const link = parsePrUrl("https://github.com/owner/repo/pull/123")
    expect(link).toEqual({ platform: "github", prUrl: "https://github.com/owner/repo/pull/123", prNumber: 123 })
  })

  test("GitHub pull with /files subpath", () => {
    const link = parsePrUrl("https://github.com/owner/repo/pull/123/files")
    expect(link).toEqual({ platform: "github", prUrl: "https://github.com/owner/repo/pull/123/files", prNumber: 123 })
  })

  test("GitHub pull with /commits subpath", () => {
    const link = parsePrUrl("https://github.com/owner/repo/pull/123/commits")
    expect(link).toEqual({ platform: "github", prUrl: "https://github.com/owner/repo/pull/123/commits", prNumber: 123 })
  })

  test("GitHub pull with query", () => {
    const link = parsePrUrl("https://github.com/owner/repo/pull/123?diff=split")
    expect(link).toEqual({ platform: "github", prUrl: "https://github.com/owner/repo/pull/123", prNumber: 123 })
  })

  test("GitHub pull with hash", () => {
    const link = parsePrUrl("https://github.com/owner/repo/pull/123#discussion_r1")
    expect(link).toEqual({ platform: "github", prUrl: "https://github.com/owner/repo/pull/123", prNumber: 123 })
  })

  test("GitHub pull on www host", () => {
    const link = parsePrUrl("https://www.github.com/owner/repo/pull/123")
    expect(link).toEqual({ platform: "github", prUrl: "https://www.github.com/owner/repo/pull/123", prNumber: 123 })
  })

  test("GitLab merge_requests", () => {
    const link = parsePrUrl("https://gitlab.com/group/proj/merge_requests/45")
    expect(link).toEqual({ platform: "gitlab", prUrl: "https://gitlab.com/group/proj/merge_requests/45", prNumber: 45 })
  })

  test("GitLab /-/merge_requests", () => {
    const link = parsePrUrl("https://gitlab.com/group/proj/-/merge_requests/45")
    expect(link).toEqual({
      platform: "gitlab",
      prUrl: "https://gitlab.com/group/proj/-/merge_requests/45",
      prNumber: 45,
    })
  })

  test("generic /pull/N", () => {
    const link = parsePrUrl("https://example.com/pull/7")
    expect(link).toEqual({ platform: "example", prUrl: "https://example.com/pull/7", prNumber: 7 })
  })

  test("generic /pull-requests/N", () => {
    const link = parsePrUrl("https://bitbucket.org/team/repo/pull-requests/9")
    expect(link).toEqual({
      platform: "bitbucket",
      prUrl: "https://bitbucket.org/team/repo/pull-requests/9",
      prNumber: 9,
    })
  })

  test("invalid", () => {
    expect(parsePrUrl("not a url")).toBeUndefined()
    expect(parsePrUrl("https://github.com/owner/repo/issues/1")).toBeUndefined()
    expect(parsePrUrl("https://github.com/owner/repo/pull/abc")).toBeUndefined()
    expect(parsePrUrl("ftp://github.com/owner/repo/pull/1")).toBeUndefined()
  })

  test("rejects non-positive PR number", () => {
    expect(parsePrUrl("https://github.com/owner/repo/pull/0")).toBeUndefined()
    expect(parsePrUrl("https://gitlab.com/group/proj/merge_requests/0")).toBeUndefined()
  })
})

describe("overrideKey", () => {
  test("encodes a Windows worktree into a single path segment", () => {
    const key = overrideKey("C:\\Users\\igor\\Projects\\foo")
    expect(key).toEqual(["session_pr_link", "C%3A%5CUsers%5Cigor%5CProjects%5Cfoo"])
    expect(key[1]).not.toContain(":")
    expect(key[1]).not.toContain("\\")
    expect(key[1]).not.toContain("/")
  })

  test("encodes a POSIX worktree into a single path segment", () => {
    const key = overrideKey("/Users/igor/Projects/foo")
    expect(key).toEqual(["session_pr_link", "%2FUsers%2Figor%2FProjects%2Ffoo"])
    expect(key[1]).not.toContain(":")
    expect(key[1]).not.toContain("/")
  })
})

describe("detectPrLink", () => {
  async function fixture(
    text: string,
    code: number,
    run: (dir: string, receipt: string) => Promise<void>,
    opts: { repository?: boolean; executable?: boolean } = {},
  ) {
    const dir = await mkdtemp(path.join(tmpdir(), "raya-pr-link-"))
    const bin = path.join(dir, "bin")
    const receipt = path.join(dir, "invocation.txt")
    await mkdir(bin)
    if (opts.repository !== false) {
      const git = Bun.spawnSync(["git", "init", dir], { windowsHide: true, stdout: "pipe", stderr: "pipe" })
      expect(git.exitCode).toBe(0)
    }
    if (opts.executable !== false) {
      const windows = process.platform === "win32"
      await writeFile(
        path.join(bin, windows ? "gh.cmd" : "gh"),
        windows
          ? `@echo off\r\necho %*> "${receipt}"\r\necho ${text}\r\nexit /b ${code}\r\n`
          : `#!/bin/sh\nprintf '%s\\n' "$*" > '${receipt}'\nprintf '%s\\n' '${text}'\nexit ${code}\n`,
        { mode: 0o755 },
      )
    }
    const prior = process.env.PATH
    const vars = Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_"))
    for (const [key] of vars) delete process.env[key]
    process.env.PATH = bin
    try {
      await run(dir, receipt)
    } finally {
      if (prior === undefined) delete process.env.PATH
      if (prior !== undefined) process.env.PATH = prior
      for (const [key, value] of vars) process.env[key] = value
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("detects a PR from gh", async () => {
    await fixture(JSON.stringify({ url: "https://github.com/owner/repo/pull/123" }), 0, async (dir, receipt) => {
      const link = await restoreWorktree(dir, () => detectPrLink())
      expect(link).toEqual({ platform: "github", prUrl: "https://github.com/owner/repo/pull/123", prNumber: 123 })
      expect((await readFile(receipt, "utf8")).trim()).toBe(
        process.platform === "win32" ? '"pr" "view" "--json" "url"' : "pr view --json url",
      )
      expect(await restoreWorktree(dir, () => detectPrLink())).toEqual(link)
    })
  })

  test("returns undefined when gh is missing", async () => {
    await fixture(
      "",
      0,
      async (dir, receipt) => {
        expect(await restoreWorktree(dir, () => detectPrLink())).toBeUndefined()
        expect(await Bun.file(receipt).exists()).toBe(false)
      },
      { executable: false },
    )
  })

  test("returns undefined when there is no PR", async () => {
    await fixture("", 1, async (dir) => {
      expect(await restoreWorktree(dir, () => detectPrLink())).toBeUndefined()
    })
  })

  test("returns undefined on bad JSON", async () => {
    await fixture("not json", 0, async (dir) => {
      expect(await restoreWorktree(dir, () => detectPrLink())).toBeUndefined()
    })
  })

  test("does not launch available gh outside a repository", async () => {
    await fixture(
      JSON.stringify({ url: "https://github.com/owner/repo/pull/123" }),
      0,
      async (dir, receipt) => {
        expect(await restoreWorktree(dir, () => detectPrLink())).toBeUndefined()
        expect(await Bun.file(receipt).exists()).toBe(false)
      },
      { repository: false },
    )
  })
})
