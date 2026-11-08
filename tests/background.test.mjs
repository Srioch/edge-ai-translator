import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// Exercise the extension message boundary, including requests arriving from
// already-injected documents after Chrome removes a host permission.
const ext = "abcdefghijklmnopabcdefghijklmnop";
const base = "chrome-extension://" + ext + "/";
const site = "https://reader.example";
const api = "https://provider.example";
const granted = new Set();
const scripts = new Map();
const tabs = new Map();
const deliveries = [];
const event = () => ({ addListener(fn) { this.listener = fn; } });
function storage() {
  return {
    values: {}, access: null,
    async setAccessLevel({ accessLevel }) { this.access = accessLevel; },
    async get(key) { return key == null ? { ...this.values } : { [key]: this.values[key] }; },
    async set(items) { Object.assign(this.values, items); },
    async remove(key) { delete this.values[key]; }
  };
}
globalThis.chrome = {
  runtime: { id: ext, getURL: path => base + path, onMessage: event(), onInstalled: event(), onStartup: event() },
  storage: { local: storage(), session: storage() },
  permissions: {
    onRemoved: event(), async contains({ origins }) { return origins.every(origin => granted.has(origin)); },
    async remove({ origins }) { for (const origin of origins) granted.delete(origin); }
  },
  scripting: {
    async executeScript({ target }) {
      const tab = tabs.get(target.tabId);
      return [{ documentId: tab.doc, result: new URL(tab.url).origin }];
    },
    async getRegisteredContentScripts({ ids } = {}) {
      return [...scripts.values()].filter(script => !ids || ids.includes(script.id));
    },
    async registerContentScripts(list) { list.forEach(script => scripts.set(script.id, script)); },
    async unregisterContentScripts({ ids }) { ids.forEach(id => scripts.delete(id)); }
  },
  tabs: {
    onRemoved: event(), async get(id) { return tabs.get(id); },
    async sendMessage(id, message, options) {
      deliveries.push({ id, ...message, ...options });
      return { mode: message.mode ?? "original", error: "" };
    }
  },
  contextMenus: { onClicked: event() },
  commands: { onCommand: event() }
};
await import("../background.js");

const settings = { protocol: "openai", baseUrl: api, model: "fixture", apiKey: "fixture-only" };
const source = (id, doc) => ({ id: ext, frameId: 0, tab: { id }, documentId: doc, url: site + "/article" });
const options = { id: ext, url: base + "options.html" };
const popup = { id: ext, url: base + "popup.html" };
const payload = { items: [{ id: "1", text: "Current loop" }] };
const send = (sender, type, args = {}) => new Promise(resolve =>
  chrome.runtime.onMessage.listener({ type, ...args }, sender, resolve));
let count;
beforeEach(() => {
  count = 0;
  globalThis.fetch = async () => {
    count++;
    return Response.json({ choices: [{ message: { content: "电流环" } }] });
  };
  scripts.clear(); granted.clear(); tabs.clear(); deliveries.length = 0;
  chrome.storage.local.values = { config: settings };
  chrome.storage.session.values = {};
  granted.add(api + "/*");
  for (const id of [1, 2]) tabs.set(id, { id, url: site + "/article", doc: "doc" + id });
});

test("only trusted settings pages can read, save or clear credentials", async () => {
  assert.equal(chrome.storage.local.access, "TRUSTED_CONTEXTS");
  for (const sender of [source(1, "doc1"), popup, { id: "different", url: base+"options.html" }]) {
    for (const type of ["config.get", "config.clear", "config.save"]) {
      const result = await send(sender, type, { config: settings });
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes(settings.apiKey));
    }
  }
  assert.equal((await send(options, "config.get")).data.config.apiKey, settings.apiKey);
  assert.equal((await send(options, "config.clear")).ok, true);
  assert.equal((await send(options, "config.get")).data.config, null);
});

test("changing API domains cannot send the saved key to the new host", async () => {
  const changed = { ...settings, baseUrl: "https://new.example/api" };
  granted.add("https://new.example/*");
  assert.equal((await send(options, "config.test", { config: changed })).ok, false);
  assert.equal(count, 0);
});

test("manual translation is scoped to the current document after a toolbar action", async () => {
  assert.equal((await send(source(1, "doc1"), "api.translate", { payload })).ok, false);
  assert.equal((await send(popup, "popup.mode", { tabId: 1, mode: "bilingual" })).ok, true);
  assert.equal((await send(source(1, "doc1"), "api.translate", { payload })).ok, true);
  assert.equal((await send(source(1, "reloaded"), "api.translate", { payload })).ok, false);
  assert.equal((await send(source(2, "doc2"), "api.translate", { payload })).ok, false);
  assert.equal(count, 1);
});

test("Alt+A starts full-page translation on the command's tab without granting future site access", async () => {
  await chrome.commands.onCommand.listener("translate-full-page", tabs.get(2));
  assert.ok(deliveries.some(d => d.id === 2 && d.documentId === "doc2" && d.type === "reader.scope" && d.scope === "full"));
  assert.equal((await send(source(2, "doc2"), "api.translate", { payload })).ok, true);
  assert.equal((await send(source(1, "doc1"), "api.translate", { payload })).ok, false);
  assert.equal(granted.has(site + "/*"), false);
});

test("the shortcut opens settings when unconfigured and skips restricted pages", async () => {
  chrome.storage.local.values = {};
  let optionsOpened = 0;
  chrome.runtime.openOptionsPage = async () => { optionsOpened++; };
  await chrome.commands.onCommand.listener("translate-full-page", {id:1, url:"edge://settings"});
  await chrome.commands.onCommand.listener("translate-full-page", tabs.get(1));
  assert.equal(optionsOpened, 1);
  assert.equal(deliveries.length, 0);
});

test("disabling one rule stops every automatic document and rejects new batches", async () => {
  granted.add(site+"/*");
  assert.equal((await send(popup, "popup.auto", { tabId: 1, enabled: true })).ok, true);
  assert.equal((await send(source(2, "doc2"), "auto.start")).ok, true);
  assert.equal((await send(source(2, "doc2"), "api.translate", { payload })).ok, true);
  assert.equal((await send(popup, "popup.auto", { tabId: 1, enabled: false })).ok, true);
  assert.deepEqual(scripts.size, 0);
  assert.ok(deliveries.some(d => d.id === 2 && d.documentId === "doc2" && d.mode === "original"));
  for (const id of [1, 2]) {
    assert.equal((await send(source(id, "doc"+id), "api.translate", { payload })).ok, false);
  }
  assert.equal(count, 1);
});
