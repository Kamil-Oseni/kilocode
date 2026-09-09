import { expect, test } from "bun:test"
import { compare, eligible } from "../../src/services/update-version"

test("orders prerelease identifiers according to SemVer precedence", () => {
  const versions = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ]
  for (let index = 1; index < versions.length; index++) {
    expect(compare(versions[index]!, versions[index - 1]!)).toBeGreaterThan(0)
    expect(compare(versions[index - 1]!, versions[index]!)).toBeLessThan(0)
  }
  expect(compare("raya-v1.0.0+build.1", "1.0.0+build.2")).toBe(0)
  expect(compare("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992")).toBe(1)
  expect(compare("1.0.0-B", "1.0.0-a")).toBe(-1)
})

test("rejects unrelated tags, malformed versions, and prereleases outside the selected channel", () => {
  const release = { tag_name: "raya-v1.2.3", draft: false, prerelease: false }
  expect(eligible(release, false)).toBe(true)
  for (const tag_name of [
    "v1.2.3",
    "other-v9.9.9",
    "1.2.3",
    "raya-v01.2.3",
    "raya-v1.2.3-01",
    "raya-v1.2.3-",
    "raya-v1.2.3+",
    "raya-v1.2.3 extra",
  ]) {
    expect(eligible({ ...release, tag_name }, true)).toBe(false)
  }
  expect(eligible({ ...release, tag_name: "raya-v1.2.3-beta.1" }, false)).toBe(false)
  expect(eligible({ ...release, tag_name: "raya-v1.2.3-beta.1" }, true)).toBe(true)
  expect(eligible({ ...release, prerelease: true }, false)).toBe(false)
  expect(eligible({ ...release, draft: true }, true)).toBe(false)
  expect(() => compare("not-a-version", "1.2.3")).toThrow("invalid")
})
