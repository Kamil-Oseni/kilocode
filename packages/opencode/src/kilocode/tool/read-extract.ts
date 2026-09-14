import type { Readable } from "stream"
import * as Docx from "./read-docx"
import * as Notebook from "./notebook"
import * as Xlsx from "./xlsx"
import * as Pptx from "./read-pptx"

export function binary(filepath: string) {
  return Docx.accepts(filepath) || Xlsx.is(filepath) || Pptx.accepts(filepath)
}

export function accepts(filepath: string) {
  return binary(filepath) || Notebook.isFile(filepath)
}

export function limit(filepath: string) {
  if (Xlsx.is(filepath)) return Xlsx.limit()
  if (Pptx.accepts(filepath)) return Pptx.limit()
  return undefined
}

export async function open(filepath: string, bytes: Buffer): Promise<Readable | undefined> {
  if (Docx.accepts(filepath)) return Docx.open(filepath, bytes)
  if (Xlsx.is(filepath)) return Xlsx.open(filepath, bytes)
  if (Pptx.accepts(filepath)) return Pptx.open(filepath, bytes)
  if (Notebook.isFile(filepath)) return Notebook.open(filepath, bytes)
  return undefined
}
