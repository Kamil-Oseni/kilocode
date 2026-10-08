/** VS Code normalizes line endings in read-only virtual documents. Keep every other character exact. */
export function unchanged(expected: string, actual: string) {
  return expected.replace(/\r\n/g, "\n") === actual.replace(/\r\n/g, "\n")
}
