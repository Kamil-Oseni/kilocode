import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { RayaAdmin } from "@/kilocode/admin/registry"

const at = 1_800_000_000_000

describe("Raya admin health registry", () => {
  test("collects a stable complete snapshot and contains probe failures", async () => {
    const snapshot = await RayaAdmin.collect(
      [
        {
          id: "runtime",
          read: (time) => ({ ...RayaAdmin.runtime("connected", time), secret: "synthetic-runtime-secret" }),
        },
        {
          id: "sessions",
          read() {
            throw new Error("C:/private/workspace synthetic-token")
          },
        },
      ],
      () => at,
    )

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "runtime",
      "sessions",
      "routines",
      "agents",
      "browser",
      "voice",
    ])
    expect(snapshot.items[0]).toEqual({ id: "runtime", status: "healthy", reason: "ready", observedAt: at })
    expect(snapshot.items[1]).toEqual({ id: "sessions", status: "unknown", reason: "probe-failed", observedAt: at })
    expect(snapshot.items.slice(2).every((item) => item.reason === "not-checked")).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("synthetic")
    expect(Schema.decodeUnknownSync(RayaAdmin.Snapshot)(snapshot)).toEqual(snapshot)
  })

  test("maps existing connection, routine, browser, and voice signals without exporting details", () => {
    expect(RayaAdmin.runtime("disconnected", at)).toMatchObject({ status: "offline", reason: "disconnected" })
    expect(RayaAdmin.sessions({ storage: "unreadable", stream: "connected" }, at)).toMatchObject({
      status: "degraded",
      reason: "storage-unreadable",
    })

    const routines = RayaAdmin.routines(
      [{ execution: { state: "recovery", runID: "secret-run" } }],
      {
        items: [
          {
            agentID: "secret-agent",
            runs: [
              {
                id: "secret-run",
                agentID: "secret-agent",
                at,
                sessionID: "ses_secret",
                status: "error",
              },
            ],
          },
        ],
        failed: [],
      },
      at,
    )
    expect(routines).toEqual({
      id: "routines",
      status: "degraded",
      reason: "routine-recovery",
      observedAt: at,
      metrics: { agents: 1, runs: 1, blocked: 0, recovering: 1, failed: 1 },
    })

    expect(RayaAdmin.browser({ status: "locked" }, at)).toMatchObject({
      status: "blocked",
      reason: "browser-locked",
    })
    expect(
      RayaAdmin.agents([{ execution: { state: "active", runID: "secret-active" } }, { execution: undefined }], at),
    ).toEqual({
      id: "agents",
      status: "healthy",
      reason: "ready",
      observedAt: at,
      metrics: { agents: 2, active: 1, recovering: 0 },
    })
    expect(RayaAdmin.voice(true, [{ info: { status: "failed" }, incomplete: true }], at)).toMatchObject({
      status: "degraded",
      reason: "voice-failed",
      metrics: { active: 0, failed: 1, incomplete: 1 },
    })
    expect(JSON.stringify({ routines })).not.toContain("secret")
  })

  test("does not treat blocked work as healthy", () => {
    const row = RayaAdmin.routines(
      [{ execution: undefined }],
      {
        items: [
          {
            agentID: "agent",
            runs: [{ id: "run", agentID: "agent", at, sessionID: "ses_test", status: "blocked" }],
          },
        ],
        failed: [],
      },
      at,
    )
    expect(row).toMatchObject({
      status: "blocked",
      reason: "routine-blocked",
      metrics: { agents: 1, blocked: 1 },
    })
    expect(RayaAdmin.agents([{ execution: { state: "recovery", runID: "secret" } }], at)).toMatchObject({
      status: "degraded",
      reason: "agent-recovery",
      metrics: { agents: 1, active: 0, recovering: 1 },
    })
  })
})
