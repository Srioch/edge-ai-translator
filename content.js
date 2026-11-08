(() => {
  "use strict";
  if (globalThis.__edgeAiReaderInstalled) return;
  globalThis.__edgeAiReaderInstalled = true;

  const OWN = "[data-eat-owned]";
  const BLOCK = "p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,figcaption,td,th";
  const CANDIDATE = BLOCK + ",div,section,article,nav,aside,header,footer";
  const SCAN = CANDIDATE + ",a[href]";
  const ROOTS = "main,[role='main'],article";
  const CHROME = "nav,aside,footer,body > header,[role='navigation'],[role='menu'],[role='banner'],[role='contentinfo']";
  const HEADING = "h1,h2,h3,h4,h5,h6";
  const MATH = "math,mjx-container,.katex,.MathJax,[role='math']";
  const PROTECTED = "code,kbd,samp,var," + MATH;
  const EDIT = "input,textarea,select,button,form,[contenteditable]:not([contenteditable='false']),[role='textbox']";
  const SKIP = [OWN, EDIT, PROTECTED, "pre", "script", "style", "noscript", "[hidden]",
    "[aria-hidden='true']", "[translate='no']", ".notranslate", "svg", "canvas", "iframe"].join(",");
  const OMIT_BLOCK = "pre,img,video,audio,canvas,iframe,button,input,textarea,select,[contenteditable]:not([contenteditable='false'])";
  const MODES = new Set(["original", "bilingual", "translation"]);
  const records = new Map();
  const visible = new Set();
  const near = new Set();
  const cache = new Map();
  const glossary = new Map();
  let mode = "original";
  let target = "简体中文";
  let route = pageKey();
  let epoch = 0;
  let active = 0;
  let firstBatch = true;
  let scope = "main";
  let hasMain = false;
  let halted = "";
  let retryAction;
  let timer;
  let notice;
  let card;
  let selectionSerial = 0;
  let selectionPending = "";
  let lastSelection;

  function pageKey() {
    return location.pathname + location.search + (/^#(?:\/|!)/.test(location.hash) ? location.hash : "");
  }
  function clean(text) {
    return (text || "").replace(/\s+/gu, " ").trim();
  }
  function owned(element, name) {
    element.setAttribute("data-eat-owned", "");
    element.setAttribute("data-eat-" + name, "");
    return element;
  }
  function labelElement(name, text) {
    const el = document.createElement(name);
    el.textContent = text;
    return el;
  }
  const styles = owned(document.createElement("style"), "style");
  styles.textContent = `
    [data-eat-source-hidden] { font-size:0 !important; line-height:0 !important; letter-spacing:0 !important; word-spacing:0 !important; text-indent:0 !important; }
    [data-eat-source-hidden] > :not([data-eat-translation]) { display:none !important; }
    [data-eat-source-hidden]::first-letter { font-size:0 !important; }
    [data-eat-source-hidden]::before, [data-eat-source-hidden]::after { display:none !important; }
  `;
  function installStyle(root, style) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style.textContent);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
  installStyle(document, styles);

  function eligible(el) {
    if (!el?.matches(SCAN) || el.closest(SKIP) || el.querySelector(OMIT_BLOCK)) return false;
    if (scope === "main" && (el.closest(CHROME) || (hasMain && !el.closest(ROOTS)))) return false;
    // Inline links stay inside their paragraph. Standalone menu links become
    // their own units in whole-page mode, keeping their original click target.
    if (el.matches("a")) {
      if (scope !== "full" || el.closest(BLOCK) || !el.closest(CHROME)) return false;
      const parent = el.parentElement?.closest(CANDIDATE);
      return !parent || !eligible(parent);
    }
    if (scope === "full" && el.closest(CHROME) && !el.matches(BLOCK) && el.querySelector("a[href]") &&
        ![...el.childNodes].some(node => node.nodeType === 3 && clean(node.textContent))) return false;
    // Nested containers belong to their smallest readable block (e.g. a paragraph inside a list item).
    for (const child of el.children) {
      if (!child.matches(OWN) && (child.matches(CANDIDATE) || child.querySelector(CANDIDATE))) return false;
    }
    if (!el.matches(BLOCK) && ![...el.childNodes].some(n => n.nodeType === 3 && clean(n.nodeValue))) {
      return [...el.children].some(c => !c.matches(OWN) && !c.matches(SKIP) && clean(c.textContent));
    }
    return true;
  }
  function blockFor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (eligible(node)) return node;
    }
    return null;
  }
  function compile(el) {
    const links = new Map();
    const protectedNodes = new Map();
    if (el.closest(SKIP) || !el.checkVisibility({visibilityProperty: true})) return {text: "", links, protectedNodes};
    const masking = el.hasAttribute("data-eat-source-hidden");
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.matches(OWN + ",[hidden],[aria-hidden='true'],[translate='no'],.notranslate") ||
          node.style?.display === "none" || node.style?.visibility === "hidden") return "";
      // In translation-only mode our CSS temporarily hides the source children.
      // Retain their last observed site visibility while the mask is applied.
      if (!masking) {
        const css = getComputedStyle(node);
        hiddenBySite.set(node, css.display === "none" || css.visibility === "hidden" || css.contentVisibility === "hidden");
      }
      if (hiddenBySite.get(node)) return "";
      if (node.matches(PROTECTED)) {
        const id = String(protectedNodes.size + 1);
        protectedNodes.set(id, node);
        return "⟦K" + id + "⟧";
      }
      if (node.matches(SKIP)) return "";
      if (node.matches("br")) return " ";
      if (node.matches("a")) {
        const id = String(links.size + 1);
        links.set(id, node);
        return "⟦A" + id + "⟧" + Array.from(node.childNodes, walk).join("") + "⟦/A" + id + "⟧";
      }
      return Array.from(node.childNodes, walk).join("");
    }
    const text = clean(Array.from(el.childNodes, walk).join(""));
    return {text, links, protectedNodes};
  }
  const hiddenBySite = new WeakMap();
  function shouldTranslate(text) {
    const sample = text.replace(/⟦\/?[AK]\d+⟧/g, "");
    if (!/\p{L}/u.test(sample)) return false;
    if (!/简体中文|繁體中文|中文|chinese|^zh\b/i.test(target)) return true;
    if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(sample)) return true;
    const han = (sample.match(/\p{Script=Han}/gu) || []).length;
    return han === 0 || han * 3 < (sample.match(/\p{L}/gu) || []).length;
  }
  function splitParts(text) {
    if (text.length <= 2400) return [text];
    const result = [];
    let part = "";
    // Keep protected/link tokens whole while splitting long paragraphs for small API batches.
    const units = text.match(/⟦A(\d+)⟧[\s\S]*?⟦\/A\1⟧|⟦K\d+⟧|[^\s⟦]+|\s+|./gu) || [];
    function add(unit) {
      if (part && part.length + unit.length > 2400) {
        if (part.trim()) result.push(part.trim());
        part = "";
      }
      part += unit;
    }
    for (const unit of units) {
      if (unit.length <= 2400 || unit.startsWith("⟦")) add(unit);
      else {
        for (const letter of unit) add(letter);
      }
    }
    if (part.trim()) result.push(part.trim());
    return result;
  }

  function recordFor(el) {
    let rec = records.get(el);
    if (!rec) {
      rec = {el, parts: [], answers: [], pending: new Map(), hover: false};
      records.set(el, rec);
      intersection.observe(el);
      lookahead.observe(el);
    }
    return rec;
  }
  function clearOutput(rec) {
    rec.el.removeAttribute("data-eat-source-hidden");
    rec.host?.remove();
    rec.host = null;
  }
  function refresh(rec) {
    const source = compile(rec.el);
    const presentation = JSON.stringify([
      [...source.links.values()].map(a => [a.href, a.target]),
      [...source.protectedNodes.values()].map(n => [n.getAttribute("aria-label"), n.textContent])
    ]);
    if (rec.source?.text !== source.text) {
      clearOutput(rec);
      rec.parts = shouldTranslate(source.text) ? splitParts(source.text) : [];
      rec.answers = Array(rec.parts.length);
      rec.pending.clear();
    } else if (rec.presentation !== presentation ||
        [...source.links].some(([id, a]) => a !== rec.source.links.get(id))) {
      clearOutput(rec);
    }
    rec.presentation = presentation;
    rec.source = source;
  }
  function forget(rec) {
    clearOutput(rec);
    intersection.unobserve(rec.el);
    lookahead.unobserve(rec.el);
    visible.delete(rec.el);
    near.delete(rec.el);
    hovered.delete(rec.el);
    records.delete(rec.el);
  }
  function consider(el) {
    if (!eligible(el)) {
      if (records.has(el)) forget(records.get(el));
      return;
    }
    recordFor(el);
  }
  function scan(root) {
    if (!(root instanceof Element) || root.closest(SKIP)) return;
    if (root.matches(SCAN)) consider(root);
    for (const el of root.querySelectorAll(SCAN)) consider(el);
  }
  function rescan() {
    const roots = [...document.querySelectorAll(ROOTS)].filter(el => !el.closest(SKIP) &&
      (el.getClientRects().length || getComputedStyle(el).display === "contents"));
    hasMain = roots.length > 0;
    for (const rec of records.values()) if (!eligible(rec.el)) forget(rec);
    if (mode === "original") return;
    if (scope === "main" && hasMain) {
      for (const root of roots) if (!root.parentElement?.closest(ROOTS)) scan(root);
    } else scan(document.body);
  }
  function syncRoute() {
    if (route === pageKey()) return;
    route = pageKey();
    epoch++;
    firstBatch = true;
    for (const rec of Array.from(records.values())) forget(rec);
    cache.clear();
    glossary.clear();
    clearError();
    closeCard();
    lastSelection = null;
    rescan();
    schedule();
  }
  function enclosingSection(el) {
    return el.closest("article,main,section,[role='main']") || document.body;
  }
  function contextFor(el) {
    const root = enclosingSection(el);
    let heading = "";
    for (const h of root.querySelectorAll(HEADING)) {
      if (h === el || !(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (!h.closest(SKIP) && (scope === "full" || !h.closest(CHROME))) heading = compile(h).text;
    }
    function siblingContext(direction) {
      for (let node = el; node && node !== root; node = node.parentElement) {
        let sibling = node[direction];
        for (let i = 0; sibling && i < 5; i++, sibling = sibling[direction]) {
          if (sibling.closest(SKIP) || !sibling.checkVisibility({visibilityProperty: true})) continue;
          const leaves = eligible(sibling) ? [sibling] : Array.from(sibling.querySelectorAll(BLOCK)).filter(eligible);
          const block = direction === "previousElementSibling" ? leaves.at(-1) : leaves[0];
          if (block) {
            const text = compile(block).text.replace(/⟦\/?[AK]\d+⟧/g, "");
            return direction === "previousElementSibling" ? text.slice(-240) : text.slice(0, 240);
          }
        }
      }
      return "";
    }
    return {heading: heading.slice(0, 160), before: siblingContext("previousElementSibling"), after: siblingContext("nextElementSibling")};
  }
  function cacheKey(kind, item) {
    return JSON.stringify([target, kind, document.title, item.heading, item.before, item.text, item.after]);
  }
  function remember(key, value) {
    cache.set(key, value);
    if (cache.size > 800) cache.delete(cache.keys().next().value);
  }

  // Construct translated fragments from text and trusted source nodes. No model HTML is parsed.
  function richText(source, text) {
    const fragment = document.createDocumentFragment();
    let parent = fragment;
    for (const token of text.split(/(⟦\/?[AK]\d+⟧)/g)) {
      const match = /^⟦(\/?)?([AK])(\d+)⟧$/.exec(token);
      if (!match) { parent.append(document.createTextNode(token)); continue; }
      const [, end, type, id] = match;
      if (type === "A") {
        if (end) { parent = fragment; continue; }
        const original = source.links.get(id);
        if (!original) continue;
        const a = document.createElement("a");
        if (/^(https?:|mailto:|tel:)/i.test(original.href || "")) a.href = original.href;
        if (original.target) a.target = original.target;
        a.rel = "noopener noreferrer";
        a.addEventListener("click", e => {
          if (!e.isTrusted) { e.preventDefault(); return; }
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          original.click();
        });
        fragment.append(a);
        parent = a;
      } else {
        const node = source.protectedNodes.get(id);
        if (!node) continue;
        const math = node.matches("math") ? node : node.querySelector("math");
        if (math) parent.append(copyMath(math));
        else {
          const formatted = labelElement(node.matches("code,kbd,samp,var") ? node.localName : "span",
            node.getAttribute("aria-label") || node.textContent);
          parent.append(formatted);
        }
      }
    }
    return fragment;
  }
  function copyMath(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    const tags = /^(math|m(row|i|n|o|text|frac|sqrt|root|sub|sup|subsup|under|over|underover|table|tr|td|space|style|fenced|padded|phantom|multiscripts|prescripts)|none|semantics)$/;
    if (!tags.test(node.localName)) return document.createTextNode("");
    const copy = document.createElementNS("http://www.w3.org/1998/Math/MathML", node.localName);
    for (const attr of ["display", "mathvariant", "stretchy", "fence", "accent", "accentunder"]) {
      if (node.hasAttribute(attr)) copy.setAttribute(attr, node.getAttribute(attr));
    }
    for (const child of node.childNodes) copy.append(copyMath(child));
    return copy;
  }
  function render(rec) {
    const complete = rec.parts.length && rec.parts.every((_, i) => typeof rec.answers[i] === "string");
    if (!complete || (mode === "original" && !rec.hover)) { clearOutput(rec); return; }
    if (!rec.host?.isConnected) {
      rec.el.removeAttribute("data-eat-source-hidden");
      const font = getComputedStyle(rec.el);
      const host = owned(document.createElement("span"), "translation");
      host.lang = /中文|^zh\b|Chinese/i.test(target) ? "zh" : "";
      host.style.setProperty("display", "block", "important");
      host.style.setProperty("font-size", font.fontSize, "important");
      host.style.setProperty("line-height", font.lineHeight, "important");
      host.style.setProperty("letter-spacing", font.letterSpacing, "important");
      host.style.setProperty("word-spacing", font.wordSpacing, "important");
      const shadow = host.attachShadow({mode: "open"});
      const css = document.createElement("style");
      css.textContent = `
        :host { text-indent:0; overflow-wrap:anywhere; }
        .text { display:block; margin-block:.32em .12em; }
        :host([data-only]) .text { margin:0; }
        a { color:inherit; text-decoration:underline; cursor:pointer; }
        code,kbd,samp { font: .92em ui-monospace, monospace; }
      `;
      const body = document.createElement("span");
      body.className = "text";
      body.append(richText(rec.source, rec.answers.join(" ")));
      installStyle(shadow, css);
      shadow.append(body);
      rec.el.append(host);
      rec.host = host;
    }
    const only = mode === "translation";
    rec.host.toggleAttribute("data-only", only);
    rec.el.toggleAttribute("data-eat-source-hidden", only);
  }

  async function translate(kind, items) {
    const response = await chrome.runtime.sendMessage({type: "api.translate", payload: {
      title: clean(document.title).slice(0, 160), target, kind, items,
      terms: Array.from(glossary, ([source, value]) => ({source, target: value})).slice(-32)
    }});
    if (!response?.ok) throw new Error(response?.error || "连接中断，服务商是否收到请求暂时未知。");
    if (!Array.isArray(response.data?.translations)) throw new Error("服务商返回的译文格式不正确。");
    const mapped = new Map(response.data.translations.map(t => [t.id, t.text]));
    if (response.data.translations.length !== items.length || !items.every(i => typeof mapped.get(i.id) === "string" && mapped.get(i.id).trim())) {
      throw new Error("译文和请求段落未能一一对应。");
    }
    return {mapped, terms: response.data.terms || []};
  }
  function addTerms(terms) {
    for (const entry of terms) {
      if (typeof entry.source === "string" && typeof entry.target === "string" && !glossary.has(entry.source)) {
        glossary.set(entry.source, entry.target);
        if (glossary.size > 128) glossary.delete(glossary.keys().next().value);
      }
    }
  }
  function schedule() {
    if (timer || active >= 3 || halted) return;
    timer = setTimeout(() => { timer = null; pump(); }, 0);
  }
  function nextBatch(limit) {
    const candidates = [...new Set([...visible, ...near, ...hovered])].map(el => records.get(el))
      .filter(rec => rec?.el.isConnected && (rec.hover || mode !== "original"));
    function priority(rec) { return rec.hover ? 0 : visible.has(rec.el) ? 1 : 2; }
    candidates.sort((a, b) => priority(a) - priority(b) || a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    const tasks = [];
    let chars = 0;
    for (const rec of candidates) {
      if (!rec.el.checkVisibility({visibilityProperty: true})) continue;
      refresh(rec);
      if (!rec.parts.length || rec.parts.every((_, i) => rec.answers[i])) { render(rec); continue; }
      if (rec.parts.every((_, i) => rec.answers[i] || rec.pending.has(i))) continue;
      const context = contextFor(rec.el);
      for (let i = 0; i < rec.parts.length; i++) {
        if (rec.answers[i] || rec.pending.has(i)) continue;
        const item = {id: String(tasks.length + 1), text: rec.parts[i], ...context};
        const key = cacheKey("paragraph", item);
        if (cache.has(key)) { rec.answers[i] = cache.get(key); continue; }
        if (tasks.length && chars + item.text.length > 5000) break;
        const task = {rec, i, item, key, sourceText: rec.source.text};
        rec.pending.set(i, task);
        tasks.push(task);
        chars += item.text.length;
        if (tasks.length === limit) break;
      }
      render(rec);
      if (tasks.length === limit || chars >= 4800) break;
    }
    return tasks;
  }
  function pump() {
    syncRoute();
    while (active < 3 && !halted) {
      const tasks = nextBatch(firstBatch ? 1 : 6);
      if (!tasks.length) break;
      firstBatch = false;
      active++;
      void runBatch(tasks);
    }
  }
  async function runBatch(tasks) {
    const started = epoch;
    try {
      const answer = await translate("paragraph", tasks.map(t => t.item));
      syncRoute();
      if (started !== epoch) return;
      addTerms(answer.terms);
      for (const t of tasks) {
        remember(t.key, answer.mapped.get(t.item.id));
        if (records.get(t.rec.el) !== t.rec || !t.rec.el.isConnected) continue;
        refresh(t.rec);
        if (t.rec.source.text !== t.sourceText) continue;
        t.rec.answers[t.i] = answer.mapped.get(t.item.id);
        render(t.rec);
      }
    } catch (e) {
      syncRoute();
      if (started === epoch && tasks.some(t => records.has(t.rec.el) && (mode !== "original" || t.rec.hover))) {
        setError(e.message, schedule);
      }
    } finally {
      for (const task of tasks) if (task.rec.pending.get(task.i) === task) task.rec.pending.delete(task.i);
      active--;
      schedule();
    }
  }
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    schedule();
  });
  const lookahead = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) near.add(entry.target);
      else near.delete(entry.target);
    }
    schedule();
  }, {rootMargin: "0px 0px 320px 0px"});
  const hovered = new Set();
  const observer = new MutationObserver(changes => {
    syncRoute();
    if (mode === "original" && !records.size) return;
    const changed = new Set();
    for (const change of changes) {
      const el = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (!el || el.closest(OWN)) continue;
      if (change.type === "childList") {
        const touched = [...change.addedNodes, ...change.removedNodes];
        if (touched.length && touched.every(n => n.nodeType === 1 && n.matches(OWN))) continue;
        if (mode !== "original") {
          const structural = touched.some(n => n.nodeType === 1 && (n.matches(ROOTS) || n.querySelector(ROOTS)));
          if (structural) rescan();
          else for (const node of change.addedNodes) scan(node);
        }
        for (const node of change.removedNodes) {
          if (node.nodeType !== 1) continue;
          for (const rec of records.values()) if (!rec.el.isConnected) forget(rec);
          break;
        }
      }
      const previous = el.closest(CANDIDATE);
      if (previous && records.has(previous)) changed.add(previous);
      const current = blockFor(el);
      if (current && (mode !== "original" || records.has(current))) changed.add(current);
    }
    for (const el of changed) {
      consider(el);
      const rec = records.get(el);
      if (rec?.source) { refresh(rec); render(rec); }
    }
    schedule();
  });
  observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "href", "target", "translate", "contenteditable", "aria-label"]});
  addEventListener("popstate", syncRoute);
  addEventListener("hashchange", syncRoute);

  function panel(name) {
    const host = owned(document.createElement("div"), name);
    host.style.cssText = "all:initial!important;display:block!important;position:fixed!important;z-index:2147483647!important;color-scheme:normal!important";
    const shadow = host.attachShadow({mode: "open"});
    const css = document.createElement("style");
    css.textContent = `
      .box { box-sizing:border-box; max-width:min(360px,calc(100vw - 20px)); display:grid; gap:8px;
        background:#fff; color:#172b36; border:1px solid #b9cbd1; border-radius:10px;
        box-shadow:0 5px 22px #13273026; padding:12px 14px; font:14px/1.55 system-ui,sans-serif; }
      .title { display:flex; align-items:center; justify-content:space-between; gap:12px; font-weight:650; }
      .body { white-space:pre-wrap; overflow-wrap:anywhere; max-height:min(45vh,280px); overflow:auto; }
      button { font:inherit; color:#164e63; border:1px solid #c6d6db; border-radius:5px; background:#f5f9fa; cursor:pointer; padding:2px 8px; }
    `;
    const box = document.createElement("div");
    box.className = "box";
    const title = document.createElement("div");
    title.className = "title";
    const body = document.createElement("div");
    body.className = "body";
    box.append(title, body);
    installStyle(shadow, css);
    shadow.append(box);
    document.documentElement.append(host);
    return {host, title, body, box};
  }
  function button(label, action) {
    const btn = labelElement("button", label);
    btn.type = "button";
    btn.addEventListener("click", e => { if (e.isTrusted) action(); });
    return btn;
  }
  function clearError() {
    halted = "";
    retryAction = null;
    notice?.host.remove();
    notice = null;
  }
  function retry() {
    const action = retryAction;
    clearError();
    action?.();
    schedule();
  }
  function setError(text, action) {
    if (halted) return;
    halted = text || "翻译失败，已暂停。";
    retryAction = action;
    notice = panel("error");
    notice.host.style.setProperty("right", "12px", "important");
    notice.host.style.setProperty("bottom", "12px", "important");
    notice.title.append(labelElement("span", "翻译已暂停"), button("关闭", () => notice?.host.remove()));
    notice.body.textContent = halted;
    notice.box.append(button("手动重试", retry));
  }
  function closeCard() {
    selectionSerial++;
    selectionPending = "";
    card?.host.remove();
    card = null;
  }
  function placeCard(rect) {
    if (!card) return;
    const view = card.host.getBoundingClientRect();
    const top = rect.bottom + view.height + 8 < innerHeight ? rect.bottom + 8 : rect.top - view.height - 8;
    card.host.style.setProperty("left", Math.max(8, Math.min(rect.left, innerWidth - view.width - 8)) + "px", "important");
    card.host.style.setProperty("top", Math.max(8, Math.min(top, innerHeight - view.height - 8)) + "px", "important");
  }
  function liveSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    if (!el || el.closest(SKIP) || start?.closest(SKIP) || end?.closest(SKIP)) return null;
    for (const protectedNode of el.querySelectorAll(SKIP)) {
      if (range.intersectsNode(protectedNode)) return null;
    }
    return {text: clean(sel.toString()), el: blockFor(el) || el, rect: range.getBoundingClientRect(), route};
  }
  document.addEventListener("contextmenu", e => {
    if (!e.isTrusted) return;
    lastSelection = e.target instanceof Element && !e.target.closest(SKIP) ? liveSelection() : null;
  }, true);
  async function selectText(text) {
    syncRoute();
    text = clean(text);
    const live = liveSelection();
    const active = window.getSelection();
    const sel = active && !active.isCollapsed ? live : lastSelection;
    if (!sel || sel.text !== text || sel.route !== route || !sel.el.isConnected ||
        sel.el.closest(SKIP) || !text || document.activeElement?.closest(EDIT)) return;
    const context = contextFor(sel.el);
    const paragraph = compile(sel.el).text;
    const offset = paragraph.indexOf(text);
    if (offset >= 0) {
      context.before = (context.before + " " + paragraph.slice(0, offset)).slice(-240);
      context.after = (paragraph.slice(offset + text.length) + " " + context.after).slice(0, 240);
    }
    const item = {id: "1", text, ...context};
    const key = cacheKey("selection", item);
    if (selectionPending === key) return;
    closeCard();
    lastSelection = sel;
    const serial = selectionSerial;
    const started = epoch;
    card = panel("card");
    card.title.append(labelElement("span", "划词翻译"), button("关闭", closeCard));
    card.body.textContent = cache.get(key) || halted || "正在翻译…";
    placeCard(sel.rect);
    if (cache.has(key) || halted) return;
    selectionPending = key;
    try {
      const answer = await translate("selection", [item]);
      syncRoute();
      if (started !== epoch) return;
      remember(key, answer.mapped.get("1"));
      addTerms(answer.terms);
      if (serial === selectionSerial && card) { card.body.textContent = answer.mapped.get("1"); placeCard(sel.rect); }
    } catch (e) {
      syncRoute();
      if (started !== epoch || serial !== selectionSerial) return;
      if (card) { card.body.textContent = e.message; placeCard(sel.rect); }
      setError(e.message, () => void selectText(text));
    } finally {
      if (serial === selectionSerial) selectionPending = "";
    }
  }
  document.addEventListener("pointerdown", e => {
    if (card && !e.composedPath().includes(card.host) && !e.composedPath().includes(notice?.host)) closeCard();
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeCard(); }, true);
  let hoverTimer;
  let hoverTarget;
  let pointerTarget;
  function hover(altDown, node) {
    const el = altDown && node && !node.closest(SKIP) ? blockFor(node) : null;
    if (el === hoverTarget) return;
    clearTimeout(hoverTimer);
    hoverTarget = el;
    if (!el) return;
    hoverTimer = setTimeout(() => {
      if (!el.isConnected) return;
      syncRoute();
      const rec = recordFor(el);
      rec.hover = true;
      hovered.add(el);
      refresh(rec);
      render(rec);
      schedule();
    }, 200);
  }
  document.addEventListener("pointermove", e => {
    if (!e.isTrusted) return;
    pointerTarget = e.target instanceof Element ? e.target : null;
    hover(e.altKey, pointerTarget);
  }, {passive: true});
  document.addEventListener("keydown", e => {
    if (e.isTrusted && e.key === "Alt") hover(true, pointerTarget);
  });
  document.documentElement.addEventListener("pointerleave", e => {
    if (e.isTrusted) { pointerTarget = null; hover(false, null); }
  });
  document.addEventListener("keyup", e => {
    if (e.isTrusted && e.key === "Alt") { clearTimeout(hoverTimer); hoverTarget = null; }
  });

  function setMode(next, language) {
    syncRoute();
    const newTarget = typeof language === "string" && language.trim() ? language.trim() : target;
    if (newTarget !== target) {
      epoch++; target = newTarget;
      for (const rec of records.values()) forget(rec);
      cache.clear(); glossary.clear(); clearError(); closeCard();
    }
    mode = next;
    if (next !== "original") rescan();
    else hovered.clear();
    for (const rec of records.values()) {
      if (next === "original") rec.hover = false;
      render(rec);
    }
    schedule();
  }
  function status() {
    return {ok: true, mode, scope, paused: Boolean(halted), error: halted, pending: active > 0,
      translated: [...records.values()].filter(rec => rec.host?.isConnected).length};
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "reader.mode" && MODES.has(message.mode)) setMode(message.mode, message.target);
    else if (message?.type === "reader.scope" && ["main", "full"].includes(message.scope)) {
      scope = message.scope;
      if (mode === "original") setMode("bilingual");
      else { rescan(); schedule(); }
    }
    else if (message?.type === "reader.selection") void selectText(message.text);
    else if (message?.type === "reader.retry") retry();
    else if (message?.type !== "reader.status") return;
    respond(status());
  });
})();
