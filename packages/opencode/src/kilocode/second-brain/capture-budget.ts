/** Stay within the explicitly selected model and the bounded capture worker. */
export function budget(limit: { context: number; output: number }) {
  if (
    !Number.isSafeInteger(limit.context) ||
    !Number.isSafeInteger(limit.output) ||
    limit.output < 1 ||
    limit.context < 34
  )
    throw new Error("Capture requires valid configured model limits")
  const output = Math.min(1800, limit.output, limit.context - 33)
  return { input: Math.min(8000, limit.context - output - 32), output }
}
