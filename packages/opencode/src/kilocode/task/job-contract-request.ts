import { inspection, prohibits } from "./request"

/** Classify only an explicit native contract instruction; the caller must authenticate its owner. */
export function required(request: string | undefined) {
  if (!request || inspection(request) || prohibits(request)) return false
  const text = request
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/\u201c[^\u201d]*\u201d|\u2018[^\u2019]*\u2019|"[^"]*"|`[^`]*`|(?:^|\s)'[^'\r\n]*'/g, "")
  return /(?:^|[.!?;\n])\s*(?:please\s+)?(?:use|call)\s+native\s+assign_organization_work\s+with\s+(?:(?:a|the)\s+)?version\s*1\s+contract\b/i.test(
    text,
  )
}
