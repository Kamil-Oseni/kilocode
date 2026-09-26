import { describe, expect, test } from "bun:test"
import { runUnknownOutcomeScenario } from "./computer-use-unknown-outcome-task"

describe("ambiguous native outcome bridge-path scenario", () => {
  test("records unknown, refuses replay after restart, and acknowledges the delivered receipt", async () => {
    const result = await runUnknownOutcomeScenario()
    expect(result).toMatchObject({
      scenario: "ambiguous-native-outcome",
      releaseGateEligible: false,
      unknownRecorded: true,
      noAutomaticReplay: true,
      explicitlyAcknowledged: true,
      nativeEffects: 1,
    })
  })
})
