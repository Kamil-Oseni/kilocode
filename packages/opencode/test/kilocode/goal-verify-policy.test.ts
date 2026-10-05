import { expect, test } from "bun:test"
import { RayaChief } from "@/kilocode/chief"

const available = Object.fromEntries(
  ["chief_route", "task", "get_goal", "update_goal", "update_goal_plan", "question", "ask_options"].map((name) => [
    name,
    Symbol(name),
  ]),
)

test("Auto verification advertises only the actual goal reader", () => {
  const metadata = { [RayaChief.phaseKey]: "verify" }
  expect(RayaChief.phase(metadata)).toBe("verify")
  expect(RayaChief.tools(available, metadata)).toEqual({ get_goal: available.get_goal })
  expect(RayaChief.tools(available, { ...metadata, [RayaChief.requestKey]: "Create a daily routine" })).toEqual({
    get_goal: available.get_goal,
  })
  expect(RayaChief.tools(available, { ...metadata, "raya.canvas.command": true })).toEqual({
    get_goal: available.get_goal,
  })
})

test("Auto verification fails closed when the goal reader is unavailable", () => {
  const registry = Object.fromEntries(Object.entries(available).filter(([name]) => name !== "get_goal"))
  expect(RayaChief.tools(registry, { [RayaChief.phaseKey]: "verify" })).toEqual({})
})

test("verified active work retains delegation, goal controls and clarification", () => {
  const metadata = { [RayaChief.phaseKey]: "goal" }
  expect(RayaChief.tools(available, metadata)).toEqual(available)
  expect(RayaChief.tools(available, { [RayaChief.phaseKey]: "task" })).toEqual(available)
  expect(RayaChief.tools(available, { [RayaChief.phaseKey]: "done" })).toEqual(available)
  expect(RayaChief.tools(available, {})).toEqual({ chief_route: available.chief_route })
})
