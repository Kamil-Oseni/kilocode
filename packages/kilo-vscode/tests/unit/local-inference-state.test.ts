import { expect, test } from "bun:test"
import * as Inference from "../../webview-ui/src/context/local-inference-state"

test("local inference observations require exact primary identities, bounded live counts and fresh provenance", () => {
  const snapshot = {
    version: 1,
    epoch: "10ff0000-0000-4000-8000-000000000000",
    sessionID: "ses_test",
    observedAt: 20_000,
    requests: [
      { messageID: "msg_active", queued: 1, active: 0, since: 10_000 },
      { messageID: "msg_next", queued: 0, active: 1 },
    ],
  }
  expect(Inference.wait(snapshot, "ses_test", "msg_active", 25_000)?.since).toBe(10_000)
  expect(Inference.wait(snapshot, "ses_test", "msg_next", 25_000)).toBeUndefined()
  expect(Inference.wait(snapshot, "ses_test", "msg_missing", 25_000)).toBeUndefined()
  expect(Inference.read(snapshot, "ses_test", 35_000)).toEqual(snapshot)
  expect(Inference.read(snapshot, "ses_test", 35_001)).toBeUndefined()
  expect(Inference.read(snapshot, "ses_foreign", 25_000)).toBeUndefined()
  expect(Inference.read(snapshot, "ses_test", 19_999)).toBeUndefined()
  for (const value of [
    null,
    [],
    {},
    { ...snapshot, version: 2 },
    { ...snapshot, epoch: "old" },
    { ...snapshot, observedAt: Infinity },
    { ...snapshot, requests: Array(10).fill(snapshot.requests[0]) },
    { ...snapshot, requests: [snapshot.requests[0], snapshot.requests[0]] },
    ...[
      { queued: 10 },
      { active: 10 },
      { queued: -1 },
      { active: NaN },
      { since: 20_001 },
      { messageID: "bad/id" },
    ].map((change) => ({ ...snapshot, requests: [{ ...snapshot.requests[0], ...change }] })),
  ])
    expect(Inference.read(value, "ses_test", 25_000)).toBeUndefined()
  expect(
    Inference.wait(
      { ...snapshot, requests: [{ messageID: "msg_active", queued: 1, active: 0 }] },
      "ses_test",
      "msg_active",
      25_000,
    ),
  ).toBeUndefined()
})
