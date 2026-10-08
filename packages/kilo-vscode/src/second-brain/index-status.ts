type Status = Readonly<{
  status: "unchecked" | "approved" | "synced" | "policy_disabled"
  digest?: string
}>

/** Current authenticated inspection only; cached UI state cannot establish an index. */
export function status(input: unknown): Status {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Index inspection required")
  const value = input as Record<string, unknown>
  if (value.status === "unchecked" && Object.keys(value).join() === "status")
    return Object.freeze({ status: "unchecked" })
  if (
    Object.keys(value).sort().join() !== "digest,status" ||
    !["approved", "synced", "policy_disabled"].includes(String(value.status)) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    throw new Error("Current policy and derived index inspection differ")
  return Object.freeze({ status: value.status as Exclude<Status["status"], "unchecked">, digest: value.digest })
}
