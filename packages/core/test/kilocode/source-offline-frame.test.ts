import { expect, test } from "bun:test"
import { preparation } from "../../src/kilocode/source-offline-frame"

const generation = crypto.randomUUID()
function frame(failures: string[], restored = true) {
  return { version: 1, generation, state: "retired", restored, failures, portableCaptureAuthorized: false }
}
function refused(raw: unknown) {
  try {
    preparation(raw, generation)
  } catch (err) {
    return err
  }
  throw new Error("Early terminal packet was accepted")
}
test("early native retirement retains only fixed refusal codes and never authorizes an image", () => {
  const known = refused(frame(["Offline exclusive source handle refused"]))
  expect(known).toBeInstanceOf(AggregateError)
  if (!(known instanceof AggregateError)) throw new Error("Missing refusal aggregate")
  expect(known.errors[0].code).toBe("RAYA_OFFLINE_EXCLUSIVE_SOURCE_HANDLE_REFUSED")
  const secret = "SECRET_NATIVE_PASSWORD_AND_SOURCE_PATH"
  const unknown = refused(frame([secret], false))
  if (!(unknown instanceof AggregateError)) throw new Error("Missing refusal aggregate")
  expect(unknown.errors.map((err) => err.code)).toEqual([
    "RAYA_OFFLINE_UNKNOWN_REFUSAL",
    "RAYA_OFFLINE_ROLLBACK_UNCONFIRMED",
  ])
  expect(JSON.stringify(unknown, Object.getOwnPropertyNames(unknown))).not.toContain(secret)
  const empty = refused(frame([]))
  if (!(empty instanceof AggregateError)) throw new Error("Missing refusal aggregate")
  expect(empty.errors[0].code).toBe("RAYA_OFFLINE_EARLY_RETIREMENT")
})
test("early retirement strictly checks correlation, flags, fields and packet bounds", () => {
  for (const raw of [
    { ...frame([]), generation: crypto.randomUUID() },
    { ...frame([]), version: 2 },
    { ...frame([]), portableCaptureAuthorized: true },
    { ...frame([]), extra: "SECRET_FIELD_VALUE" },
    frame(["x".repeat(1025)]),
    frame(Array(129).fill("Offline source hardlink refused")),
  ]) {
    const err = refused(raw)
    expect(err).toMatchObject({ code: "RAYA_OFFLINE_FRAME_INVALID" })
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("SECRET_FIELD_VALUE")
  }
  const held = { state: "held" }
  expect(preparation(held, generation)).toBe(held) // The separate strict held parser still owns acceptance.
})

test("v2 negative namespace refusal requires the exact requested protocol and retains only fixed diagnostics", () => {
  const raw = { ...frame(["Offline negative path appeared or is uncertain"]), version: 2 }
  expect(() => preparation(raw, generation)).toThrow()
  try {
    preparation(raw, generation, 2)
    throw new Error("Early refusal was accepted")
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError)
    if (!(err instanceof AggregateError)) throw err
    expect(err.errors[0].code).toBe("RAYA_OFFLINE_NEGATIVE_PATH_APPEARED_OR_IS_UNCERTAIN")
  }
})
