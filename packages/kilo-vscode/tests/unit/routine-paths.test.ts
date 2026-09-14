import { expect, test } from "bun:test"
import { RoutinePaths, normalizeRoutinePaths } from "../../src/shared/routine-paths"

test("routine folders reject malformed and relative grants", () => {
  expect(RoutinePaths.safeParse({ version: 1, grants: [{ path: "../private", access: "read" }] }).success).toBe(false)
  expect(RoutinePaths.safeParse({ version: 2, grants: [] }).success).toBe(false)
  expect(
    RoutinePaths.safeParse({
      version: 1,
      grants: Array.from({ length: 17 }, (_, index) => ({ path: `C:\\folder-${index}`, access: "read" })),
    }).success,
  ).toBe(false)
})

test("routine folders canonicalize duplicates and preserve narrower write access", () => {
  expect(
    normalizeRoutinePaths({
      version: 1,
      grants: [
        { path: "C:\\Records\\", access: "read" },
        { path: "c:/records", access: "write" },
        { path: "C:/Records/2025", access: "read" },
        { path: "C:/Shared", access: "read" },
        { path: "C:/Shared/Exports", access: "write" },
      ],
    }),
  ).toEqual({
    version: 1,
    grants: [
      { path: "C:/Shared", access: "read" },
      { path: "c:/records", access: "write" },
      { path: "C:/Shared/Exports", access: "write" },
    ],
  })
})
