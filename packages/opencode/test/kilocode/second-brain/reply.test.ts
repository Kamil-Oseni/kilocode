import { expect, test } from "bun:test"
import { Schema } from "effect"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { Request, Result } from "@/kilocode/second-brain/protocol"
import { valid } from "@/kilocode/second-brain/reply"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-passages-"))
  const file = path.join(root, "Preferences", "Raya.md")
  const text = [
    "# Voice",
    "Chosen speech: Chatterbox-Nano; fallback: Kokoro Onyx.",
    "",
    "# Pace",
    "Keep the saved selected pace; no exact numeric pace is recorded here.",
    "",
    "# Interruptions",
    "Requested turn-taking without automatic interruption.",
    "",
  ].join("\n")
  await mkdir(path.dirname(file))
  await writeFile(file, text)
  const raw = await readFile(file)
  const sha = createHash("sha256").update(raw).digest("hex")
  const lines = raw.toString("utf8").split("\n")
  const sources = [
    [1, 2],
    [4, 5],
    [7, 8],
  ].map(([line, end]) => ({
    path: file,
    relative: "Preferences/Raya.md",
    line,
    end_line: end,
    heading: lines[line - 1].slice(2),
    text: lines.slice(line - 1, end).join("\n"),
    source_sha256: sha,
    depth: 0,
    tokens: 20,
    truncated: false,
  }))
  const request = Schema.decodeUnknownSync(Request)({
    id: "original",
    sessionID: "ses_original",
    project: root,
    command: { action: "context", query: "voice pace interruptions", budget: 6000 },
  })
  const result = {
    action: "context",
    project: root,
    root,
    context: { sources, diagnostics: [], tokens: 60, truncated: false, capture_enabled: false },
  }
  return {
    root,
    request,
    result,
    close: async () => {
      expect(path.dirname(root)).toBe(os.tmpdir())
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("production reply decoder admits disjoint cited facets from one unchanged physical note", async () => {
  const original = await fixture()
  try {
    const decoded = Schema.decodeUnknownSync(Result)(original.result)
    expect(valid(original.request, decoded)).toBe(true)
    expect(original.result.context.sources.map((row) => row.text)).toEqual([
      "# Voice\nChosen speech: Chatterbox-Nano; fallback: Kokoro Onyx.",
      "# Pace\nKeep the saved selected pace; no exact numeric pace is recorded here.",
      "# Interruptions\nRequested turn-taking without automatic interruption.",
    ])
    expect(
      valid(
        original.request,
        Schema.decodeUnknownSync(Result)({
          ...original.result,
          context: { ...original.result.context, sources: [...original.result.context.sources].reverse() },
        }),
      ),
    ).toBe(true)
  } finally {
    await original.close()
  }
})

test("same-note passages refuse duplicate, overlapping, aliased or differently revised authority", async () => {
  const original = await fixture()
  try {
    const [first, second] = original.result.context.sources
    for (const row of [
      first,
      { ...second, line: first.end_line },
      { ...second, line: first.line, end_line: first.end_line + 1 },
      { ...second, source_sha256: "b".repeat(64) },
      { ...second, relative: "preferences/Raya.md", path: path.join(original.root, "preferences", "Raya.md") },
      {
        ...second,
        path: path.join(original.root, "Preferences", ".", "Raya.md") + path.sep + ".." + path.sep + "Raya.md",
      },
    ]) {
      const value = { ...original.result, context: { ...original.result.context, sources: [first, row], tokens: 40 } }
      expect(valid(original.request, Schema.decodeUnknownSync(Result)(value))).toBe(false)
    }
  } finally {
    await original.close()
  }
})

test("diverse passages retain per-note, global, row-count and privacy limits", async () => {
  const original = await fixture()
  try {
    const [first, second] = original.result.context.sources
    const result = (sources: typeof original.result.context.sources) => ({
      ...original.result,
      context: { ...original.result.context, sources, tokens: sources.reduce((sum, row) => sum + row.tokens, 0) },
    })
    const full = result([
      { ...first, tokens: 1000 },
      { ...second, tokens: 1000 },
    ])
    expect(valid(original.request, Schema.decodeUnknownSync(Result)(full))).toBe(true)
    expect(
      valid(
        original.request,
        Schema.decodeUnknownSync(Result)(
          result([
            { ...first, tokens: 1000 },
            { ...second, tokens: 1001 },
          ]),
        ),
      ),
    ).toBe(false)
    expect(
      valid(
        { ...original.request, command: { action: "context", query: "voice", budget: 1999 } },
        Schema.decodeUnknownSync(Result)(full),
      ),
    ).toBe(false)
    expect(
      Schema.is(Result)(
        result(
          Array.from({ length: 13 }, (_, index) => ({
            ...first,
            line: index * 3 + 1,
            end_line: index * 3 + 2,
          })),
        ),
      ),
    ).toBe(false)
    expect(
      valid(
        original.request,
        Schema.decodeUnknownSync(Result)(
          result([{ ...first, relative: "Private/Raya.md", path: path.join(original.root, "Private", "Raya.md") }]),
        ),
      ),
    ).toBe(false)
  } finally {
    await original.close()
  }
})
