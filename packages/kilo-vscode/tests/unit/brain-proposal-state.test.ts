import { expect, test } from "bun:test"
import { project, reviewed } from "../../webview-ui/src/components/settings/brain-proposal-state"

test("project comparison follows Windows separators and case without changing Unix identity", () => {
  expect(project("C:\\Work\\Raya\\")).toBe(project("c:/work/raya"))
  expect(project("/work/Raya")).not.toBe(project("/work/raya"))
  expect(project("C:/work/other")).not.toBe(project("C:/work/raya"))
})
test("invalid native proposal responses cannot create a review or enable capture", () => {
  expect(reviewed({ capture_enabled: true, proposals: [] })).toBeUndefined()
  expect(reviewed({ capture_enabled: false, proposals: "corrupt" })).toBeUndefined()
  expect(reviewed({ capture_enabled: false, proposals: [{ format: "raya.memory.proposal.v1" }] })).toBeUndefined()
  expect(reviewed({ capture_enabled: false, proposals: [] })).toEqual({ capture_enabled: false, proposals: [] })
})
