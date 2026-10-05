import { admitProfileOperation, registerProfileFile } from "./profile-maintenance"

/** Select before native construction; pin rotation/history/cleanup to one canonical directory. */
export function logRoot(dir: string) {
  const owner = registerProfileFile({ kind: "json", path: dir })
  const lease = (() => {
    try {
      return admitProfileOperation({ kind: "json", path: owner.path })
    } catch (err) {
      try {
        owner.release()
      } catch (failure) {
        // oxlint-disable-next-line preserve-caught-error -- AggregateError preserves both raw causes; its options are the third argument.
        throw new AggregateError([err, failure], "Log root admission cleanup failed", { cause: failure })
      }
      throw err
    }
  })()
  let opened = false
  return {
    path: owner.path,
    finish: lease.release,
    close: owner.release,
    opening() {
      opened = true
    },
    async run<A>(body: () => Promise<A>) {
      const result = await Promise.resolve()
        .then(body)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      const failures: unknown[] = []
      try {
        lease.release()
      } catch (err) {
        failures.push(err)
      }
      if (!opened)
        try {
          owner.release()
        } catch (err) {
          failures.push(err)
        }
      if (failures.length)
        throw new AggregateError(
          result.ok ? failures : [result.error, ...failures],
          "Log root admission cleanup failed",
        )
      if (!result.ok) throw result.error
      return result.value
    },
  }
}
