import { cleanPayload, translateBatch } from "./providers.js";

const prefix = "translation.v2.";
const lifetime = 30 * 24 * 60 * 60 * 1000;
const capacity = 900;
const encoder = new TextEncoder();
const pending = new Map();
let writes = Promise.resolve();
let nextSweep = 0;
let generation = 0;
let inserted = 0;

async function keyFor(config, page, input, item) {
  // Keep the original text, URL and credential out of storage keys. Context is
  // part of the digest, so the same word in two different sentences can differ.
  const parts = [config.protocol, config.baseUrl, config.model, config.workspaceId || "", page,
    input.title, input.target, input.kind, item.text, item.heading, item.before, item.after];
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(parts))));
  return prefix + Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
}

function changeStore(operation) {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}

async function prune(store) {
  const now = Date.now();
  if (now < nextSweep && inserted < 32) return;
  const keys = (await store.getKeys()).filter(key => key.startsWith(prefix));
  const rows = await store.get(keys);
  const oldest = keys.sort((a, b) => rows[a].saved - rows[b].saved);
  const obsolete = oldest.filter((key, i) => rows[key].saved <= now - lifetime || i < oldest.length - capacity);
  if (obsolete.length) await store.remove(obsolete);
  inserted = 0;
  nextSweep = now + 60 * 60 * 1000;
}

export function clearTranslations(store = chrome.storage.local) {
  generation++;
  pending.clear();
  return changeStore(async () => {
    const keys = (await store.getKeys()).filter(key => key.startsWith(prefix));
    if (keys.length) await store.remove(keys);
  });
}

// Reserve missing paragraphs before starting the request. Two tabs loading the
// same article can join an in-flight request even when their batch sizes differ.
export async function translateCached(config, payload, page, store = chrome.storage.local, run = translateBatch) {
  const input = cleanPayload(payload);
  const version = generation;
  const keys = await Promise.all(input.items.map(item => keyFor(config, page, input, item)));
  const disk = await store.get(keys).catch(() => ({}));
  const missing = new Map();
  const promises = keys.map((key, i) => {
    const hit = disk[key];
    if (hit?.saved > Date.now() - lifetime && typeof hit.text === "string") return Promise.resolve(hit);
    const flight = version + ":" + key;
    if (pending.has(flight)) return pending.get(flight);
    const entry = Promise.withResolvers();
    pending.set(flight, entry.promise);
    missing.set(key, { ...entry, item: input.items[i], flight });
    return entry.promise;
  });
  // Attach a rejection handler to every reserved promise before starting I/O.
  const results = Promise.all(promises);
  if (missing.size) {
    void (async () => {
      try {
        const glossary = new Map(input.terms.map(t => [t.source, t]));
        for (const row of Object.values(disk)) {
          if (row?.saved > Date.now() - lifetime) {
            for (const term of row.terms || []) if (!glossary.has(term.source)) glossary.set(term.source, term);
          }
        }
        const result = await run(config, { ...input, terms: [...glossary.values()].slice(-48),
          items: [...missing.values()].map(e => e.item) });
        const byId = new Map(result.translations.map(item => [item.id, item.text]));
        const rows = {};
        for (const [key, entry] of missing) {
          const text = byId.get(entry.item.id);
          const terms = result.terms.filter(t => entry.item.text.toLowerCase().includes(t.source.toLowerCase()) && text.includes(t.target));
          rows[key] = { saved: Date.now(), text, terms };
        }
        // A storage failure must never trigger a second model invocation.
        await changeStore(async () => {
          if (generation !== version) return;
          const small = Object.fromEntries(Object.entries(rows).filter(([, v]) => encoder.encode(JSON.stringify(v)).length <= 6000));
          await store.set(small);
          inserted += Object.keys(small).length;
          await prune(store);
        }).catch(() => {});
        for (const [key, entry] of missing) entry.resolve(rows[key]);
      } catch (error) {
        for (const entry of missing.values()) entry.reject(error);
      } finally {
        for (const {flight, promise} of missing.values()) if (pending.get(flight) === promise) pending.delete(flight);
      }
    })();
  }
  const entries = await results;
  return {
    translations: input.items.map((item, i) => ({ id: item.id, text: entries[i].text })),
    terms: [...new Map(entries.flatMap(entry => entry.terms || []).map(t => [t.source, t])).values()]
  };
}
