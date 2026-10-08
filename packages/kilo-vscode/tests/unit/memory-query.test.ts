import { expect, test } from "bun:test"
import { setup } from "../../src/shared/memory-query"

test("whole setup paths are distinguished from questions mentioning paths", () => {
  for (const value of [
    "D:\\Raya\\Services\\Memory\\setup.json",
    '"D:/Raya/Services/Memory/managed-launch.json"',
    "setup.json",
    "../managed-launch.json",
    "file:///D:/Raya/setup.json",
    "\\\\computer\\notes\\setup.json",
    "/home/user/notes/setup.json",
    "C:\\Notes",
  ])
    expect(setup(value), value).toBe(true)
  for (const value of [
    "Where is my passport?",
    "What is saved in C:\\Notes?",
    "Why does setup.json fail?",
    "voice fallback",
  ])
    expect(setup(value), value).toBe(false)
})
