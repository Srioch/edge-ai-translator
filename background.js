import { originPattern, translateBatch, validateConfig } from "./lib/providers.js";
import { clearTranslations, translateCached } from "./lib/translation-cache.js";

const modes = new Set(["original", "bilingual", "translation"]);
const trustedStorage = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const configPage = chrome.runtime.getURL("options.html");
const popupPage = chrome.runtime.getURL("popup.html");
const selectionMenu = "translate-selection";

function getSite(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    if (url.hostname === "chromewebstore.google.com" ||
        (url.hostname === "microsoftedge.microsoft.com" && url.pathname.startsWith("/addons"))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readConfig() {
  await trustedStorage;
  return (await chrome.storage.local.get("config")).config ?? null;
}

async function checkConfig(config) {
  const clean = validateConfig(config);
  const old = await readConfig();
  if (old && old.apiKey === clean.apiKey && new URL(old.baseUrl).origin !== new URL(clean.baseUrl).origin) {
    throw new Error("服务地址已更换，请填写这个服务商自己的 API Key。");
  }
  if (!await chrome.permissions.contains({ origins: [originPattern(clean.baseUrl)] })) {
    throw new Error("请在设置页允许访问此 API 服务地址。");
  }
  return clean;
}

function readerMessage(tabId, message, documentId) {
  return chrome.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 });
}

async function attachReader(tabId) {
  try {
    return await readerMessage(tabId, { type: "reader.status" });
  } catch {
    // A user gesture grants activeTab on a manually translated site.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
      return await readerMessage(tabId, { type: "reader.status" });
    } catch {
      throw new Error("无法读取此页。请在普通网页上打开扩展，并允许访问当前网站。");
    }
  }
}

// A manual grant belongs to the actual document, not the reusable tab ID. Keep
// it across background worker restarts, but never across browser sessions.
const readerKey = tabId => "reader:" + tabId;

async function rememberReader(tabId, site, documentId, manual) {
  const key = readerKey(tabId);
  await chrome.storage.session.set({ [key]: { tabId, site, documentId, manual } });
}

async function authorizeDocument(tabId, site, manual) {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, func: () => location.origin
  });
  if (frame.result !== site) throw new Error("当前标签页已切换，请重新打开扩展。");
  await rememberReader(tabId, site, frame.documentId, manual);
  return frame.documentId;
}

async function stopAutoReaders(site) {
  const live = Object.values(await chrome.storage.session.get(null));
  for (const doc of live) {
    if (doc.site !== site || doc.manual) continue;
    await chrome.storage.session.remove(readerKey(doc.tabId));
    await readerMessage(doc.tabId, { type: "reader.mode", mode: "original" }, doc.documentId).catch(() => {});
  }
}

async function mayTranslate(sender, site) {
  const key = readerKey(sender.tab.id);
  const doc = (await chrome.storage.session.get(key))[key];
  if (doc?.documentId !== sender.documentId || doc?.site !== site) return false;
  return doc.manual || siteEnabled(site);
}

// A single script per exact site keeps other pages entirely free of readers.
// Encode the origin reversibly (including non-default ports) in the registration.
function registrationId(site) {
  return "site-" + btoa(site).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function enabledSites() {
  await trustedStorage;
  return (await chrome.storage.local.get("autoSites")).autoSites ?? [];
}

async function siteEnabled(site) {
  return Boolean(site && (await enabledSites()).includes(site) &&
    await chrome.permissions.contains({ origins: [site + "/*"] }));
}

async function registerSite(site) {
  const id = registrationId(site);
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length) return;
  await chrome.scripting.registerContentScripts([{
    id, matches: [site + "/*"], js: ["content.js", "auto.js"],
    runAt: "document_idle", persistAcrossSessions: true
  }]);
}

async function unregisterSite(site) {
  const id = registrationId(site);
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length) {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  }
}

// Separate popup windows can change rules concurrently. Serialize their
// read-modify-write operations as well as browser permission revocations.
let ruleQueue = Promise.resolve();
function changeRules(operation) {
  const result = ruleQueue.then(operation);
  ruleQueue = result.catch(() => {});
  return result;
}

async function reconcileSites() {
  const sites = await enabledSites();
  const active = [];
  for (const site of sites) {
    if (await chrome.permissions.contains({ origins: [site + "/*"] })) {
      await registerSite(site);
      active.push(site);
    } else await stopAutoReaders(site);
  }
  const desired = new Set(active.map(registrationId));
  const obsolete = (await chrome.scripting.getRegisteredContentScripts())
    .map(script => script.id).filter(id => id.startsWith("site-") && !desired.has(id));
  if (obsolete.length) await chrome.scripting.unregisterContentScripts({ ids: obsolete });
  if (active.length !== sites.length) await chrome.storage.local.set({ autoSites: active });
}

async function setSite(site, enabled) {
  const sites = new Set(await enabledSites());
  if (enabled) {
    if (!await chrome.permissions.contains({ origins: [site + "/*"] })) throw new Error("未获得本站访问权限。");
    await registerSite(site);
    sites.add(site);
  } else {
    sites.delete(site);
    await unregisterSite(site);
  }
  await chrome.storage.local.set({ autoSites: [...sites] });
  if (!enabled) await stopAutoReaders(site);
  const config = await readConfig();
  if (!enabled && (!config || new URL(config.baseUrl).origin !== site)) {
    await chrome.permissions.remove({ origins: [site + "/*"] });
  }
}

const healthCheck = {
  items: [{ id: "1", text: "The current loop controls motor torque." }],
  title: "Motor control", target: "简体中文", kind: "paragraph"
};

async function handleConfig(message) {
  if (message.type === "config.clearCache") {
    await clearTranslations();
    return {};
  }
  if (message.type === "config.get") return { config: await readConfig() };
  if (message.type === "config.clear") {
    await trustedStorage;
    await chrome.storage.local.remove("config");
    return {};
  }
  const config = await checkConfig(message.config);
  if (message.type === "config.save") {
    await chrome.storage.local.set({ config });
    return {};
  }
  if (message.type === "config.test") {
    const result = await translateBatch(config, healthCheck);
    return { text: result.translations[0].text };
  }
  throw new Error("未知设置操作。");
}

async function applyScope(tabId, site, scope) {
  await attachReader(tabId);
  const doc = await authorizeDocument(tabId, site, !await siteEnabled(site));
  return readerMessage(tabId, { type: "reader.scope", scope }, doc);
}

async function handlePopup(message) {
  const tab = await chrome.tabs.get(message.tabId);
  const site = getSite(tab.url);
  const config = await readConfig();
  if (message.type === "popup.status") {
    const info = { site, supported: Boolean(site), auto: await siteEnabled(site), hasConfig: Boolean(config), mode: "original" };
    if (site) {
      try {
        Object.assign(info, await attachReader(tab.id));
      } catch (error) {
        info.supported = false;
        info.error = error.message;
      }
    }
    return info;
  }
  if (!site) throw new Error("请在普通网页上使用段译。");
  if (message.type === "popup.auto") {
    if (message.enabled && !config) throw new Error("请先在设置里填写 API Key。");
    if (!message.enabled) {
      // Restore before releasing host permission, including pending translations.
      await readerMessage(tab.id, { type: "reader.mode", mode: "original" }).catch(() => {});
    }
    await changeRules(() => setSite(site, Boolean(message.enabled)));
    if (message.enabled && getSite((await chrome.tabs.get(tab.id)).url) === site) {
      await attachReader(tab.id);
      const doc = await authorizeDocument(tab.id, site, false);
      await readerMessage(tab.id, { type: "reader.mode", mode: "bilingual" }, doc);
    }
    return { auto: Boolean(message.enabled) };
  }
  if (message.type === "popup.scope" && ["main", "full"].includes(message.scope)) {
    if (!config) throw new Error("请先在设置里填写 API Key。");
    return applyScope(tab.id, site, message.scope);
  }
  await attachReader(tab.id);
  if (message.type === "popup.mode" && modes.has(message.mode)) {
    if (!config && message.mode !== "original") throw new Error("请先在设置里填写 API Key。");
    const doc = await authorizeDocument(tab.id, site, !await siteEnabled(site));
    return readerMessage(tab.id, { type: "reader.mode", mode: message.mode }, doc);
  }
  if (message.type === "popup.retry") return readerMessage(tab.id, { type: "reader.retry" });
  throw new Error("未知阅读操作。");
}

function senderPage(sender) {
  return (sender.url || "").split(/[?#]/)[0];
}

async function dispatch(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("请求来源无效。");
  if (senderPage(sender) === configPage && message.type?.startsWith("config.")) return handleConfig(message);
  if (senderPage(sender) === popupPage && message.type?.startsWith("popup.")) return handlePopup(message);
  const site = getSite(sender.url);
  if (!site || !sender.tab || sender.frameId !== 0) throw new Error("请从扩展页面操作。");
  const config = await readConfig();
  if (message.type === "auto.start") {
    if (config && await siteEnabled(site)) {
      await rememberReader(sender.tab.id, site, sender.documentId, false);
      await readerMessage(sender.tab.id, { type: "reader.mode", mode: "bilingual" }, sender.documentId);
    }
    return {};
  }
  if (message.type === "api.translate") {
    if (!config) throw new Error("请打开段译设置，填写自己的 API Key。");
    if (!await mayTranslate(sender, site)) throw new Error("此页的翻译权限已关闭。点击段译图标可手动翻译。");
    if (!await chrome.permissions.contains({ origins: [originPattern(config.baseUrl)] })) {
      throw new Error("API 服务地址的权限已撤销，请在设置页重新授权。");
    }
    if (sender.tab.incognito) return translateBatch(config, message.payload);
    const page = new URL(sender.url);
    if (!/^#(?:\/|!)/.test(page.hash)) page.hash = "";
    return translateCached(config, message.payload, page.href);
  }
  throw new Error("未知请求。");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  dispatch(message, sender).then(
    data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message || "操作失败，请重试。" })
  );
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: selectionMenu, title: "翻译选中内容", contexts: ["selection"],
    documentUrlPatterns: ["http://*/*", "https://*/*"]
  }));
  changeRules(reconcileSites);
});
chrome.runtime.onStartup.addListener(() => changeRules(reconcileSites));
chrome.permissions.onRemoved.addListener(() => changeRules(reconcileSites));
chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(readerKey(tabId)));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "translate-full-page") return;
  try {
    const target = tab ?? (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
    if (!Number.isInteger(target?.id)) return;
    const site = getSite(target.url ?? (await chrome.tabs.get(target.id)).url);
    if (!site) return;
    if (!await readConfig()) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    await applyScope(target.id, site, "full");
  } catch {
    // The tab can navigate or close before the activeTab grant is used.
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== selectionMenu || !tab?.id || info.frameId > 0 || info.editable) return;
  try {
    await attachReader(tab.id);
    const site = getSite(info.pageUrl || tab.url);
    const doc = await authorizeDocument(tab.id, site, !await siteEnabled(site));
    await readerMessage(tab.id, { type: "reader.selection", text: info.selectionText }, doc);
  } catch {
    // An inaccessible page cannot display a selection card. Open the extension
    // popup where the status message describes the page restriction.
    await chrome.action.openPopup().catch(() => {});
  }
});
