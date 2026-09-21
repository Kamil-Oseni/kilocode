import { describe, expect, test } from "bun:test"
import { BUILTIN_SKILLS } from "../../src/kilocode/skills/builtin"

const skill = (name: string) => {
  const item = BUILTIN_SKILLS.find((candidate) => candidate.name === name)
  expect(item).toBeDefined()
  return item!.content.toLowerCase()
}

const includes = (content: string, patterns: RegExp[]) => {
  for (const pattern of patterns) expect(content).toMatch(pattern)
}

describe("universal role skill behavior contracts", () => {
  test("coding preserves intent, verifies real behavior, and respects authority", () => {
    includes(skill("coding"), [
      /user's request and higher-priority instructions/,
      /repository instructions/,
      /callers, contracts, and tests/,
      /failure, cancellation, retry, restart, stale-client, and concurrent-owner/,
      /permissions and user authorization as runtime boundaries/,
      /real implementation/,
      /never claim a result.*not observed/,
      /also load the `designer` skill/,
    ])
  })

  test("writing protects source truth, author voice, and the send boundary", () => {
    includes(skill("writing"), [
      /audience, purpose, required decision or action/,
      /distinction between source claims and inference/,
      /retain the author's meaning and deliberate voice/,
      /verify links, references, calculations/,
      /does not authorize sending, publishing, filing, or representing the user externally/,
    ])
  })

  test("marketing requires current evidence, supportable claims, and measurable decisions", () => {
    includes(skill("marketing"), [
      /separate known evidence, assumptions, and questions/,
      /research current facts/,
      /claims specific and supportable/,
      /success metric, guardrails, duration, and a decision rule/,
      /do not authorize ad spend, account changes, publication, outreach, data purchase, or contact/,
    ])
  })
})
