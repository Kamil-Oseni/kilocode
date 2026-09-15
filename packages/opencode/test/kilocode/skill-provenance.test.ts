import { describe, expect, test } from "bun:test"
import { SHADOW_LIMIT, digest, resolve, skillVersion } from "../../src/kilocode/skills/resolution"
import type { Receipt } from "../../src/kilocode/skills/resolution"

describe("skill resolution provenance", () => {
  test("hashes exact UTF-8 source content and normalizes bounded versions", () => {
    expect(digest("Raya\n")).toBe("8134a6c9a32955d44670b666cc34ecc7ca9b24a00c76665f387d5cbae94163f2")
    expect(skillVersion(" 1.2.3 ")).toBe("1.2.3")
    expect(skillVersion(" ")).toBeUndefined()
    expect(skillVersion("x".repeat(65))).toBeUndefined()
  })

  test("retains selected source and bounds the shadowed resolution chain", () => {
    const first = resolve({
      source: { kind: "builtin", locator: "raya:bundled:designer", trusted: true },
      content: "base",
      order: -1,
      version: "1",
    })
    const receipt = Array.from({ length: SHADOW_LIMIT + 2 }).reduce<Receipt>(
      (previous, _, order) =>
        resolve({
          source: { kind: "project", locator: `/project/${order}`, trusted: false },
          content: `override-${order}`,
          order,
          version: `${order + 2}`,
          previous,
        }),
      first,
    )

    expect(receipt.source.locator).toBe(`/project/${SHADOW_LIMIT + 1}`)
    expect(receipt.skillVersion).toBe(`${SHADOW_LIMIT + 3}`)
    expect(receipt.sha256).toBe(digest(`override-${SHADOW_LIMIT + 1}`))
    expect(receipt.resolution.shadowed).toHaveLength(SHADOW_LIMIT)
    expect(receipt.resolution.shadowed[0]?.locator).toBe(`/project/${SHADOW_LIMIT}`)
    expect(receipt.resolution.truncated).toBe(true)
  })
})
