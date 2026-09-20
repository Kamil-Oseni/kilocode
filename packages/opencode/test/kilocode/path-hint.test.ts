import { describe, expect, test } from "bun:test"
import { PathHint } from "@/kilocode/tool/path-hint"

describe("duplicate path hints", () => {
  test("removes one adjacent duplicate without changing other segments", () => {
    expect(PathHint.duplicates("C:\\Users\\Kamil\\Desktop\\Desktop\\French Study\\file.ts", "win32")).toEqual([
      "C:\\Users\\Kamil\\Desktop\\French Study\\file.ts",
    ])
    expect(PathHint.duplicates("/home/user/project/project/src/file.ts", "linux")).toEqual([
      "/home/user/project/src/file.ts",
    ])
  })

  test("does not guess across non-adjacent or unrelated names", () => {
    expect(PathHint.duplicates("C:\\Users\\Kamil\\Desktop\\French Study\\file.ts", "win32")).toEqual([])
    expect(PathHint.duplicates("/home/project/src/project/file.ts", "linux")).toEqual([])
  })
})
