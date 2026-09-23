import { describe, expect, it } from "bun:test"
import { ObservationLedger } from "../../src/services/computer-use/observation-ledger"

const browser = { surface: "browser" as const, windowID: "tab-1", location: "https://example.test/" }

describe("Computer Use observation ledger", () => {
  it("consumes an exact observation once", () => {
    const ledger = new ObservationLedger("Browser")
    const observation = ledger.issue(browser, 2, 100)

    expect(observation).toMatchObject({ version: 2, sequence: 1, sceneVersion: 1 })
    expect(ledger.consume(observation.id, browser, 2, 101)).toEqual(observation)
    expect(() => ledger.consume(observation.id, browser, 2, 102)).toThrow(/unknown or was already used/i)
  })

  it("refuses expiry, manual takeover, and changed targets before reuse", () => {
    const ledger = new ObservationLedger("Desktop", 10)
    const expired = ledger.issue({ surface: "desktop", windowID: "window-1", location: "Editor" }, 1, 100)
    expect(() => ledger.consume(expired.id, expired.target, 1, 111)).toThrow(/expired/i)

    const controlled = ledger.issue(expired.target, 1, 200)
    expect(() => ledger.consume(controlled.id, expired.target, 2, 201)).toThrow(/manual control/i)

    const moved = ledger.issue(expired.target, 2, 300)
    expect(() => ledger.consume(moved.id, { ...expired.target, windowID: "window-2" }, 2, 301)).toThrow(
      /different window or document/i,
    )

    const navigated = ledger.issue(expired.target, 2, 400)
    expect(() => ledger.consume(navigated.id, { ...expired.target, location: "Terminal" }, 2, 401)).toThrow(
      /stale after navigation/i,
    )
  })

  it("evicts the oldest bounded observation", () => {
    const ledger = new ObservationLedger("Browser", 60_000, 2)
    const first = ledger.issue(browser, 0, 100)
    const second = ledger.issue({ ...browser, windowID: "tab-2" }, 0, 101)
    const third = ledger.issue({ ...browser, windowID: "tab-3" }, 0, 102)

    expect(() => ledger.consume(first.id, first.target, 0, 103)).toThrow(/unknown/i)
    expect(ledger.consume(second.id, second.target, 0, 103)).toEqual(second)
    expect(ledger.consume(third.id, third.target, 0, 103)).toEqual(third)
  })

  it("invalidates only the requested surface and window", () => {
    const ledger = new ObservationLedger("Computer")
    const first = ledger.issue(browser, 0)
    const second = ledger.issue({ ...browser, windowID: "tab-2" }, 0)
    const desktop = ledger.issue({ surface: "desktop", windowID: "window-1", location: "Editor" }, 0)

    ledger.invalidate("browser", "tab-1")
    expect(() => ledger.consume(first.id, first.target, 0)).toThrow(/unknown/i)
    expect(ledger.consume(second.id, second.target, 0)).toEqual(second)
    expect(ledger.consume(desktop.id, desktop.target, 0)).toEqual(desktop)
  })

  it("advances a consumed scene without extending its bounded lifetime", () => {
    const ledger = new ObservationLedger("Desktop", 100)
    const first = ledger.issue({ surface: "desktop", windowID: "window-1", location: "scene-1" }, 4, 1_000)
    const step = ledger.begin(first.id, first.target, 4, 1_010)
    const second = ledger.advance(step, { ...first.target, location: "scene-2" }, 4, 1_020)

    expect(second).toMatchObject({
      version: 2,
      sequence: 2,
      sceneVersion: 2,
      observedAt: 1_020,
      validUntil: 1_100,
      target: { location: "scene-2" },
    })
    expect(() => ledger.consume(first.id, first.target, 4, 1_021)).toThrow(/already used/i)
    expect(() => ledger.advance(step, second.target, 4, 1_021)).toThrow(/already advanced/i)
    expect(ledger.consume(second.id, second.target, 4, 1_021)).toEqual(second)

    const expiring = ledger.issue(first.target, 4, 2_000)
    const expired = ledger.begin(expiring.id, expiring.target, 4, 2_010)
    expect(() => ledger.advance(expired, expiring.target, 4, 2_101)).toThrow(/continuity expired/i)
  })

  it("invalidates an in-flight scene step on manual takeover", () => {
    const ledger = new ObservationLedger("Desktop")
    const observation = ledger.issue({ surface: "desktop", windowID: "window-1" }, 1, 100)
    const step = ledger.begin(observation.id, observation.target, 1, 101)

    ledger.invalidate("desktop", "window-1")
    expect(() => ledger.advance(step, observation.target, 2, 102)).toThrow(/unknown/i)
  })
})
