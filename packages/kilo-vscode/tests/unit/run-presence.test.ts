import { describe, expect, test } from "bun:test"
import { presenceLabel, runPresence } from "../../webview-ui/src/utils/run-presence"

describe("runPresence", () => {
  test("waiting beats busy so a blocked run is unmissable", () => {
    expect(runPresence({ waiting: true, busy: true })).toBe("waiting")
    expect(presenceLabel("waiting")).toBe("Waiting on you")
  })

  test("done and error persist until acknowledged", () => {
    expect(runPresence({ done: true })).toBe("done")
    expect(runPresence({ error: true })).toBe("error")
    expect(runPresence({ done: true, acked: true })).toBe("idle")
    expect(runPresence({ error: true, acked: true })).toBe("idle")
    expect(presenceLabel("done")).toBe("Done")
    expect(presenceLabel("error")).toBe("Blocked")
  })
})
