/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { createKiloClient, type Event } from "@kilocode/sdk/v2"
import type { TuiEventBus } from "@kilocode/plugin/tui"
import { accounting } from "../../src/kilocode/accounting"
import { costLabel } from "@opencode-ai/core/kilocode/accounting-label"
import { createFetch, json } from "../fixture/tui-sdk"

async function wait(check: () => boolean) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error("Accounting update timed out")
    await Bun.sleep(10)
  }
}

test("accounting labels distinguish measured zero, missing costs and tiny estimates", () => {
  const summary = { amount: 0, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 0 }
  expect(costLabel({ cost: 0, accounting: summary }, "en-US")).toBe("$0.00 · reported by provider")
  expect(costLabel({ cost: 0 }, "en-US")).toBe("Cost unavailable")
  expect(costLabel({ cost: 4 }, "en-US")).toContain("provenance unavailable")
  expect(costLabel({ cost: 0, accounting: { ...summary, amount: 0.0000001, estimated: 1 } }, "en-US")).toContain(
    "< $0.000001",
  )
  expect(costLabel({ cost: 0, accounting: { ...summary, unknown: 1 } }, "en-US")).toContain("incomplete cost")
})

test("ledger updates ignore stale sessions, recover failed refreshes, and dispose subscriptions", async () => {
  const pending: Array<{ path: string; resolve: (response: Response) => void }> = []
  const transport = createFetch(
    (url) => new Promise<Response>((resolve) => pending.push({ path: url.pathname, resolve })),
  )
  const target = new EventTarget()
  let listeners = 0
  const event: TuiEventBus = {
    on(type, handler) {
      const receive = (value: globalThis.Event) =>
        handler((value as CustomEvent<Extract<Event, { type: typeof type }>>).detail)
      target.addEventListener(type, receive)
      listeners++
      return () => {
        target.removeEventListener(type, receive)
        listeners--
      }
    },
  }
  const emit = (value: Event) => target.dispatchEvent(new CustomEvent(value.type, { detail: value }))
  const [session, setSession] = createSignal("ses_first")
  let view: ReturnType<typeof accounting> | undefined
  const app = await testRender(() => {
    view = accounting(
      { client: createKiloClient({ baseUrl: "http://localhost", fetch: transport.fetch }), event },
      session,
    )
    return <text>{view.label()}</text>
  })
  const result = (amount: number) =>
    json({
      sessionIDs: ["ses_second", "ses_child"],
      totals: {
        cost: amount,
        accounting: { amount, reported: 1, estimated: 0, partial: 0, unknown: 0, legacy: 0 },
      },
      models: [],
    })
  try {
    await wait(() => pending.length === 1)
    expect(pending[0].path).toBe("/session/ses_first/model-usage")
    setSession("ses_second")
    await wait(() => pending.length === 2)
    pending[1].resolve(result(2))
    await wait(() => view!.label().includes("$2.00"))
    pending[0].resolve(result(99))
    await Bun.sleep(20)
    expect(view!.label()).not.toContain("99")
    expect(view!.scope()).toContain("related conversations")
    emit({
      id: "evt_refresh",
      type: "session.status",
      properties: { sessionID: "ses_child", status: { type: "idle" } },
    })
    await wait(() => pending.length === 3)
    expect(view!.label()).toContain("updating")
    pending[2].resolve(json({ message: "unavailable" }, { status: 503 }))
    await wait(() => view!.label() === "Cost unavailable")
    emit({ id: "evt_retry", type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } })
    await wait(() => pending.length === 4)
    pending[3].resolve(result(0))
    await wait(() => view!.label().includes("$0.00"))
    expect(view!.label()).toContain("reported by provider")
  } finally {
    app.renderer.destroy()
  }
  expect(listeners).toBe(0)
})
