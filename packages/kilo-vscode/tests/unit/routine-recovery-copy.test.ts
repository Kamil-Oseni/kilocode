import { expect, test } from "bun:test"
import { routineFailure } from "../../webview-ui/src/utils/routine-recovery"
import { recoveryCopy } from "../../webview-ui/src/utils/recovery-copy"

test("routine failure copy keeps the cause and adds the typed next step once", () => {
  const next = "Reload the current routine and compare it with your draft before submitting again."
  expect(routineFailure("The routine changed.", { kind: "conflict", next })).toBe(`The routine changed. ${next}`)
  expect(routineFailure(`The routine changed. ${next}`, { kind: "conflict", next })).toBe(
    `The routine changed. ${next}`,
  )
})

test("routine failure copy remains useful when either side is absent", () => {
  expect(routineFailure("The request failed.")).toBe("The request failed.")
  expect(routineFailure(undefined, { kind: "unavailable", next: "Reconnect and inspect the current state." })).toBe(
    "Reconnect and inspect the current state.",
  )
  expect(routineFailure()).toBe("")
})

test("routine failure copy identifies preserved work without repeating guidance", () => {
  expect(
    routineFailure(
      "The save was interrupted.",
      { kind: "connection", next: "Reconnect and inspect the current state." },
      "Your draft and attachments are still here.",
    ),
  ).toBe("The save was interrupted. Your draft and attachments are still here. Reconnect and inspect the current state.")
})

test("general recovery copy always names preserved work and a next step", () => {
  for (const copy of [recoveryCopy.startup, recoveryCopy.assistant]) {
    expect(copy.preserved).toMatch(/remain/)
    expect(copy.next).toMatch(/Retry|Review/)
  }
  expect(recoveryCopy.assistant.auth).toMatch(/remain/)
  expect(recoveryCopy.turn.preserved).toMatch(/remain/)
  for (const next of [recoveryCopy.turn.continue, recoveryCopy.turn.filtered, recoveryCopy.turn.error])
    expect(next).toMatch(/Review|Revise|Open/)
})
