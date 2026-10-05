import { expect, test } from "bun:test"
import { Permission } from "@/permission"
import { RayaChief } from "@/kilocode/chief"

const agents = [
  {
    name: "researcher",
    description: "Research evidence sources",
    permission: Permission.fromConfig({ "*": "deny", read: "allow" }),
  },
  { name: "general", description: "General work", permission: Permission.fromConfig({ "*": "allow" }) },
]
const request = "Research evidence and write the requested file"

test("explicit work access filters actual capabilities while omission retains routing", () => {
  expect(RayaChief.route({ request, agents }).agent).toBe("researcher")
  expect(RayaChief.route({ request, agents, access: "edit" }).agent).toBe("general")
  expect(() => RayaChief.route({ request, agents: agents.slice(0, 1), access: "edit" })).toThrow()
  expect(RayaChief.route({ request, agents, access: "read" }).agent).toBe("researcher")
})

test("specific file permission keeps writers eligible without broadening their paths", () => {
  const permission = Permission.fromConfig({
    "*": "deny",
    read: "allow",
    edit: { "*": "deny", "/private/result.txt": "allow" },
  })
  const agent = { name: "general", permission }
  expect(RayaChief.capable(agent, "edit")).toBe(true)
  expect(Permission.evaluate("edit", "/private/result.txt", permission).action).toBe("allow")
  expect(Permission.evaluate("edit", "/private/other.txt", permission).action).toBe("deny")
  expect(RayaChief.capable(agents[0], "edit")).toBe(false)
  expect(RayaChief.capable(agents[0], "computer")).toBe(false)
})
