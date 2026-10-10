import { AsyncLocalStorage } from "node:async_hooks"

const owners = new AsyncLocalStorage<{ current: boolean; check: () => void }>()

/** Supplemental caller fence only; all native authority proofs remain mandatory. */
export function check() {
  const owner = owners.getStore()
  if (!owner) return
  if (!owner.current) throw new Error("Original Memory helper acceptance scope retired")
  owner.check()
}

/** Leaked asynchronous callbacks retain a retired scope, never a new operation's acceptance. */
export async function acceptance<T>(caller: () => void, body: () => Promise<T>) {
  check()
  caller()
  const parent = owners.getStore()
  const owner = {
    current: true,
    check: () => {
      if (parent) {
        if (!parent.current) throw new Error("Original Memory helper acceptance scope retired")
        parent.check()
      }
      caller()
    },
  }
  return owners.run(owner, async () => {
    try {
      check()
      const result = await body()
      check()
      return result
    } finally {
      owner.current = false
    }
  })
}
