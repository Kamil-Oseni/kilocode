export namespace PureEnv {
  export function enable(env: NodeJS.ProcessEnv = process.env) {
    env.RAYA_PURE = "1"
    env.KILO_PURE = "1"
  }
}
