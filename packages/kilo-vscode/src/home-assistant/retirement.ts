/** Start the required fence immediately and retain every original cleanup, including synchronous failures. */
export async function retire(required: () => Promise<void>, work: () => Promise<void>, final: () => void) {
  const start = (action: () => void | Promise<void>) => {
    try {
      return Promise.resolve(action())
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const results = await Promise.allSettled([start(required), start(work)])
  const ending = await Promise.allSettled([start(final)])
  const errors = [
    ...new Set([...results, ...ending].flatMap((value) => (value.status === "rejected" ? [value.reason] : []))),
  ]
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Extension required cleanup failures retained")
}
