/** A whole file path is setup/navigation input, not a semantic note question. */
export function setup(value: string) {
  const text = value.trim().replace(/^(["'])(.*)\1$/, "$2")
  return /^(?:[a-z]:[\\/]|\\\\|\/|file:\/\/)/i.test(text) || /^(?:.*[\\/])?(?:setup|managed-launch)\.json$/i.test(text)
}
