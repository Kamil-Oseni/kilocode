import { join } from "./join"

const drains = new Set<(terminating: boolean) => Promise<void>>()
export function register(close: (terminating: boolean) => Promise<void>) {
  drains.add(close)
}

/** Fence every realized coordinator synchronously, then join every original lifetime. */
export function drain(terminating = false) {
  const jobs = [...drains].map((close) => {
    try {
      return close(terminating)
    } catch (error) {
      return Promise.reject(error)
    }
  })
  return join(jobs)
}
