import { expect, test } from "bun:test"
import { question } from "../../src/shared/memory-setup-question"

test("Memory setup cards retain stable choices and an explicit pause option", () => {
  const stages = ["connect", "notes", "index", "capture"] as const
  const ids = ["use_prepared", "choose_notes", "index_notes", "enable_capture"]
  stages.forEach((stage, index) => {
    const card = question(stage, "D:/Raya/SecondBrain")
    expect(card.options.map((option) => option.id)).toEqual([ids[index], "cancel"])
    expect(card.options[1].label).toBe("Not now")
    expect(card.prompt.length).toBeLessThanOrEqual(300)
  })
})

test("Long notes folders fit the setup protocol without asking for setup files", () => {
  const card = question("connect", `D:/${"folder/".repeat(1000)}SecondBrain`)
  expect(card.prompt.length).toBeLessThanOrEqual(300)
  expect(card.prompt).toContain("SecondBrain")
  expect(card.prompt).not.toMatch(/setup\.json|managed-launch|SHA-256/)
})
