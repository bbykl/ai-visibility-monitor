import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Credentials } from '../src/credentials.js';

// Deliberately nonfunctional fixture keys, never real service credentials.
const keyA = 'sk-' + 'test_environment_placeholder';
const keyB = 'sk-' + 'test_dashboard_placeholder';

test('local key changes take effect immediately and persist without returning the secret', () => {
  const dir=mkdtempSync(resolve(tmpdir(),'visibility-keys-')),path=resolve(dir,'credentials.json');
  try {
    const store=new Credentials(path,keyA);
    assert.equal(store.key,keyA);
    assert.deepEqual(store.status(),{configured:true,source:'environment'});
    assert.deepEqual(store.save(keyB),{configured:true,source:'settings'});
    assert.equal(store.key,keyB);
    assert.equal(new Credentials(path,keyA).key,keyB);
    assert.equal(JSON.stringify(store.status()).includes(keyB),false);
    assert.equal(JSON.parse(readFileSync(path,'utf8')).apiKey,keyB);
    assert.deepEqual(readdirSync(dir),['credentials.json']);
    assert.throws(()=>store.save('sk-bad\nAuthorization: injected'),/有效/);
    assert.equal(new Credentials(path,keyA).key,keyB);
    store.save('');
    assert.equal(new Credentials(path,keyA).key,'');
    assert.deepEqual(store.status(),{configured:false,source:'none'});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
