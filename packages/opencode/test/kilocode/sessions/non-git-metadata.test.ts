import { expect, test } from "bun:test"
import simpleGit from "simple-git"
import { withInFlightCache } from "../../../src/kilo-sessions/inflight-cache"
import { Instance } from "../../../src/kilocode/instance"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"

// Execute current production bodies with the real cache, Instance and Git client.
// The factory records construction without replacing Git results.
const source = await Bun.file(new URL("../../../src/kilo-sessions/kilo-sessions.ts", import.meta.url)).text()
const start = source.indexOf("  function normalizeGitUrl(")
const end = source.indexOf("\n  async function branch()", start)
expect(start).toBeGreaterThan(0)
expect(end).toBeGreaterThan(start)
const body = source
  .slice(start, end)
  .replaceAll(": string | undefined", "")
  .replaceAll("raw: string", "raw")
  .replaceAll(": Promise<string | undefined>", "")

function lookup(calls: string[]) {
  return new Function(
    "Instance",
    "withInFlightCache",
    "simpleGit",
    "gitUrlKeyPrefix",
    "ttlMs",
    `${body}; return getGitUrl`,
  )(
    Instance,
    withInFlightCache,
    (dir: string) => {
      calls.push(dir)
      return simpleGit(dir)
    },
    "non-git-metadata-test:",
    10_000,
  ) as () => Promise<string | undefined>
}

test("non-Git metadata skips repeated real remote lookups", async () => {
  await using dir = await tmpdir()
  await provideTestInstance({
    directory: dir.path,
    fn: async (ctx) => {
      await Instance.restore(ctx, async () => {
        expect(Instance.project.vcs).toBeUndefined()
        const calls: string[] = []
        const read = lookup(calls)
        expect(await read()).toBeUndefined()
        expect(await read()).toBeUndefined()
        expect(calls).toHaveLength(0)
      })
    },
  })
}, 30000)

test("Git metadata preserves real remote discovery and cache reuse", async () => {
  await using dir = await tmpdir({ git: true })
  await simpleGit(dir.path).addRemote("origin", "https://example.com/team/project.git")
  await provideTestInstance({
    directory: dir.path,
    fn: async (ctx) => {
      await Instance.restore(ctx, async () => {
        expect(Instance.project.vcs).toBe("git")
        const calls: string[] = []
        const read = lookup(calls)
        expect(await read()).toBe("https://example.com/team/project.git")
        expect(await read()).toBe("https://example.com/team/project.git")
        expect(calls).toEqual([Instance.worktree])
      })
    },
  })
}, 30000)
