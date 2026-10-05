import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"

export function retireHandler<A extends unknown[]>(
  app: {
    handler: (...args: A) => Promise<Response>
    dispose: () => Promise<void>
  },
  registry: Pick<typeof RuntimeRegistry, "register"> = RuntimeRegistry,
) {
  let retired = false
  let closed: Promise<void> | undefined
  const owner = {
    handler: (...args: A) => {
      if (retired) return Promise.reject(new Error("HTTP handler is retired"))
      return app.handler(...args)
    },
    dispose() {
      retired = true
      return (closed ??= Promise.resolve().then(() => app.dispose()))
    },
  }
  registry.register(() => owner.dispose())
  return owner
}
