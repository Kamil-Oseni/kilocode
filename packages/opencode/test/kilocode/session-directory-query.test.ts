import { expect, test } from "bun:test"
import { directoryQuery, globalPath } from "../../src/kilocode/session/directory-query"

test("global directory queries recognize legacy absolute and volume-relative representations without drive mixing", () => {
  const project = { id: "global", worktree: "/" }
  for (const directory of ["D:/workspace/nested", "E:/workspace/nested", "/workspace/nested"])
    for (const query of [directory, globalPath(directory)])
      expect(directoryQuery({ directory, path: query, roots: true }, project)).toEqual({
        directory,
        path: undefined,
        roots: true,
      })
  const input = { directory: "D:/workspace/nested", path: "E:/workspace/nested" }
  expect(directoryQuery(input, project)).toBe(input)
  for (const input of [
    { directory: "D:/workspace/nested", path: "workspace" },
    { directory: "D:/workspace/nested", path: "unrelated" },
    { directory: "D:/workspace/nested", path: "workspace/nested", scope: "project" as const },
  ])
    expect(directoryQuery(input, project)).toBe(input)
  expect(directoryQuery(input, { id: "git", worktree: "D:/workspace" })).toBe(input)
  expect(directoryQuery(input, { id: "global", worktree: "D:/" })).toBe(input)
})
