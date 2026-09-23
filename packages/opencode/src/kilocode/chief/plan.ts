import { Schema } from "effect"
import { Permission } from "@/permission"
import { ChiefBranches } from "./branches"

/** Admission checks for a proposed Auto Chief fanout. This does not launch children. */
export namespace ChiefPlan {
  export const Proposal = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    specialist: Schema.String,
    access: Schema.Literals(["read", "edit"]),
    brief: ChiefBranches.Brief,
    scope: Schema.Array(Schema.String),
    dependsOn: Schema.Array(Schema.String),
    independence: Schema.String,
    authority: Schema.String,
  })
  export type Proposal = typeof Proposal.Type

  export type Agent = {
    name: string
    mode: "primary" | "subagent" | "all"
    hidden?: boolean
    deprecated?: boolean
  }

  const clean = (value: string) => value.trim()
  const unique = (items: readonly string[]) =>
    new Set(items.map((item) => clean(item).toLowerCase())).size === items.length

  /**
   * Refuse ambiguous authority and structurally overlapping plans before durable admission.
   * Scope and independence are explicit claims, not proof that the work is semantically independent.
   * A caller must review those claims against the actual user request before execution.
   */
  export function validate(input: {
    request: string
    proposals: unknown
    agents: readonly Agent[]
    parent: Permission.Ruleset
  }): ChiefBranches.Input[] {
    if (!clean(input.request)) throw new Error("Auto Chief needs the exact user request before planning")
    const items = Schema.decodeUnknownSync(Schema.Array(Proposal))(input.proposals)
    if (items.length < 2 || items.length > 3) throw new Error("Auto Chief requires two or three independent branches")
    if (!unique(items.map((item) => item.id)) || !unique(items.map((item) => item.name)))
      throw new Error("Auto Chief branch IDs and names must be unique")
    if (!unique(items.map((item) => item.brief.objective)))
      throw new Error("Auto Chief branches cannot repeat the same objective")

    const scope = new Set<string>()
    for (const item of items) {
      if (
        !clean(item.id) ||
        !clean(item.name) ||
        !clean(item.specialist) ||
        !clean(item.brief.objective) ||
        !clean(item.brief.expectedReturn) ||
        !clean(item.independence) ||
        !clean(item.authority)
      )
        throw new Error("Every Auto Chief branch needs a name, specialist, exact brief, and review rationale")
      if (item.brief.constraints.some((value) => !clean(value)))
        throw new Error(`Auto Chief branch ${item.name} has an empty constraint`)
      if (item.dependsOn.length)
        throw new Error(`Auto Chief branch ${item.name} depends on another task and cannot run in parallel`)
      if (!item.scope.length || !unique(item.scope))
        throw new Error(`Auto Chief branch ${item.name} needs distinct owned scope`)
      for (const value of item.scope) {
        const key = clean(value).toLowerCase()
        if (!key || key === "*" || key === "all" || key === "entire task" || scope.has(key))
          throw new Error(`Auto Chief branch ${item.name} has an ambiguous or overlapping scope`)
        scope.add(key)
      }
      const agent = input.agents.find((candidate) => candidate.name === item.specialist)
      if (!agent || agent.mode === "primary" || agent.hidden || agent.deprecated)
        throw new Error(`Auto Chief specialist ${item.specialist} is not eligible`)
      if (Permission.evaluate("task", agent.name, input.parent).action === "deny")
        throw new Error(`Parent policy denies Auto Chief specialist ${agent.name}`)
      if (item.access === "edit" && Permission.evaluate("edit", "*", input.parent).action !== "allow")
        throw new Error(`Parent policy does not grant editing authority to ${item.name}`)
    }

    return items.map((item) => ({
      id: clean(item.id),
      name: clean(item.name),
      specialist: item.specialist,
      access: item.access,
      brief: {
        objective: clean(item.brief.objective),
        ...(item.brief.context === undefined ? {} : { context: clean(item.brief.context) }),
        constraints: item.brief.constraints.map(clean),
        expectedReturn: clean(item.brief.expectedReturn),
      },
    }))
  }
}
