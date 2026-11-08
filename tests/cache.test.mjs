import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearTranslations, translateCached } from '../lib/translation-cache.js';

const config = {protocol:'openai', baseUrl:'https://api.example/v1', model:'fast', apiKey:'test-only'};
const page = 'https://reading.example/motor';
const input = {title:'Motor', items:[{id:'1', text:'current loop', before:'Motor torque'}]};
function fixture() {
  const rows = new Map();
  const store = {
    async get(keys) { return Object.fromEntries(keys.filter(k => rows.has(k)).map(k => [k, rows.get(k)])); },
    async set(values) { for (const [k,v] of Object.entries(values)) rows.set(k,v); },
    async getKeys() { return [...rows.keys()]; },
    async remove(keys) { for (const k of keys) rows.delete(k); }
  };
  const calls = [];
  const translate = async (_, batch) => {
    calls.push(batch.items);
    return {translations:batch.items.map(i => ({id:i.id, text:'电流环 ' + i.text})), terms:[{source:'current loop',target:'电流环'}]};
  };
  return {store, calls, rows, translate};
}

test('refresh reuses translations and terms; model, page and meaning change independently', async () => {
  const f = fixture();
  const run = (c,p,u) => translateCached(c,p,u,f.store,f.translate);
  const original = await run(config,input,page);
  assert.deepEqual(await run(config,input,page), original);
  const changed = {...input, items:[{...input.items[0], before:'Calendar'}]};
  await run(config,changed,page);
  await run(config,input,page+'/other');
  await run({...config, model:'other'},input,page);
  assert.equal(f.calls.length,4);
  assert.ok([...f.rows.keys()].every(k => /^translation\.v2\.[a-f0-9]{64}$/.test(k)));
  for (const v of f.rows.values()) v.saved = 0;
  await run(config,input,page);
  assert.equal(f.calls.length,5);
  await clearTranslations(f.store);
  assert.equal(f.rows.size,0);
});

test('overlapping batches translate identical text once and preserve each caller’s IDs', async () => {
  const f = fixture(), started = Promise.withResolvers(), release = Promise.withResolvers();
  const blocked = async (...args) => { started.resolve(); await release.promise; return f.translate(...args); };
  const a = translateCached(config,input,page,f.store,blocked);
  await started.promise;
  const b = translateCached(config,{...input,items:[{...input.items[0],id:'other'}]},page,f.store,blocked);
  release.resolve();
  assert.equal((await a).translations[0].id,'1');
  assert.equal((await b).translations[0].id,'other');
  assert.equal(f.calls.length,1);
});

test('failures leave no cached result; clear during a request prevents repopulation', async () => {
  const f = fixture();
  await assert.rejects(translateCached(config,input,page,f.store,async () => {throw new Error('429');}), /429/);
  assert.equal(f.rows.size,0);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const request = translateCached(config,input,page,f.store,async (...args) => {
    started.resolve(); await release.promise; return f.translate(...args);
  });
  await started.promise;
  await clearTranslations(f.store);
  release.resolve();
  assert.ok((await request).translations[0].text);
  assert.equal(f.rows.size,0);
});
