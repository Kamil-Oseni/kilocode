import { batch } from "solid-js"

export function dispatch<T>(handlers: Set<(message: T) => void>, message: T): void {
  batch(() => handlers.forEach((handler) => handler(message)))
}
