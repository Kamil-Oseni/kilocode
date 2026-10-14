/** Exact reviewed Memory cohorts; native activation and publication are separate. */
import { release as legacy } from "./catalog-v2"

const historical = Object.freeze({
  "server.py": "8764ed7600cefb9a33684e06d35ca82df8b408284849fb47442701e9b164443c",
  "index.py": "89fcbf572c83a25bc39f8e646fcd080330ddb1605cb89c65c8240f9d2ae0a9dc",
  "notes.py": "e43105220aa739664bfbaecc6638d36fb201e0da55052da6403f7015f9034643",
  "policy.py": "87c931cfa7cceb7386e6d2b4b05fdacf916360fd2cb0ff590d0fccf5dd334ae2",
  "admission.py": "347561aafc7467a24f7871714fc08f511e1f1509c3ade56fbfa00d71a30eae86",
  "host.py": "4854ab90b06085450136e764ec1f70034ae27c597af9b6fa98a99860aa049a97",
  "operations.py": "a0641dc9072841c30c207ab5327ce5adc19e1151626a1b3e43259a6b2ca123cb",
  "retirement.py": "f31e2535b7793f93ce0c556eb50c9bf774270bce6e86582e1c47ef661794a1da",
  "namespace.py": "0df00525c58bc5c57bb11dbee48cb71785a6c40ee178a011c90a5883dbe26a72",
  "historical.py": "2d97c96d13b906d8aadcae47a89704cb1b839f5e09da144ca28bd20a0af779bc",
  "dispatch.py": "50c6c5ab29519e3cdad4f226b8d5f0c5e30fc407966dd0706a10bd328f96dc35",
  "proposals.py": "fbfd07c0bbe71439d21399d06eac37f8712aff1f24f509697e01f39802c301e0",
  "capture.py": "b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe",
})
const handoff = Object.freeze({
  ...historical,
  "server.py": "deb92041d4cc08c64d64403cb23edfe71221105b2c8094a064aa1e184a168b8b",
  "index.py": "e6f14470dbbe65d1ab6e0c2d0707253b2951bfa6ff529de6e7271c9ba376b5d7",
})
const closed = Object.freeze({
  ...handoff,
  "server.py": "ddcffa6ec22432f1622850aa36e04e48cfe8cad94db28648e1b6b8dd2fefcf1d",
})
const captured = Object.freeze({
  ...closed,
  "index.py": "3c106c8e45267ee808a3c2bd8dfacf85a4d3c1ca47e23785706d7663d6791f65",
})
const managed = Object.freeze({
  ...captured,
  "server.py": "d3b3bba2166c30358442a1ef274d18a272d8e1a1f1c3ea44b70276dc61932af6",
  "index.py": "b6bd48d00bca2565c8c6690691b7f9b1e2e7680abbd48058ab62b4a2770ef5cd",
  "entries.py": "20b59cdc4a4ea3b5124ee81c0950ffbb6429ba05dcd6f0ac8d9d8656c2a13472",
  "management.py": "0794a56bc81e326431d8bbcc961d1e703e03062d18cd9088d9ceae85366d8324",
})
const recovered = Object.freeze({
  ...managed,
  "historical.py": "81c2d9bc84acb94d05d026ef22430a3de262270b968a9e093c22be107a6f7d10",
})
const recalled = Object.freeze({
  ...recovered,
  "index.py": "699f9d1af1083e9b751b5c08ed71077bafd9809fa1d32918d276e202770aa96c",
})
const diverse = Object.freeze({
  ...recalled,
  "index.py": "008f7051d51cdd7bd0edaa2802630ce87b09766be470d9b8f2b3dc494677889e",
})
const warning = Object.freeze({
  ...diverse,
  "index.py": "0bd829a079d6de51f1c8b6d80d3e466d8b093ed9e0b5862a6216db2566e1aa73",
})
const preference = Object.freeze({
  ...warning,
  "capture.py": "f480f49b22e834986cd0c6ef7cb3acf77b0c629011147b02a864ef4ff32135b2",
  "entries.py": "9d186fdabfcd608a679ffb4b8e169c035f50b37919fac0355d9d51d1318e7992",
})
export const release = Object.freeze({
  ...preference,
  "index.py": "5edf5865571b8072c1723fcca3290135af4c509751794803a68f1a27128a11be",
})
const previous = Object.freeze({
  ...historical,
  "index.py": "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e",
})
const retained = Object.freeze({
  ...historical,
  "index.py": "8ae8274ff8f46f906efc9c6c5e2dbd2445315f27dc371bd07485fb71635f20f3",
})
function same(pins: Readonly<Record<string, unknown>>, cohort: Readonly<Record<string, string>>) {
  return (
    Object.keys(pins).length === Object.keys(cohort).length &&
    Object.entries(cohort).every(([name, hash]) => pins[name] === hash)
  )
}

export function selected(pins: Readonly<Record<string, unknown>>) {
  if (!("capture.py" in pins)) return legacy
  if ("entries.py" in pins || "management.py" in pins) {
    if (same(pins, warning)) return warning
    if (same(pins, preference)) return preference
    if (pins["historical.py"] === managed["historical.py"]) return managed
    return pins["index.py"] === recovered["index.py"]
      ? recovered
      : pins["index.py"] === recalled["index.py"]
        ? recalled
        : pins["index.py"] === diverse["index.py"]
          ? diverse
          : release
  }
  if (pins["server.py"] === captured["server.py"] && pins["index.py"] === captured["index.py"]) return captured
  if (pins["server.py"] === handoff["server.py"] && pins["index.py"] === handoff["index.py"]) return handoff
  if (pins["server.py"] === closed["server.py"] && pins["index.py"] === closed["index.py"]) return closed
  if (pins["server.py"] === historical["server.py"] && pins["index.py"] === historical["index.py"]) return historical
  return pins["index.py"] === previous["index.py"]
    ? previous
    : pins["index.py"] === retained["index.py"]
      ? retained
      : captured
}
export function resident(pins: Readonly<Record<string, unknown>>) {
  const cohort = selected(pins)
  return (
    (cohort === release ||
      cohort === preference ||
      cohort === warning ||
      cohort === diverse ||
      cohort === recalled ||
      cohort === recovered ||
      cohort === managed ||
      cohort === captured ||
      cohort === closed ||
      cohort === handoff) &&
    Object.keys(pins).length === Object.keys(cohort).length &&
    Object.entries(cohort).every(([name, hash]) => pins[name] === hash)
  )
}
export const bridge = "16006c57ae824450d5ecab9bd020e975d51ad417a849d457120e63dd6be1bdf0"
const original = "0c75ad3254fb85a0a187a6dfd69ebf3774ceaeb322eaa793a4e7de1b40993c85"
export function transport(pins: Readonly<Record<string, unknown>>, declared?: unknown) {
  const cohort = selected(pins)
  if (cohort === release) return declared === original && same(pins, release) ? original : bridge
  return cohort === preference ||
    cohort === warning ||
    cohort === diverse ||
    cohort === recalled ||
    cohort === recovered ||
    cohort === managed
    ? original
    : "a07325ca6e504cca3ce8714469423706d3e333c2399bfa451f41c896170b898c"
}
