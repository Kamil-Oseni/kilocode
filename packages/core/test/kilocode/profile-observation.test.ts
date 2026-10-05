import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseObservation, validateObservation } from "../../src/kilocode/profile-observation"

function observation(roots: { kind: "json" | "sqlite"; path: string }[]) {
  return {
    format: "raya.profile-root-observation",
    version: 1,
    roots,
    inventory: createHash("sha256")
      .update(
        JSON.stringify(
          roots.map((root) => ({ ...root, path: process.platform === "win32" ? root.path.toLowerCase() : root.path })),
        ),
      )
      .digest("hex"),
    observation: roots.length ? "participating-roots" : "no-participating-roots",
    processLocal: true,
    participantOnly: true,
    cooperativeOnly: true,
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    portable: false,
  }
}

test("profile observation accepts immutable canonical metadata including nonexistent leaves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-observation-"))
  const raw = observation([
    { kind: "json", path: root },
    { kind: "sqlite", path: path.join(root, "unused.db") },
  ])
  const value = await validateObservation(raw)
  expect(value).toMatchObject({ completeProfileCoverage: false, portableCaptureAuthorized: false })
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.roots[0])).toBe(true)
  expect(parseObservation(observation([])).observation).toBe("no-participating-roots")
})

test("profile observation rejects malformed, duplicate, unordered, relative and global-zero metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-observation-"))
  const roots = [
    { kind: "json" as const, path: root },
    { kind: "sqlite" as const, path: path.join(root, "data.db") },
  ]
  expect(() => parseObservation(observation([roots[0]!, roots[0]!]))).toThrow("ordered and distinct")
  expect(() => parseObservation(observation([...roots].reverse()))).toThrow("ordered and distinct")
  expect(() => parseObservation(observation([{ kind: "json", path: "relative" }]))).toThrow("absolute and normalized")
  expect(() => parseObservation(observation([{ kind: "json", path: `${root}${path.sep}child${path.sep}..` }]))).toThrow(
    "absolute and normalized",
  )
  expect(() => parseObservation({ ...observation(roots), inventory: "0".repeat(64) })).toThrow("fingerprint changed")
  expect(() => parseObservation({ ...observation(roots), nativeOwners: 0 })).toThrow()
  expect(() => parseObservation({ ...observation(roots), completeProfileCoverage: true })).toThrow()
  expect(() => parseObservation({ ...observation(roots), processLocal: undefined })).toThrow()
  expect(() => parseObservation({ ...observation(roots), observation: "no-participating-roots" })).toThrow(
    "root count changed",
  )
})

test("profile observation refuses an actual directory identity replaced by a junction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-observation-"))
  const selected = path.join(root, "selected")
  const target = path.join(root, "target")
  await Promise.all([mkdir(selected), mkdir(target)])
  const raw = observation([{ kind: "json", path: selected }])
  await validateObservation(raw)
  await rename(selected, path.join(root, "previous"))
  await symlink(target, selected, process.platform === "win32" ? "junction" : "dir")
  await expect(validateObservation(raw)).rejects.toThrow("canonical root identity changed")
})
