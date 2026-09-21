export function polling(hold: boolean, agent?: string, organization?: string) {
  return !hold && !agent && !organization
}
