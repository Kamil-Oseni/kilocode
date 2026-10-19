import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { reference, source } from "../../src/kilo-provider/memory-source"
import { memorySources, type MemorySourceRequest } from "../../src/shared/memory-source"

const base = path.resolve(import.meta.dir, "../../.tmp/memory-citation")
let dir: string
let root: string
let file: string
const text = Array.from({ length: 305 }, (_, at) => `Note line ${at + 1}`).join("\n")
const ref: MemorySourceRequest = {
  type: "openMemorySource",
  sessionID: "ses_original",
  messageID: "msg_original",
  partID: "prt_original",
  callID: "call_original",
  source: 0,
}

function result() {
  return {
    action: "context",
    root,
    project: dir,
    context: {
      sources: [
        {
          path: file,
          relative: "Preferences/Raya.md",
          line: 291,
          end_line: 305,
          heading: "Voice preference",
          text: "Note line 291",
          source_sha256: createHash("sha256").update(text).digest("hex"),
          depth: 0,
          tokens: 3,
          truncated: false,
        },
      ],
      diagnostics: [],
      tokens: 3,
      truncated: false,
      capture_enabled: false,
    },
  }
}

function message(value = result()) {
  return {
    info: { id: ref.messageID, sessionID: ref.sessionID, role: "assistant" },
    parts: [
      {
        id: ref.partID,
        messageID: ref.messageID,
        sessionID: ref.sessionID,
        callID: ref.callID,
        type: "tool",
        tool: "second_brain_recall",
        state: { status: "completed", output: JSON.stringify(value) },
      },
    ],
  }
}

beforeEach(async () => {
  await mkdir(base, { recursive: true })
  dir = await mkdtemp(path.join(base, "run-"))
  root = path.join(dir, "SecondBrain")
  file = path.join(root, "Preferences/Raya.md")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
})

afterEach(async () => {
  if (!dir.startsWith(base + path.sep)) throw new Error("Unexpected test cleanup target")
  await rm(dir, { recursive: true, force: true })
})

describe("original Memory citation", () => {
  it("resolves the real saved note at line 291, independent of the model's prose", async () => {
    const selected = await source({ message: message(), ref, root, directory: dir, current: () => true })
    expect(selected).toEqual({
      file: await import("node:fs/promises").then((fs) => fs.realpath(file)),
      line: 291,
      text,
    })
    expect(memorySources(JSON.stringify(result()))).toEqual([{ source: 0, label: "Preferences/Raya.md:291–305" }])
    expect(reference({ ...ref, filePath: file })).toBe(false)
  })

  it("refuses a note changed since the original recall", async () => {
    const original = message()
    await writeFile(file, text + "\nNew content")
    await expect(source({ message: original, ref, root, directory: dir, current: () => true })).rejects.toThrow(
      "note changed",
    )
  })

  it("refuses result, conversation, tool, call and source substitutions", async () => {
    const cases = [
      { ...ref, sessionID: "ses_other" },
      { ...ref, messageID: "msg_other" },
      { ...ref, partID: "prt_other" },
      { ...ref, callID: "call_other" },
      { ...ref, source: 1 },
    ]
    for (const selected of cases)
      await expect(
        source({ message: message(), ref: selected, root, directory: dir, current: () => true }),
      ).rejects.toThrow()
    const wrong = message()
    wrong.parts[0].tool = "read"
    await expect(source({ message: wrong, ref, root, directory: dir, current: () => true })).rejects.toThrow(
      "completed Memory recall",
    )
    const pending = message()
    pending.parts[0].state.status = "running"
    await expect(source({ message: pending, ref, root, directory: dir, current: () => true })).rejects.toThrow(
      "completed Memory recall",
    )
    const duplicate = message()
    duplicate.parts.push(duplicate.parts[0])
    await expect(source({ message: duplicate, ref, root, directory: dir, current: () => true })).rejects.toThrow()
  })

  it("refuses a different vault, project, traversal or mismatched path", async () => {
    for (const change of [{ root: dir }, { project: root }])
      await expect(
        source({ message: message({ ...result(), ...change }), ref, root, directory: dir, current: () => true }),
      ).rejects.toThrow("different Memory selection")
    for (const relative of ["../Outside.md", "Private/Note.md", "Preferences/Other.md"]) {
      const value = result()
      value.context.sources[0].relative = relative
      await expect(
        source({ message: message(value), ref, root, directory: dir, current: () => true }),
      ).rejects.toThrow()
    }
  })

  it("refuses a real junction leaving the approved vault", async () => {
    const outside = path.join(dir, "outside")
    await mkdir(outside)
    await writeFile(path.join(outside, "Note.md"), text)
    await symlink(outside, path.join(root, "escape"), "junction")
    const value = result()
    value.context.sources[0].relative = "escape/Note.md"
    value.context.sources[0].path = path.join(root, "escape/Note.md")
    await expect(source({ message: message(value), ref, root, directory: dir, current: () => true })).rejects.toThrow(
      "leaves the selected notes folder",
    )
  })

  it("does not open a result whose owner changes during filesystem work", async () => {
    let calls = 0
    await expect(
      source({ message: message(), ref, root, directory: dir, current: () => ++calls === 1 }),
    ).rejects.toThrow("unavailable conversation")
  })
})
