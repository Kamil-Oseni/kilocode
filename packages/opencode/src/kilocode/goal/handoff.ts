import { forward } from "../task/request"

/** Saved requirements for performing a handoff, not documents merely describing one. */
export function required(description: string, verification: string) {
  return [description, verification].some(
    (text) =>
      forward(text) &&
      (/^\s*(?:delegate(?:_work)?|hand[\s-]?off)\b/i.test(text) ||
        /\b(?:and|then)\s+(?:delegate(?:_work)?|hand[\s-]?off)\b/i.test(text) ||
        /\b(?:accept|perform|complete|make|record)\s+(?:(?:an?|the|actual|successful|accepted)\s+){0,3}(?:delegation|handoff|hand-off)\b/i.test(
          text,
        ) ||
        /^\s*delegate_work\s+receipt\b/i.test(text) ||
        /\b(?:cite|verify|require|include)\s+(?:(?:an?|the|actual|successful|accepted)\s+){0,3}(?:delegation|delegate_work|handoff|hand-off)\s+receipt\b/i.test(
          text,
        )),
  )
}
