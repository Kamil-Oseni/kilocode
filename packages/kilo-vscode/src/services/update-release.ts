import { z } from "zod"
import { compare, eligible } from "./update-version"

const schema = z
  .array(
    z.object({
      tag_name: z.string().max(256),
      draft: z.boolean(),
      prerelease: z.boolean(),
      assets: z.array(z.unknown()).max(1000),
    }),
  )
  .max(100)

export function repository(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))
    throw new Error("The update repository must be owner/name.")
  return value
}

/** Bound metadata before JSON parsing and keep response contents out of diagnostics. */
export async function read(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("GitHub returned an empty release response.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 8 * 1024 * 1024) throw new Error("GitHub release metadata exceeded the 8 MiB limit.")
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    try {
      return JSON.parse(chunks.join("")) as unknown
    } catch {
      throw new Error("GitHub returned invalid release JSON.")
    }
  } finally {
    await reader.cancel().catch(() => console.warn("[Raya] Release response cleanup failed."))
  }
}

/** Derive release links from the configured repository; do not trust response-provided navigation. */
export function latest(value: unknown, repo: string, previews: boolean) {
  repository(repo)
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error("GitHub returned an invalid Raya release list.")
  const release = parsed.data
    .filter((item) => eligible(item, previews))
    .toSorted((a, b) => compare(b.tag_name, a.tag_name))[0]
  if (!release) return
  return { ...release, html_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}` }
}

/** Search a bounded release history without following server-supplied pagination URLs. */
export async function scan(repo: string, previews: boolean, request: (url: string) => Promise<Response>) {
  repository(repo)
  let best: ReturnType<typeof latest>
  for (let page = 1; page <= 10; page++) {
    const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`)
    if (!response.ok) throw new Error(`GitHub release request failed (HTTP ${response.status}).`)
    const value = await read(response)
    const candidate = latest(value, repo, previews)
    if (candidate && (!best || compare(candidate.tag_name, best.tag_name) > 0)) best = candidate
    // latest() validates the array before any result can be accepted.
    if (Array.isArray(value) && value.length < 100) return best
  }
  throw new Error(
    "The release history exceeded 1,000 entries. Check the repository's releases manually; update eligibility is incomplete.",
  )
}
