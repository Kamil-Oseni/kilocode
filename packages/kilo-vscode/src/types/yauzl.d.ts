declare module "yauzl" {
  import type { Readable } from "node:stream"
  type Entry = { fileName: string; uncompressedSize: number }
  export function openPromise(
    path: string,
    options?: { strictFileNames?: boolean; autoClose?: boolean },
  ): Promise<{
    eachEntry(): AsyncIterable<Entry>
    openReadStreamPromise(entry: Entry): Promise<Readable>
    close(): void
  }>
}
