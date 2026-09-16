import { describe, expect, test } from "bun:test"
import * as Cloud from "../src/kilocode/provider-usage/cloud"

const subscription = {
  id: "byteplus-plan",
  planId: "byteplus-coding-plan-team-lite",
  planName: "BytePlus Coding Plan Lite",
  providerName: "BytePlus",
  providerId: "byteplus-coding",
  canQueryUsage: true,
  hasInstalledByokKey: true,
  status: "active" as const,
  cancelAtPeriodEnd: false,
}

const state = (enabled = true) => ({
  plans: { ok: true as const, value: [subscription] },
  byok: {
    ok: true as const,
    value: [
      {
        id: "managed-byteplus",
        provider_id: "byteplus-coding",
        management_source: "coding_plan" as const,
        is_enabled: enabled,
      },
    ],
  },
})

describe("managed provider usage", () => {
  test("requires Cloud usage readiness and a matching enabled managed key", () => {
    expect(Cloud.plans(state())).toEqual([subscription])
    expect(Cloud.plans(state(false))).toEqual([])
    expect(
      Cloud.plans({ ...state(), plans: { ok: true, value: [{ ...subscription, canQueryUsage: false }] } }),
    ).toEqual([])
    expect(
      Cloud.plans({ ...state(), plans: { ok: true, value: [{ ...subscription, hasInstalledByokKey: false }] } }),
    ).toEqual([])
    expect(
      Cloud.plans({
        ...state(),
        byok: { ok: true, value: [{ ...state().byok.value[0]!, management_source: "user" as const }] },
      }),
    ).toEqual([])
    expect(
      Cloud.plans({
        ...state(),
        byok: { ok: true, value: [{ ...state().byok.value[0]!, provider_id: "minimax" }] },
      }),
    ).toEqual([])
  })

  test("normalizes BytePlus windows through the generic managed path", async () => {
    const result = await Cloud.managed("token", subscription, async () => ({
      schemaVersion: 1,
      fetchedAt: "2026-08-07T12:00:00.000Z",
      subscription: {
        id: subscription.id,
        planName: subscription.planName,
        providerId: subscription.providerId,
        providerName: subscription.providerName,
        windows: [
          {
            id: "monthly",
            remainingPercent: 75,
            resetsAt: "2026-09-01T00:00:00.000Z",
            period: { unit: "month", value: 1 },
          },
        ],
      },
    }))

    expect(result).toMatchObject({
      providerID: "byteplus-coding",
      providerLabel: "BytePlus",
      planLabel: "BytePlus Coding Plan Lite",
      sourceKind: "kilo_managed",
      windows: [
        {
          id: "byteplus-plan:monthly",
          resource: "subscription",
          period: { unit: "month", value: 1 },
          remaining: 75,
          used: 25,
          limit: 100,
        },
      ],
    })
    expect(result.windows[0]).not.toHaveProperty("durationMs")
  })

  test("uses the Raya API origin for management links and retains the legacy fallback", async () => {
    const saved = {
      raya: process.env.RAYA_API_URL,
      kilo: process.env.KILO_API_URL,
    }
    const usage = async () => ({
      schemaVersion: 1 as const,
      fetchedAt: "2026-08-07T12:00:00.000Z",
      subscription: {
        id: subscription.id,
        planName: subscription.planName,
        providerId: subscription.providerId,
        providerName: subscription.providerName,
        windows: [],
      },
    })
    try {
      process.env.KILO_API_URL = "https://legacy.example/api"
      delete process.env.RAYA_API_URL
      expect((await Cloud.managed("token", subscription, usage)).managementUrl).toBe(
        `https://legacy.example/subscriptions/coding-plans/${subscription.id}`,
      )

      process.env.RAYA_API_URL = "https://raya.example/api"
      expect((await Cloud.managed("token", subscription, usage)).managementUrl).toBe(
        `https://raya.example/subscriptions/coding-plans/${subscription.id}`,
      )

      process.env.RAYA_API_URL = "invalid"
      expect((await Cloud.managed("token", subscription, usage)).managementUrl).toBe(
        `https://app.kilo.ai/subscriptions/coding-plans/${subscription.id}`,
      )
    } finally {
      if (saved.raya === undefined) delete process.env.RAYA_API_URL
      else process.env.RAYA_API_URL = saved.raya
      if (saved.kilo === undefined) delete process.env.KILO_API_URL
      else process.env.KILO_API_URL = saved.kilo
    }
  })
})
