import { afterEach, describe, expect, test } from "bun:test"
import { editReview } from "../../webview-ui/src/components/chat/edit-review"

afterEach(() => {
  editReview.reset("a")
  editReview.reset("b")
})

describe("chat file review state", () => {
  test("a fresh webview hydrates only matching persisted acceptance and honors revocation", () => {
    editReview.update("a", { "a.ts": "v1", "b.ts": "v2" }, {}, false, { "a.ts": "v1", "b.ts": "stale" })
    expect(editReview.isKept("a", "a.ts")).toBe(true)
    expect(editReview.isKept("a", "b.ts")).toBe(false)
    editReview.update("a", { "a.ts": "v1", "b.ts": "v2" }, {}, false, {})
    expect(editReview.isKept("a", "a.ts")).toBe(false)
  })

  test("Keep all covers files before their transcript nodes mount", () => {
    editReview.update("a", { "first.ts": "v1", "late.ts": "v2" })
    editReview.keepAll("a")
    const remove = editReview.register({ session: "a", file: "late.ts", el: {} as HTMLElement })
    expect(editReview.isKept("a", "late.ts")).toBe(true)
    expect(editReview.pending("a")).toEqual([])
    remove()
    expect(editReview.isKept("b", "late.ts")).toBe(false)
  })

  test("a new file revision reopens only that file and rejects stale acknowledgements", () => {
    editReview.update("a", { "first.ts": "v1", "other.ts": "v2" })
    editReview.keepAll("a")
    editReview.update("a", { "first.ts": "v3", "other.ts": "v2" })
    expect(editReview.isKept("a", "first.ts")).toBe(false)
    expect(editReview.isKept("a", "other.ts")).toBe(true)
    editReview.keep("a", "first.ts", "v1")
    expect(editReview.isKept("a", "first.ts")).toBe(false)
    editReview.keep("a", "first.ts", "v3")
    expect(editReview.isKept("a", "first.ts")).toBe(true)
  })

  test("host path aliases select an exact file without matching another directory", () => {
    editReview.update("a", { "src/a.ts": "v1", "other/a.ts": "v2" }, { "C:\\Repo\\src\\a.ts": "src/a.ts" }, true)
    expect(editReview.select("a", "c:/repo/src/a.ts")).toEqual({ file: "src/a.ts", expected: { "src/a.ts": "v1" } })
    expect(editReview.select("a", "a.ts")).toBeUndefined()
    editReview.keep("a", "C:/REPO/src/a.ts", "v1")
    expect(editReview.isKept("a", "src/a.ts")).toBe(true)
    expect(editReview.isKept("a", "other/a.ts")).toBe(false)
  })

  test("inline actions request persistence and leave controls pending until acknowledged", () => {
    editReview.update("a", { "a.ts": "v1" })
    const calls: string[] = []
    const off = editReview.connect("a", {
      request: (action, file) => calls.push(`${action}:${file}`),
      busy: () => false,
    })
    expect(editReview.busy("a")).toBe(false)
    editReview.request("a", "a.ts", "keep")
    editReview.request("a", "a.ts", "undo")
    expect(calls).toEqual(["keep:a.ts", "undo:a.ts"])
    expect(editReview.isKept("a", "a.ts")).toBe(false)
    off()
    expect(editReview.busy("a")).toBe(true)
  })
})
