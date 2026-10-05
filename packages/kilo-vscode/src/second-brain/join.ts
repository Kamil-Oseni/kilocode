/** Start each required cleanup before joining; retain every distinct original cause. */
export async function join(jobs: readonly Promise<unknown>[]) {
  const results = await Promise.allSettled(jobs)
  const errors = [...new Set(results.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])))]
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Memory cleanup failures retained")
}
