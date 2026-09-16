export function print(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.RAYA_PRINT_LOGS ?? env.KILO_PRINT_LOGS)
}
