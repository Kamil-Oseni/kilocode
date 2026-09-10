export type VoiceUsage = {
  responses: number
  transcriptions: number
  input: number
  output: number
  missing: number
  invalid: number
  recorded: number
  unrecorded: number
  seconds?: number
  durations?: number
  pending: number
  incomplete: boolean
}
