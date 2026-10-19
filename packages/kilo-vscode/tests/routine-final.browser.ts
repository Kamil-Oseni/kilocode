import { expect, test } from "@playwright/test"

const final = { kind: "file", path: "C:\\approved\\answer.txt", bytes: 7, sha256: "a".repeat(64) }

test("native file-choice projection requires explicit visible review then conditional Save; cancellation and removal preserve draft", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Choose final-answer file", exact: true }).click()
  const read = () =>
    page
      .locator("body")
      .getAttribute("data-messages")
      .then((value) => JSON.parse(value || "[]"))
  const pick = (await read()).find((msg: { type: string }) => msg.type === "routineFinalPick")
  expect(pick.type).toBe("routineFinalPick")
  await expect(page.getByRole("button", { name: "Save requirements", exact: true })).toBeDisabled()
  await page.evaluate((data) => window.final.reply(data), { type: "routineFinalPicked", requestID: "foreign", final })
  await expect(page.locator("[data-routine-final]")).toHaveCount(0)
  await page.evaluate((data) => window.final.reply(data), {
    type: "routineFinalPicked",
    requestID: pick.requestID,
    final,
  })
  await expect(page.locator("[data-routine-final]")).toContainText(final.path)
  await expect(page.locator("[data-routine-final]")).toContainText(final.sha256)
  expect((await read()).filter((msg: { type: string }) => msg.type === "routineOutputUpdate")).toHaveLength(0)
  await page.getByRole("button", { name: "Choose another final-answer file" }).click()
  const cancelled = (await read()).at(-1)
  await page.evaluate((data) => window.final.reply(data), {
    type: "routineFinalPicked",
    requestID: cancelled.requestID,
    cancelled: true,
  })
  await expect(page.locator("[data-routine-final]")).toContainText(final.sha256)
  await page.getByRole("button", { name: "Remove exact final answer" }).click()
  await expect(page.locator("[data-routine-final]")).toHaveCount(0)
  await page.getByRole("button", { name: "Choose final-answer file", exact: true }).click()
  const next = (await read()).at(-1)
  await page.evaluate((data) => window.final.reply(data), {
    type: "routineFinalPicked",
    requestID: next.requestID,
    final,
  })
  await page.getByRole("button", { name: "Save requirements", exact: true }).click()
  const saved = (await read()).at(-1)
  expect(saved).toMatchObject({
    type: "routineOutputUpdate",
    agentID: "routine",
    output: { final },
    expectedOutput: { description: "Report" },
  })
  expect(saved.expectedOutput.final).toBeUndefined()
})

test("reconnect invalidates a pending picker and malformed or late responses never change the draft", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Choose final-answer file", exact: true }).click()
  const messages = JSON.parse((await page.locator("body").getAttribute("data-messages")) || "[]")
  await page.evaluate(() => window.final.reply({ type: "connectionState", state: "disconnected" }))
  await expect(page.getByRole("alert")).toContainText("connection changed")
  await page.evaluate((data) => window.final.reply(data), {
    type: "routineFinalPicked",
    requestID: messages.find((msg: { type: string }) => msg.type === "routineFinalPick").requestID,
    final,
  })
  await expect(page.locator("[data-routine-final]")).toHaveCount(0)
  await page.getByRole("button", { name: "Choose final-answer file", exact: true }).click()
  const next = JSON.parse((await page.locator("body").getAttribute("data-messages")) || "[]").at(-1)
  await page.evaluate((data) => window.final.reply(data), {
    type: "routineFinalPicked",
    requestID: next.requestID,
    final: { ...final, bytes: 8193 },
  })
  await expect(page.getByRole("alert")).toContainText("could not be verified")
  await expect(page.locator("[data-routine-final]")).toHaveCount(0)
})
