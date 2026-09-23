import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"
import { ChiefPlan } from "@/kilocode/chief/plan"

const agents: ChiefPlan.Agent[] = [
  { name: "researcher", mode: "subagent" },
  { name: "designer", mode: "subagent" },
  { name: "coder", mode: "subagent" },
  { name: "auto", mode: "primary" },
  { name: "retired", mode: "subagent", deprecated: true },
]
const parent = Permission.fromConfig({ task: "allow", edit: "allow" })
const proposals = [
  {
    id: "docs",
    name: "Documentation audit",
    specialist: "researcher",
    access: "read" as const,
    brief: {
      objective: "Inspect the implementation claims",
      context: "Current Raya implementation",
      constraints: ["Do not change source"],
      expectedReturn: "Cited documentation findings",
    },
    scope: ["docs claims"],
    dependsOn: [],
    independence: "Can finish from the current documents without another branch's result.",
    authority: "Inspection only is sufficient.",
  },
  {
    id: "ux",
    name: "Chat interface audit",
    specialist: "designer",
    access: "read" as const,
    brief: {
      objective: "Inspect the current chat activity display",
      constraints: ["Do not change source"],
      expectedReturn: "Specific interface findings",
    },
    scope: ["chat interface"],
    dependsOn: [],
    independence: "Can inspect the current UI without the documentation findings.",
    authority: "Inspection only is sufficient.",
  },
]

const check = (items: unknown, rules = parent, eligible = agents) =>
  ChiefPlan.validate({
    request: "Audit Raya documentation and chat UX",
    proposals: items,
    agents: eligible,
    parent: rules,
  })

describe("Auto Chief branch proposal", () => {
  test("produces exact durable inputs for distinct, bounded read-only audits", () => {
    const result = check(proposals)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      id: "docs",
      name: "Documentation audit",
      specialist: "researcher",
      access: "read",
      brief: proposals[0]!.brief,
      scope: ["docs claims"],
      independence: proposals[0]!.independence,
      authority: proposals[0]!.authority,
    })
    expect(result[1]?.brief.objective).toBe("Inspect the current chat activity display")
  })

  test("refuses one, four, duplicate, dependent, and overlapping branches", () => {
    expect(() => check(proposals.slice(0, 1))).toThrow("two or three")
    expect(() => check([...proposals, proposals[0], proposals[1]])).toThrow("two or three")
    expect(() => check([{ ...proposals[0], id: "ux" }, proposals[1]])).toThrow("IDs and names")
    expect(() => check([{ ...proposals[0], name: "CHAT INTERFACE AUDIT" }, proposals[1]])).toThrow("IDs and names")
    expect(() => check([{ ...proposals[0], brief: proposals[1]!.brief }, proposals[1]])).toThrow("same objective")
    expect(() => check([{ ...proposals[0], dependsOn: ["ux"] }, proposals[1]])).toThrow("depends")
    expect(() => check([{ ...proposals[0], scope: ["chat interface"] }, proposals[1]])).toThrow("overlapping")
    expect(() => check([{ ...proposals[0], scope: ["all"] }, proposals[1]])).toThrow("ambiguous")
    expect(() => check([{ ...proposals[0], independence: " " }, proposals[1]])).toThrow("review rationale")
  })

  test("refuses unavailable specialists and authority beyond the parent", () => {
    expect(() => check([{ ...proposals[0], specialist: "auto" }, proposals[1]])).toThrow("not eligible")
    expect(() => check([{ ...proposals[0], specialist: "retired" }, proposals[1]])).toThrow("not eligible")
    expect(() => check([{ ...proposals[0], specialist: "unknown" }, proposals[1]])).toThrow("not eligible")
    expect(() => check(proposals, Permission.fromConfig({ task: { "*": "allow", researcher: "deny" } }))).toThrow(
      "denies Auto Chief specialist",
    )
    expect(() =>
      check(
        [{ ...proposals[0], specialist: "coder", access: "edit" }, proposals[1]],
        Permission.fromConfig({ task: "allow", edit: "ask" }),
      ),
    ).toThrow("does not grant editing authority")
    expect(check([{ ...proposals[0], specialist: "coder", access: "edit" }, proposals[1]])[0]?.access).toBe("edit")
  })

  test("refuses malformed model proposals and missing request", () => {
    expect(() => check([{ ...proposals[0], access: "all" }, proposals[1]])).toThrow()
    expect(() => check([{ ...proposals[0], brief: { objective: "X" } }, proposals[1]])).toThrow()
    expect(() => ChiefPlan.validate({ request: " ", proposals, agents, parent })).toThrow("exact user request")
  })
})
