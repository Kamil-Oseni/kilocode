import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { stage } from "../../src/kilocode/second-brain/capture-phase"
import { diagnosis } from "../../src/kilocode/second-brain/capture-errors"

test("capture dispatch failures never close an unused extraction grant", async () => {
  const events: string[] = []
  const result = await Effect.runPromiseExit(
    stage(
      Effect.succeed("prepared"),
      () => Effect.sync(() => events.push("captureFailed")),
      () => {
        events.push("capture-dispatched")
        return Effect.fail(new Error("original capture transport unconfirmed"))
      },
    ),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(events).toEqual(["capture-dispatched"])
})

test("failed disposition retains original extraction and secondary error without dispatch", async () => {
  const events: string[] = []
  const result = await Effect.runPromiseExit(
    stage(
      Effect.fail(new Error("invalid_schema")),
      () => Effect.fail(new Error("original disposition disconnected")),
      () => Effect.sync(() => events.push("capture")),
    ),
  )
  if (!Exit.isFailure(result)) throw new Error("Original failure required")
  const err = Cause.squash(result.cause)
  expect(err).toBeInstanceOf(AggregateError)
  const errors = err instanceof AggregateError ? err.errors : [err]
  expect(errors.map((err) => err.message)).toContain("invalid_schema")
  expect(errors.map((err) => err.message)).toContain("original disposition disconnected")
  expect(diagnosis(result.cause)).toBe("invalid_schema; original disposition disconnected")
  expect(events).toEqual([])
})
