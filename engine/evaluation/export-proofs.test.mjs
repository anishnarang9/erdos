import test from 'node:test';
import assert from 'node:assert/strict';
import {publicPackagePath} from './export-proofs.mjs';

test('public evidence exports admit checker artifacts and exclude release keys',()=>{
  for(const path of ['guest.elf','manifest.json','structure.jcs','parameters.jcs','source/Cargo.lock','source/src/generated.rs','source/protocol/src/lib.rs'])
    assert.equal(publicPackagePath(path),true,path);
  for(const path of ['release-key.hex','pass-proof/release-key.hex','source/release-key.hex','source/private.json','source/../release-key.hex','source/target/secret.key'])
    assert.equal(publicPackagePath(path),false,path);
});
