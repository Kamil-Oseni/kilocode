import { join } from "./join"

const drains = new Set<() => Promise<void>>()
export function register(close: () => Promise<void>) {
  drains.add(close)
}

/** Fence every realized coordinator synchronously, then join every original lifetime. */
export function drain() {
  const jobs = [...drains].map((close) => {
    try {
      return close()
    } catch (error) {
      return Promise.reject(error)
    }
  })
  return join(jobs)
}
