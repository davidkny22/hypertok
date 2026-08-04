import assert from "node:assert/strict";
import { createNodeAdapters, disposeAdapters } from "../adapters/node.mjs";
import { buildAgreementMatrix } from "../common/agreement.mjs";
import {
  availableReferencesForVocabulary,
  oracleReferenceForVocabulary,
  unavailableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import { vocabularyRegistry } from "../common/vocabularies.mjs";

const probe = Object.freeze({ id: "probe", bytes: 30, text: "Hello, tokenizer! 中文 😀\n" });
let availableCount = 0;
let unavailableCount = 0;

for (const { id: vocabulary } of vocabularyRegistry) {
  const adapters = await createNodeAdapters(vocabulary);
  const available = availableReferencesForVocabulary(vocabulary);
  const unavailable = unavailableReferencesForVocabulary(vocabulary);
  try {
    assert.deepEqual(
      new Set(adapters.map(({ id }) => id)),
      new Set(available.map(({ id }) => id)),
    );
    assert.ok(adapters.every((adapter) => adapter.vocabulary === vocabulary));
    assert.ok(unavailable.every(({ reason }) => typeof reason === "string"));

    const rows = buildAgreementMatrix([probe], adapters, unavailable, {
      vocabulary,
      oracleReference: oracleReferenceForVocabulary(vocabulary).id,
    });
    assert.equal(rows.length, available.length + unavailable.length);
    assert.ok(rows.slice(0, adapters.length).every(({ status }) => status === "identical"));
    assert.ok(rows.slice(adapters.length).every(({ status }) => status === "unavailable"));

    for (const current of adapters) {
      assert.equal(current.decode(current.encode(probe.text)), probe.text, current.id);
    }
    availableCount += adapters.length;
    unavailableCount += unavailable.length;
  } finally {
    disposeAdapters(adapters);
  }
}

console.log(`node adapter agreement PASS (${availableCount}/${availableCount} advertised pairs)`);
console.log(`node adapter decode PASS (${availableCount}/${availableCount} exact)`);
console.log(`named unavailable pairs recorded (${unavailableCount}/${unavailableCount})`);
