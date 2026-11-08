import {presets, originPattern} from "./lib/providers.js";

const byId = id => document.getElementById(id);
const form = byId("config-form");
const provider = byId("provider");
const baseUrl = byId("base-url");
const model = byId("model");
const key = byId("api-key");
const workspaceId = byId("workspace-id");
const workspaceField = byId("workspace-field");
const save = byId("save");
const test = byId("test");
const clear = byId("clear-config");
const notice = byId("config-notice");
let keyOrigin = "";
let configured = false;
let busy = false;

function preset() {
  return presets.find(entry => entry.id === provider.value);
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.origin : "";
  } catch {
    return "";
  }
}

function show(message = "", tone = "info") {
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

function mark(state) {
  const label = byId("save-state");
  label.textContent = {saved: "已保存", fresh: "尚未配置", dirty: "有未保存的更改"}[state];
  label.dataset.state = state;
}

function maskKey() {
  key.type = "password";
  byId("reveal-key").textContent = "显示";
  byId("reveal-key").setAttribute("aria-label", "显示 Key");
  byId("reveal-key").setAttribute("aria-pressed", "false");
}

function clearMismatchedKey() {
  if (key.value && validOrigin(baseUrl.value) !== keyOrigin) {
    key.value = "";
    keyOrigin = "";
    maskKey();
    show("服务地址已更换，请重新输入该服务商的 Key。");
  }
}

function updateProviderFields() {
  const native = preset().protocol !== "openai";
  baseUrl.readOnly = native;
  byId("address-help").textContent = native ? "此原生接口使用服务商的官方地址。" : "填写基础地址，例如 https://api.example.com/v1。";
  workspaceField.hidden = preset().protocol !== "claude";
  if (workspaceField.hidden) workspaceId.value = "";
}

function setBusy(value) {
  busy = value;
  for (const item of [save, test, clear, provider, baseUrl, model, key, workspaceId, byId("reveal-key")]) {
    item.disabled = value;
  }
}

function fill(config) {
  const selected = presets.find(entry => entry.id === config?.presetId) ||
    (config && presets.find(entry => entry.protocol === config.protocol && entry.baseUrl === config.baseUrl)) ||
    (config && presets.find(entry => entry.id === "custom")) || presets[0];
  provider.value = selected.id;
  baseUrl.value = config?.baseUrl ?? selected.baseUrl;
  model.value = config?.model ?? selected.model;
  key.value = config?.apiKey ?? "";
  keyOrigin = validOrigin(baseUrl.value);
  workspaceId.value = config?.workspaceId ?? "";
  configured = Boolean(config);
  clear.hidden = !configured;
  maskKey();
  updateProviderFields();
  mark(configured ? "saved" : "fresh");
}

provider.addEventListener("change", () => {
  const selected = preset();
  baseUrl.value = selected.baseUrl;
  model.value = selected.model;
  updateProviderFields();
  show();
  clearMismatchedKey();
  mark("dirty");
});

baseUrl.addEventListener("input", () => {
  show();
  clearMismatchedKey();
  mark("dirty");
});
key.addEventListener("input", () => {
  keyOrigin = key.value ? validOrigin(baseUrl.value) : "";
  show();
  mark("dirty");
});
for (const input of [model, workspaceId]) {
  input.addEventListener("input", () => { mark("dirty"); show(); });
}
byId("reveal-key").addEventListener("click", () => {
  if (key.type === "text") {
    maskKey();
    return;
  }
  key.type = "text";
  byId("reveal-key").textContent = "隐藏";
  byId("reveal-key").setAttribute("aria-label", "隐藏 Key");
  byId("reveal-key").setAttribute("aria-pressed", "true");
});

async function request(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({type, ...fields});
  if (!result?.ok) throw new Error(result?.error || "扩展后台未响应。");
  return result.data;
}

function readConfig() {
  if (!form.reportValidity()) return null;
  const origin = validOrigin(baseUrl.value);
  if (!origin) throw new Error("请填写 HTTPS 基础地址，地址中不能包含账户、查询参数或片段。");
  if (keyOrigin !== origin) {
    clearMismatchedKey();
    throw new Error("请为当前服务地址重新输入 API Key。");
  }
  if (!key.value.trim() || !model.value.trim()) throw new Error("请填写模型名称和 API Key。");
  const config = {
    presetId: provider.value, protocol: preset().protocol, baseUrl: baseUrl.value.trim(),
    model: model.value.trim(), apiKey: key.value.trim()
  };
  if (!workspaceField.hidden && workspaceId.value.trim()) config.workspaceId = workspaceId.value.trim();
  return config;
}

async function submit(type) {
  if (busy) return;
  try {
    const config = readConfig();
    if (!config) return;
    const saving = type === "config.save";
    // request 必须直接由按钮事件触发；网络请求和持久化都在用户授予目的域权限之后。
    const permission = chrome.permissions.request({origins: [originPattern(config.baseUrl)]});
    setBusy(true);
    show(saving ? "正在保存…" : "正在用一条短句测试模型…");
    if (!await permission) throw new Error("需要此服务地址的访问权限才能连接模型。");
    const data = await request(type, {config});
    if (saving) {
      configured = true;
      clear.hidden = false;
      maskKey();
      mark("saved");
      show("设置已保存。打开外文网页，点击段译图标即可翻译。");
    } else {
      const translation = typeof data?.text === "string" ? data.text : "";
      show(translation ? "连接成功。测试译文：" + translation : "连接成功，模型已返回测试译文。");
    }
  } catch (error) {
    show(error.message, "error");
  } finally {
    setBusy(false);
  }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  submit("config.save");
});
byId("clear-cache").addEventListener("click", async () => {
  try {
    await request("config.clearCache");
    show("本机译文缓存已清除。刷新网页后会重新翻译。");
  } catch (error) { show(error.message, "error"); }
});
test.addEventListener("click", () => submit("config.test"));
clear.addEventListener("click", async () => {
  if (busy || !configured || !window.confirm("清除本机保存的服务配置和 API Key？")) return;
  setBusy(true);
  try {
    await request("config.clear");
    fill(null);
    show("本机服务配置和 API Key 已清除。");
  } catch (error) {
    show(error.message, "error");
  } finally {
    setBusy(false);
  }
});

async function start() {
  try {
    setBusy(true);
    for (const entry of presets) provider.add(new Option(entry.label, entry.id));
    const data = await request("config.get");
    fill(data?.config);
    setBusy(false);
  } catch (error) {
    show("读取设置失败，请重新打开设置页。" + error.message, "error");
  }
}
start();
