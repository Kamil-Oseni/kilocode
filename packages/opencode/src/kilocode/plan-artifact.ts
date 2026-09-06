import { Schema } from "effect"
import { createHash } from "node:crypto"

export namespace PlanArtifact {
  export const Step = Schema.Struct({
    id: Schema.String,
    description: Schema.String,
    files: Schema.optional(Schema.Array(Schema.String)),
    acceptance: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(["pending", "in_progress", "done", "blocked"])),
    note: Schema.optional(Schema.String),
  })
  export type Step = typeof Step.Type

  export const Info = Schema.Struct({
    title: Schema.String,
    summary: Schema.String,
    steps: Schema.Array(Step),
    risks: Schema.optional(Schema.Array(Schema.String)),
  })
  export type Info = typeof Info.Type

  export function sidecar(file: string) {
    return file.replace(/\.md$/i, ".plan.json")
  }

  export function id(description: string, index: number) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
    const hash = createHash("sha1").update(`${index}:${description}`).digest("hex").slice(0, 8)
    return slug ? `${slug}-${hash}` : `step-${index + 1}-${hash}`
  }

  export function parse(markdown: string): Info {
    const text = markdown.replace(/\r\n?/g, "\n").trim()
    const lines = text.split("\n")
    const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line))
    const title = heading ? heading.replace(/^#{1,3}\s+/, "").trim() : "Plan"
    const steps: Step[] = []
    for (const line of lines) {
      const item = line.match(/^\s*(?:#{2,6}\s+|[-*]\s+|\d+\.\s+)(.+)$/)
      if (!item?.[1]) continue
      if (/^#{1,3}\s+/.test(line) && steps.length === 0 && line === heading) continue
      const description = item[1].replace(/\*\*/g, "").trim()
      if (!description || description === title) continue
      if (/^(summary|overview|risks?|context)$/i.test(description)) continue
      steps.push({ id: id(description, steps.length), description })
    }
    const summary = lines
      .filter((line) => line.trim() && !/^#{1,6}\s/.test(line) && !/^\s*([-*]|\d+\.)\s/.test(line))
      .slice(0, 3)
      .join(" ")
      .trim()
    return {
      title,
      summary: summary || title,
      steps: steps.length ? steps : [{ id: id(title, 0), description: title }],
    }
  }

  export function prompt(plan: Info) {
    const rows = plan.steps.map((step, index) => `${index + 1}. [${step.id}] ${step.description}`).join("\n")
    return `Structured plan: ${plan.title}\n${plan.summary}\n\nSteps:\n${rows}`
  }

  export function mark(plan: Info, id: string, status: Step["status"], note?: string): Info {
    return {
      ...plan,
      steps: plan.steps.map((step) => (step.id === id ? { ...step, status, note: note ?? step.note } : step)),
    }
  }

  export async function save(file: string, plan: Info) {
    await Bun.write(sidecar(file), JSON.stringify(plan, null, 2))
  }

  export async function load(file: string) {
    const raw = await Bun.file(sidecar(file)).json().catch(() => undefined)
    if (!raw) return
    return Schema.decodeUnknownSync(Info)(raw)
  }
}
