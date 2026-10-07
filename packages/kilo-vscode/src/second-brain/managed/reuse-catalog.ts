import { isDeepStrictEqual } from "node:util"
import { check } from "../control/frames"

export const images = Object.freeze({
  "retrieval/bootstrap.py": "530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d",
  "retrieval/models.py": "2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873",
  "retrieval/namespace.py": "5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3",
  "retrieval/owner.py": "fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446",
  "retrieval/server.py": "6bba99a267420d0e519d8db1f26848af16999ac7b339487f2da4fd0261e73ecb",
  "retrieval/validation.py": "905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2",
  "retrieval/worker.py": "e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721",
  "retrieval_reuse/bootstrap.py": "cc424607c0b6d9b8565602d11027a4e1c65e769d06af8eaa89b581ec7ff30a6a",
  "retrieval_reuse/entry.py": "88d9a50d99e1ed1930847b38f79142d13e4d443b180eb616956a8d8b3b6292ce",
  "retrieval_reuse/lease.py": "308eeeab2ffbd8ae1e7db9b1da238c442829aec0cd1ab9ea5202a8d8e3412a3d",
  "retrieval_reuse/living.py": "bc75c4be4d9ced06e9bca4c2408430a1d1fb084a827762e81a3b5ec0043d261a",
  "retrieval_reuse/pool.py": "09593bba893a8bdc002f8a85bed2feec2669748fc33e22c7e8ebdc9e9ce842d2",
  "retrieval_reuse/receipts.py": "cab18d5ac5461e045eb283f480eefbd175fa96b8b4fefe8e0353af5f4269ffa3",
  "retrieval_reuse/resident.py": "f5ba90a93cdb55aecef91ba0017a30cc824719c0e840aacf0e5f2026a72fb039",
  "retrieval_reuse/server.py": "f1cee409152d2a5832411087dea53ae8fe92857aceee86947de27ee60c8258ee",
  "retrieval_reuse/session.py": "487cbfdb0724162b1772e685350c212d16328eaa800d644a18a4de009793fb5c",
})

export const catalogs = Object.freeze({
  "Qwen--Qwen3-Embedding-0.6B.json": "60cae741077a5b3f79f531c139674a1461bda80a5fb8ca767ec1a9ba25975b7d",
  "Qwen--Qwen3-Reranker-0.6B.json": "ef8b5bbc099e513ad2ddcd0d20e1ce0006a87e1701228631652d278eecb3f0a3",
  "google--embeddinggemma-2.json": "7f28a34d9d8e9cc67372be2bc8d1c5ad4e386914e59aa18ae7351e1e95646f54",
})

export const fingerprint = "3b55eb2b3dee4e08913382792bfcfa6f0956624a89071754ee5508205dc6814d"

/** Health correlates the selected release; original process ownership stays with the launcher. */
export function readiness(health: Record<string, unknown>, release: unknown) {
  check(
    release === fingerprint &&
      health.ownership_protocol === "raya.retrieval.request.settlement.v2" &&
      health.selected_release_sha256 === fingerprint &&
      isDeepStrictEqual(health.catalog_sha256, catalogs) &&
      health.retirement_unconfirmed === false &&
      health.draining === false,
    "Selected reusable Retrieval readiness differs",
  )
}
