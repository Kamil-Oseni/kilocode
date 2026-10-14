import { isDeepStrictEqual } from "node:util"
import { check } from "../control/frames"
import { release, selected } from "../control/catalog-capture"

export const interpreter = "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2"
export const supervisor = "55530325cc6e8836b49722e39f0b7f87d93c2fe30699d2f5373ff650beb50618"
export const current = "f3aed8eaa2bfcfac00608a4eed05258764745251f9378880f63ccac4e576d518"
const recalled = "957a6b9ce25bdb1d7ce629fb72e8cac97c70cffe98877f9ca3ebb57a0adb63ac"
const retained = "e971a2f6678b9ede506ec656ca13fec8a1dedeea4239524bd39186c337fb2da7"
const prior = "f9b6762a5bb729c7d04fe5e20821fefa420ec2be1934986d73d47664b217071c"
export const supervisors = [
  supervisor,
  "31200051a3248182a01284fa0f8524d07c5360aaf21b5df76025574ff7497e60",
  "953e159d25e57ac862bd96be56b2b53a2febaf89f2e74628b8a11c92cabceb1b",
  "6f6d15bc6d9d8e041ef8afbde4a7b9ca21fcef024c4b5cfc8cad3643d13c224a",
  "a1128d8f746e5827127a67a2c6e022c72e405a4598b3eed790b8a672a3427dd4",
  "2249c00ff1755613ca0d8eadf6e9b8e51ed2dd53ff91c52dae7e36153b4fa72f",
  "0fc0c18acd7574b7fb0d9bff8378de953645113ac5619f4673688cd2ab27fb62",
  "ffbff9b96ada90e9d04e26a0d96dfd0a42abd13eb7aa5c787f6b7fe1f70ad4e4",
  prior,
  retained,
  recalled,
  current,
  "e2a86b4b0947b31c67e210b33538e3730727c44934f8856d038e27e84c1b2048",
  "baed8f707876f323d4dac18492ac35a2af304f91fcc7a60422013b5c368d45c2",
  "a18db2a202bdd20c1a62209eefc1cfd5d89a5e27b56169f65cf0927cdf159d0b",
  "7c2286962a606fade513e4742369d0f084609549961650347b89f44f1f266bcd",
  "715dc3ff0bd136363c3b77e47c9c3e5717645518b9c98060139caf785566dbe4",
] as const

export function compatible(pins: Readonly<Record<string, unknown>>, digest: string) {
  if (!("management.py" in pins)) return true
  if (!isDeepStrictEqual({ ...pins }, selected(pins))) return false
  return (
    digest ===
    (pins["historical.py"] !== release["historical.py"]
      ? prior
      : pins["index.py"] === release["index.py"]
        ? current
        : pins["index.py"] === "699f9d1af1083e9b751b5c08ed71077bafd9809fa1d32918d276e202770aa96c"
          ? recalled
          : retained)
  )
}

export function paired(digest: string) {
  return digest === current || digest === recalled || digest === retained || digest === prior
}

const finite = Object.freeze({
  "bootstrap.py": "530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d",
  "models.py": "2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873",
  "namespace.py": "5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3",
  "owner.py": "fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446",
  "server.py": "6bba99a267420d0e519d8db1f26848af16999ac7b339487f2da4fd0261e73ecb",
  "validation.py": "905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2",
  "worker.py": "e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721",
})
export const retrieval = Object.freeze({
  ...finite,
  "bootstrap.py": "27a1b3edd73c7f10d38aa4737a54601e9abc7acfa812327845b93e9b7af39646",
  "owner.py": "374028df76227eb1b758b0c8fac07b444f5bbbf8b12c26faad2904d7bccebf1b",
})

export function finitecohort(pins: Readonly<Record<string, unknown>>) {
  if (isDeepStrictEqual({ ...pins }, retrieval)) return retrieval
  check(isDeepStrictEqual({ ...pins }, finite), "Exact finite Retrieval cohort required")
  return finite
}
