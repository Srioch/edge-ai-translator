const byId = id => document.getElementById(id);
const modeButtons = [...document.querySelectorAll("[data-mode]")];
const scopeButtons = [...document.querySelectorAll("[data-scope]")];
const auto = byId("auto-site");
const notice = byId("popup-notice");
const retry = byId("retry");
let tabId;
let siteOrigin;
let state;
let busy = false;
let refreshing = false;
let revision = 0;
let actionError = "";

function report(message, tone = "error") {
  notice.textContent = message || "";
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

async function message(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({type, tabId, ...fields});
  if (!result?.ok) throw new Error(result?.error || "扩展后台未响应，请重新打开弹窗。");
  return result.data;
}

function render() {
  if (!state) return;
  const {supported, hasConfig, site, mode, paused, error} = state;
  byId("current-site").textContent = site || (siteOrigin ? new URL(siteOrigin).hostname : "当前页面");
  byId("setup-box").hidden = hasConfig;
  byId("mode-box").hidden = !hasConfig;
  for (const button of modeButtons) {
    button.disabled = busy || !supported || !hasConfig;
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  auto.checked = Boolean(state.auto);
  for (const button of scopeButtons) {
    button.disabled = busy || !supported || !hasConfig;
    button.setAttribute("aria-pressed", String(button.dataset.scope === (state.scope || "main")));
  }
  auto.disabled = busy || !supported || !siteOrigin || !hasConfig;
  retry.hidden = !paused || !supported || !hasConfig;
  retry.disabled = busy;
  const problem = actionError || error;
  const text = problem || (!supported ? "此页面不支持网页翻译。请打开普通网页后使用。" : "");
  report(text || (paused ? "翻译已暂停，可手动重试失败段落。" : ""), problem ? "error" : "info");
}

async function refresh() {
  if (refreshing || busy) return;
  const version = revision;
  refreshing = true;
  try {
    const result = await message("popup.status");
    if (version !== revision) return;
    state = result;
    render();
  } catch (error) {
    if (version === revision) report(error.message);
  } finally {
    refreshing = false;
  }
}

async function act(action) {
  if (busy) return;
  revision++;
  busy = true;
  actionError = "";
  render();
  try {
    await action();
  } catch (error) {
    actionError = error.message;
  } finally {
    busy = false;
    render();
    await refresh();
  }
}

for (const button of modeButtons) {
  button.addEventListener("click", () => act(() => message("popup.mode", {mode: button.dataset.mode})));
}
for (const button of scopeButtons) {
  button.addEventListener("click", () => act(() => message("popup.scope", {scope: button.dataset.scope})));
}
auto.addEventListener("change", () => {
  const enabled = auto.checked;
  act(async () => {
    if (enabled) {
      const granted = await chrome.permissions.request({origins: [siteOrigin + "/*"]});
      if (!granted) throw new Error("未获得此网站的访问权限，自动翻译未开启。");
    }
    await message("popup.auto", {enabled});
  });
});
retry.addEventListener("click", () => act(() => message("popup.retry")));
for (const id of ["open-settings", "connect"]) {
  byId(id).addEventListener("click", async () => {
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch (error) {
      report(error.message);
    }
  });
}

async function start() {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find(cmd => cmd.name === "translate-full-page")?.shortcut;
    if (shortcut) {
      byId("full-shortcut").textContent = shortcut;
      byId("full-shortcut").hidden = false;
    }
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id === undefined) throw new Error("没有可用的当前标签页。");
    tabId = tab.id;
    if (tab.url && /^https?:\/\//i.test(tab.url)) siteOrigin = new URL(tab.url).origin;
    await refresh();
    if (state?.supported && state.hasConfig && state.mode === "original" && !state.paused && !state.error) {
      await act(() => message("popup.mode", {mode: "bilingual"}));
    }
    // 分批翻译可能在弹窗打开后才失败。只刷新状态，避免为查询状态重新提交段落。
    const timer = window.setInterval(refresh, 1400);
    window.addEventListener("pagehide", () => window.clearInterval(timer), {once: true});
  } catch (error) {
    report(error.message);
  }
}
start();
