import { Schema } from "effect"

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const ID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/))
export const Tasks = Schema.Array(
  Schema.Struct({
    id: ID,
    description: Text,
    output: Text,
    owner: Text,
    verification: Text,
    status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
    dependencies: Schema.Array(ID).check(Schema.isMaxLength(100)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(100))
export const Plan = Schema.Struct({
  review: Schema.optional(Schema.Boolean),
  objective: Schema.String,
  revision: Schema.String,
  at: Schema.Number,
  tasks: Tasks,
})
export const Update = Schema.Struct({
  expectedIntent: Schema.String.check(Schema.isMinLength(1)),
  expectedRevision: Schema.NullOr(Schema.String),
  tasks: Tasks,
})

/** Validate the graph and declared execution state; no worker is started here. */
export function validate(tasks: typeof Tasks.Type) {
  const entries = new Map(tasks.map((item) => [item.id, item]))
  if (entries.size !== tasks.length) return "Plan task IDs must be unique."
  for (const item of tasks) {
    if (new Set(item.dependencies).size !== item.dependencies.length) return `Duplicate dependencies for ${item.id}.`
    for (const id of item.dependencies) {
      const dependency = entries.get(id)
      if (!dependency) return `Missing dependency ${id} for ${item.id}.`
      if (id === item.id) return `Task ${item.id} cannot depend on itself.`
      if ((item.status === "in_progress" || item.status === "completed") && dependency.status !== "completed")
        return `Task ${item.id} cannot be ${item.status} until dependency ${id} is completed.`
    }
  }
  const pending = new Set(entries.keys())
  while (pending.size) {
    const ready = [...pending].filter((id) =>
      entries.get(id)!.dependencies.every((dependency) => !pending.has(dependency)),
    )
    if (!ready.length) return "Plan dependencies contain a cycle."
    for (const id of ready) pending.delete(id)
  }
}
