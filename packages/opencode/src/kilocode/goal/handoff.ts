import { forward } from "../task/request"

function transfer(text: string) {
  const match = /^\s*(?:pass|hand)\s+([^\n!?]{1,240}?)\s+to\b/i.exec(text)
  return (
    !!match &&
    !/\b(?:no|not|never|without|don't|cannot|can't|avoid)\b/i.test(match[1]) &&
    /\b(?:files?|outputs?|artifacts?)\b|\b[\w-]+\.[a-z0-9]{1,8}\b/i.test(match[1])
  )
}

/** Saved requirements for performing a handoff, not documents merely describing one. */
export function required(description: string, verification: string) {
  return [description, verification].some(
    (text) =>
      transfer(text) ||
      (forward(text) &&
        (/^\s*(?:delegate(?:_work)?|hand[\s-]?off)\b/i.test(text) ||
          /\b(?:and|then)\s+(?:delegate(?:_work)?|hand[\s-]?off)\b/i.test(text) ||
          /\b(?:accept|perform|complete|make|record)\s+(?:(?:an?|the|actual|successful|accepted)\s+){0,3}(?:[\w-]+['’]s\s+)?(?:delegation|handoff|hand-off)\b/i.test(
            text,
          ) ||
          /^\s*delegate_work\s+receipt\b/i.test(text) ||
          /^\s*(?:call|use)\s+delegate_work\b/i.test(text) ||
          /^\s*show\b[^\n]{0,200}\bdelegate_work\s+receipt\b/i.test(text) ||
          /\b(?:cite|verify|require|include)\s+(?:(?:an?|the|actual|successful|accepted)\s+){0,3}(?:delegation|delegate_work|handoff|hand-off)\s+receipt\b/i.test(
            text,
          ))),
  )
}

export function artifacts(description: string, verification: string) {
  if (!required(description, verification)) return false
  return [description, verification].some((text) =>
    [...text.matchAll(/\b(?:actual|verified|produced|written)\s+(?:[\w.-]+\s+){0,4}(?:files?|artifacts?)\b/gi)].some(
      (match) =>
        !/\b(?:no|not|never|without|don't|cannot|can't|avoid)\s+(?:\w+\s+){0,2}$/i.test(text.slice(0, match.index)),
    ),
  )
}
