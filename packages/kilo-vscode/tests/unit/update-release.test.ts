import { expect, test } from "bun:test"
import { latest, read, repository, scan } from "../../src/services/update-release"

test("selects the newest eligible release and derives its link from the configured repository", () => {
  const base = { draft: false, prerelease: false, assets: [], html_url: "https://untrusted.example/redirect" }
  const releases = ["raya-v1.0.0", "raya-v1.1.0-beta.2", "raya-v1.1.0-beta.11", "unrelated-v9.9.9"].map((tag_name) => ({
    ...base,
    tag_name,
  }))
  expect(latest(releases, "Owner/Raya", false)?.tag_name).toBe("raya-v1.0.0")
  expect(latest(releases, "Owner/Raya", true)).toMatchObject({
    tag_name: "raya-v1.1.0-beta.11",
    html_url: "https://github.com/Owner/Raya/releases/tag/raya-v1.1.0-beta.11",
  })
  expect(latest([], "Owner/Raya", false)).toBeUndefined()
})

test("rejects malformed release records and ambiguous repository paths", () => {
  const release = { tag_name: "raya-v1.0.0", draft: false, prerelease: false, assets: [] }
  for (const value of [
    null,
    {},
    [null],
    [{ ...release, draft: "false" }],
    [{ ...release, prerelease: undefined }],
    [{ ...release, assets: {} }],
  ])
    expect(() => latest(value, "owner/raya", false)).toThrow("invalid Raya release list")
  for (const repo of [
    "owner/raya/extra",
    "../raya",
    "owner/..",
    "https://github.com/owner/raya",
    "owner/raya?redirect=evil",
    "owner%2Fraya",
  ])
    expect(() => repository(repo)).toThrow("owner/name")
})

test("bounds release metadata and hides invalid response contents in parsing errors", async () => {
  expect(await read(new Response("[]"))).toEqual([])
  await expect(read(new Response("sensitive response contents"))).rejects.toThrow(
    "GitHub returned invalid release JSON.",
  )
  let canceled = false
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
      },
      cancel() {
        canceled = true
      },
    }),
  )
  await expect(read(response)).rejects.toThrow("8 MiB limit")
  expect(canceled).toBe(true)
})

test("finds an eligible update beyond the first page without trusting supplied next links", async () => {
  const release = { tag_name: "unrelated-v9.0.0", draft: false, prerelease: false, assets: [] }
  const urls: string[] = []
  const result = await scan("owner/raya", false, async (url) => {
    urls.push(url)
    return Response.json(
      urls.length === 1 ? Array.from({ length: 100 }, () => release) : [{ ...release, tag_name: "raya-v1.2.3" }],
      {
        headers: { link: '<https://untrusted.example/next>; rel="next"' },
      },
    )
  })
  expect(result?.tag_name).toBe("raya-v1.2.3")
  expect(urls).toEqual([
    "https://api.github.com/repos/owner/raya/releases?per_page=100&page=1",
    "https://api.github.com/repos/owner/raya/releases?per_page=100&page=2",
  ])
})

test("an incomplete paginated search cannot report an available update or up-to-date state", async () => {
  let calls = 0
  await expect(
    scan("owner/raya", false, async () => {
      calls++
      return Response.json(
        Array.from({ length: 100 }, () => ({ tag_name: "raya-v1.2.3", draft: false, prerelease: false, assets: [] })),
      )
    }),
  ).rejects.toThrow("eligibility is incomplete")
  expect(calls).toBe(10)
  calls = 0
  await expect(
    scan("owner/raya", false, async () => {
      if (++calls === 2) return new Response(null, { status: 401 })
      return Response.json(
        Array.from({ length: 100 }, () => ({ tag_name: "raya-v1.2.3", draft: false, prerelease: false, assets: [] })),
      )
    }),
  ).rejects.toThrow("HTTP 401")
})
