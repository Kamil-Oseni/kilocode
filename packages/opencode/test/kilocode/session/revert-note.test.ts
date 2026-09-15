import { afterEach, describe, expect, test } from "bun:test"
import { RayaRevertNote } from "@/kilocode/session/revert-note"

const ids: string[] = []
const sid = () => {
  const id = `ses_revert_note_${crypto.randomUUID()}`
  ids.push(id)
  return id
}

afterEach(async () => {
  for (const id of ids) await RayaRevertNote.take(id)
  ids.length = 0
})

describe("RayaRevertNote", () => {
  test("reminder lists restored files and tells the model to re-read", () => {
    const text = RayaRevertNote.reminder(["C:/Users/User/Desktop/dummy/drawing-canvas.html"])
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("drawing-canvas.html")
    expect(text).toContain("Re-read a file before acting on it")
    expect(text).toContain("actually re-apply it")
  })

  test("reminder is empty when nothing was undone", () => {
    expect(RayaRevertNote.reminder(undefined)).toBeUndefined()
    expect(RayaRevertNote.reminder([])).toBeUndefined()
  })

  test("record then take returns the files once", async () => {
    const id = sid()
    await RayaRevertNote.record(id, ["C:/tmp/a.txt", "C:/tmp/b.txt"])
    expect(await RayaRevertNote.take(id)).toEqual(["C:/tmp/a.txt", "C:/tmp/b.txt"])
    expect(await RayaRevertNote.take(id)).toBeUndefined()
  })

  test("survives an in-process cache drop the way a backend restart would", async () => {
    const id = sid()
    await RayaRevertNote.record(id, ["/Users/User/Desktop/dummy/drawing-canvas.html"])
    RayaRevertNote.dropCache()
    const noted = await RayaRevertNote.take(id)
    expect(noted?.some((file) => file.endsWith("drawing-canvas.html"))).toBe(true)
    expect(RayaRevertNote.reminder(noted)).toContain("restored to their state before your edits")
  })

  test("serializes concurrent records without losing restored paths", async () => {
    const id = sid()
    const files = Array.from({ length: 12 }, (_, index) => `C:/tmp/${index}.txt`)
    await Promise.all(files.map((file) => RayaRevertNote.record(id, [file])))
    expect(new Set(await RayaRevertNote.take(id))).toEqual(new Set(files))
  })
})
