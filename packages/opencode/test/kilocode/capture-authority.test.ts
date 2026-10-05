import { expect, test } from "bun:test"
import { assertCapture, withCapture } from "../../src/kilocode/migration/capture-authority"

test("actual incomplete writer coverage refuses capture before entering the export callback", async () => {
  let entered = false
  const [result] = await Promise.allSettled([
    withCapture([], async () => {
      entered = true
    }),
  ])
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected") throw new Error("Incomplete capture was accepted")
  expect(String(result.reason)).toContain("complete integrated profile writer coverage")
  expect(entered).toBe(false)
})

test("a serialized or forged receipt cannot become capture authority", () => {
  const proof: unknown = JSON.parse('{"completeProfileCoverage":true,"portableCaptureAuthorized":true}')
  expect(() => assertCapture(proof, [])).toThrow("authority is absent")
  expect(() => assertCapture(Object.freeze({}), [])).toThrow("authority is absent")
})
