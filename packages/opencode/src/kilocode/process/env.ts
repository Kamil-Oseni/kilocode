export function model(extra?: NodeJS.ProcessEnv | null): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(extra ?? {}) }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
  delete env.RAYA_SERVER_PASSWORD
  delete env.RAYA_SERVER_USERNAME
  delete env.KILO_SERVER_PASSWORD
  delete env.KILO_SERVER_USERNAME
  delete env.KILO_CONFIG
  delete env.KILO_CONFIG_CONTENT
  delete env.KILO_CONFIG_DIR
  delete env.RAYA_CONFIG
  delete env.RAYA_CONFIG_CONTENT
  delete env.RAYA_CONFIG_DIR
  delete env.KILO_AUTH_CONTENT
  delete env.RAYA_AUTH_CONTENT
  delete env.KILO_DB
  delete env.RAYA_DB
  return env
}
