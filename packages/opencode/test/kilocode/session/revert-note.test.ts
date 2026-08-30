import { afterEach, describe, expect, test } from "bun:test"
import { RayaRevertNote } from "@/kilocode/session/revert-note"

const ids: string[] = []
const sid = () => {
  const id = `ses_revert_note_${crypto.randomUUID()}`
  ids.push(id)
  return id
}

afterEach(() => {
  for (const id of ids) RayaRevertNote.take(id)
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

  test("record then take returns the files once", () => {
    const id = sid()
    RayaRevertNote.record(id, ["C:/tmp/a.txt", "C:/tmp/b.txt"])
    expect(RayaRevertNote.take(id)).toEqual(["C:/tmp/a.txt", "C:/tmp/b.txt"])
    expect(RayaRevertNote.take(id)).toBeUndefined()
  })

  test("survives an in-process cache drop the way a backend restart would", () => {
    const id = sid()
    RayaRevertNote.record(id, ["/Users/User/Desktop/dummy/drawing-canvas.html"])
    RayaRevertNote.dropCache()
    const noted = RayaRevertNote.take(id)
    expect(noted?.some((file) => file.endsWith("drawing-canvas.html"))).toBe(true)
    expect(RayaRevertNote.reminder(noted)).toContain("restored to their state before your edits")
  })
})
