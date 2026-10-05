import { AsyncLocalStorage } from "node:async_hooks"
import path from "node:path"

export namespace MemoryOperation {
  export type Port = {
    run<T>(root: string, body: () => Promise<T>): Promise<T>
    mutate<T>(root: string, paths: readonly string[], body: () => Promise<T>): Promise<T>
  }
  const local = new AsyncLocalStorage<string>()
  let port: Port | undefined

  export function hosted() {
    return port !== undefined
  }

  export function configure(next: Port) {
    if (port) throw new Error("Memory operation port is already installed")
    port = next
  }

  export function run<T>(root: string, body: () => Promise<T>): Promise<T> {
    const selected = path.resolve(root)
    if (local.getStore() === selected) return body()
    const work = () => local.run(selected, body)
    return port ? port.run(selected, work) : work()
  }

  export function mutate<T>(paths: readonly string[], body: () => Promise<T>): Promise<T> {
    if (!port) return body()
    const root = local.getStore()
    if (!root) return Promise.reject(new Error("Memory mutation has no admitted namespace"))
    return port.mutate(
      root,
      paths.map((file) => path.resolve(file)),
      body,
    )
  }

  export function scoped<A extends unknown[], T>(body: (root: string, ...args: A) => Promise<T>) {
    return (root: string, ...args: A) => run(root, () => body(root, ...args))
  }
}
