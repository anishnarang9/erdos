// Run after the pinned Forge build. This check needs no installed npm packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const targets = [
  ['OpenClaimAdapter', 'OpenClaimAdapter.sol/OpenClaimAdapter'],
  ['AgenticCommerce', 'AgenticCommercePatched.sol/AgenticCommerce'],
  ['SettlementHook', 'SettlementHook.sol/SettlementHook'],
  ['IRiscZeroVerifier', 'IRiscZeroVerifier.sol/IRiscZeroVerifier'],
  ['RiscZeroGroth16Verifier', 'RiscZeroGroth16Verifier.sol/RiscZeroGroth16Verifier'],
];
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
for (const [name, artifact] of targets) {
  assert.deepEqual(read(`../abi/${name}.json`), read(`../out/${artifact}.json`).abi,
    `${name} exported ABI differs from its compiled artifact`);
  console.log(`${name}: exported ABI matches compiled artifact`);
}
