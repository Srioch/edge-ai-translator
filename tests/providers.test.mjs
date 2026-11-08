import assert from 'node:assert/strict';
import test from 'node:test';
import { originPattern, presets, translateBatch, validateConfig } from '../lib/providers.js';

const key = 'local-test-key';
const settings = id => ({ ...presets.find(preset => preset.id === id), apiKey: key });
const input = {
  kind: 'selection', title: 'Motor control', target: '简体中文',
  items: [
    { id: 'p1', text: 'Check the ⟦A1⟧current loop⟦/A1⟧.', before: 'Measure Iq.', after: 'Read the manual.', heading: 'FOC' },
    { id: 'p2', text: 'Read ⟦K2⟧.' }
  ],
  terms: [{ source: 'current loop', target: '电流环' }]
};
const translated = [
  { id: 'p1', text: '检查⟦A1⟧电流环⟦/A1⟧。' },
  { id: 'p2', text: '读取 ⟦K2⟧。' }
];
const asGroups = items => items.map(i => '%%' + i.id + '%%\n' + i.text).join('\n\n');
const output = asGroups(translated.toReversed()) + '\n%%TERMS%%\n[["current loop","电流环"],["battery","电池"]]';
const openAiResult = text => ({ choices: [{ message: { content: text } }] });
const geminiResult = text => ({ candidates: [{ content: { parts: [{ thought: true, text: 'analysis' }, { text }] } }] });
const claudeResult = text => ({ content: [{ type: 'thinking', thinking: 'analysis' }, { type: 'text', text }] });

for (const protocol of ['openai', 'gemini', 'claude']) {
  test(protocol + ' uses native endpoint, credential header, context and aligned IDs', async () => {
    const config = settings(protocol);
    config.workspaceId = 'wrkspc_test';
    let calls = 0;
    const result = await translateBatch(config, input, async (url, init) => {
      calls++;
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      assert.equal(init.referrerPolicy, 'no-referrer');
      assert.ok(init.signal instanceof AbortSignal);
      assert.ok(!url.includes(key) && !init.body.includes(key));
      const body = JSON.parse(init.body);
      let userText, instruction, envelope;
      if (protocol === 'openai') {
        assert.equal(url, config.baseUrl + '/chat/completions');
        assert.equal(init.headers.Authorization, 'Bearer ' + key);
        assert.equal(body.model, config.model);
        instruction = body.messages[0].content;
        userText = body.messages[1].content;
        envelope = openAiResult(output);
      } else if (protocol === 'gemini') {
        assert.equal(url, config.baseUrl + '/models/' + config.model + ':generateContent');
        assert.equal(init.headers['x-goog-api-key'], key);
        assert.ok(init.headers['x-goog-api-client']);
        instruction = body.systemInstruction.parts[0].text;
        userText = body.contents[0].parts[0].text;
        envelope = geminiResult(output);
      } else {
        assert.equal(url, config.baseUrl + '/messages');
        assert.equal(init.headers.Authorization, 'Bearer ' + key);
        assert.equal(init.headers['anthropic-workspace-id'], config.workspaceId);
        assert.equal(init.headers['anthropic-version'], '2026-10-21');
        assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
        assert.equal(body.model, config.model);
        instruction = body.system;
        userText = body.messages[0].content;
        envelope = claudeResult(output);
      }
      assert.match(instruction, /⟦K1⟧/);
      const [metadata] = userText.split('\n\n');
      const payload = JSON.parse(metadata);
      assert.equal(payload.kind, 'selection');
      assert.equal(payload.title, input.title);
      assert.deepEqual(payload.terms, input.terms);
      assert.equal(payload.paragraphs[0].before, input.items[0].before);
      assert.ok(userText.endsWith(asGroups(input.items)));
      return Response.json(envelope);
    });
    assert.deepEqual(result, { translations: translated, terms: input.terms });
    assert.equal(calls, 1);
  });
}

test('custom gateways retain path and port and can accept the full endpoint', async () => {
  const config = { ...settings('custom'), model: 'local/model', baseUrl: 'https://gateway.example:8443/api/v1/chat/completions/' };
  assert.equal(originPattern(config.baseUrl), 'https://gateway.example:8443/*');
  await translateBatch(config, input, async url => {
    assert.equal(url, config.baseUrl.slice(0, -1));
    return Response.json(openAiResult(output));
  });
});

test('rejects non-HTTPS addresses, URLs with credentials, newlines, wildcard hosts and nonofficial native origins', () => {
  for (const baseUrl of ['http://example.com', 'https://user:pass@host.example', 'https://host.example?key=123', 'https://host.example#key', 'https://*.example.com', 'https://host.example\n/']) {
    assert.throws(() => validateConfig({ ...settings('openai'), baseUrl }), /HTTPS/);
  }
  assert.throws(() => validateConfig({ ...settings('gemini'), baseUrl: 'https://gateway.example/v1beta' }), /官方/);
  assert.throws(() => validateConfig({ ...settings('claude'), workspaceId: 'id\nheader:x' }), /Workspace/);
  assert.throws(() => validateConfig({ ...settings('deepseek'), apiKey: 'abc\r\nX-Test: injected' }), /API Key/);
});

test('malformed input is rejected before any chargeable request', async () => {
  let calls = 0;
  for (const items of [[], [{ id: '', text: 'hello' }], [input.items[0], input.items[0]], [{ id: 'p', text: 'a'.repeat(16001) }]]) {
    await assert.rejects(translateBatch(settings('openai'), { items }, () => { calls++; }), /批次|编号|字符/);
  }
  assert.equal(calls, 0);
});

for (const [status, error, message] of [
  [401, { message: key }, /Key 无效/], [400, { message: 'API key not valid' }, /Key 无效/],
  [401, { message: 'CORS requests are not allowed for this Organization' }, /禁止从浏览器/],
  [400, { message: 'request must include the anthropic-workspace-id header' }, /Workspace ID/],
  [402, {}, /余额不足/], [429, { code: 'insufficient_quota' }, /额度已耗尽/], [429, {}, /限流/],
  [404, {}, /接口或模型/], [503, {}, /暂时无响应/], [403, {}, /拒绝访问/]
]) {
  test('HTTP ' + status + ' reports ' + message, async () => {
    let calls = 0;
    await assert.rejects(translateBatch(settings('openai'), input, async () => {
      calls++;
      return Response.json({ error }, { status });
    }), err => message.test(err.message) && !err.message.includes(key));
    assert.equal(calls, 1);
  });
}

test('network or unreadable success returns actionable error without retrying', async () => {
  let calls = 0;
  await assert.rejects(translateBatch(settings('claude'), input, async () => { calls++; throw new TypeError(key); }), err =>
    /手动重试/.test(err.message) && !err.message.includes(key));
  assert.equal(calls, 1);
  await assert.rejects(translateBatch(settings('claude'), input, async () => new Response('<html>')), /译文/);
  await assert.rejects(translateBatch(settings('claude'), input, async () => Response.json({ content: key })), err =>
    /译文/.test(err.message) && !err.message.includes(key));
  await assert.rejects(translateBatch(settings('gemini'), input, async () => Response.json({ candidates: [{ content: { parts: [null] } }] })), /译文/);
  await assert.rejects(translateBatch(settings('claude'), input, async () => Response.json({ stop_details: { type: 'refusal' } })), /拒绝/);
  await assert.rejects(translateBatch(settings('gemini'), input, async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] })), /长度/);
});

for (const translations of [
  [{ id: 'p1', text: '只返回了一个段落' }], [...translated, { id: 'p1', text: '重复' }],
  [translated[0], { id: 'new', text: '多余编号' }], [translated[0], { id: 'p2', text: '  ' }],
  [translated[0], { id: 'p2', text: '标记遗失' }], [{ id: 'p1', text: '⟦/A1⟧错误次序⟦A1⟧' }, translated[1]]
]) {
  test('rejects broken translations ' + JSON.stringify(translations), async () => {
    let calls = 0;
    await assert.rejects(translateBatch(settings('openai'), input, async () => {
      calls++;
      return Response.json(openAiResult(asGroups(translations)));
    }), /编号|空译文|标记/);
    assert.equal(calls, 1);
  });
}

test('one paragraph returns plain text; literal percent delimiters remain text', async () => {
  const body = {items:[{id:'1', text:'Explain\n%%TERMS%%\nin a manual.'}]};
  const result = await translateBatch(settings('openai'), body, async (_, init) => {
    assert.match(JSON.parse(init.body).messages[0].content, /%%%TERMS%%%/);
    return Response.json(openAiResult('说明\n%%TERMS%%\n的含义。'));
  });
  assert.equal(result.translations[0].text, '说明\n%%TERMS%%\n的含义。');
});

test('DeepSeek direct translation disables extended thinking only on supported official models', async () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://gateway.example/v1']) {
    await translateBatch({...settings('deepseek'), baseUrl}, input, async (_, init) => {
      assert.deepEqual(JSON.parse(init.body).thinking, baseUrl === 'https://api.deepseek.com' ? {type:'disabled'} : undefined);
      return Response.json(openAiResult(output));
    });
  }
});
