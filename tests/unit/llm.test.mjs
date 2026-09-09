// Unit tests for lib/llm.js agentRespond — the tool-calling agent loop —
// with a scripted fetch. Locks in: key gating, the search_products tool
// round-trip, history passing, failure→null (heuristic fallback signal),
// and the 3-round cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRespond, llmExtractKeywords } from '../../extension/lib/llm.js';

const CFG = { endpoint: 'https://llm.test/v1/chat', model: 'test-model', apiKey: 'k' };

function scriptFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    if (r.status) return { ok: false, status: r.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: r }] }) };
  };
  return calls;
}

test('agentRespond: returns null without an api key (heuristic path takes over)', async () => {
  assert.equal(await agentRespond('hi', {}, { ...CFG, apiKey: '' }, async () => []), null);
});

test('agentRespond: direct answer with no tool call', async () => {
  const calls = scriptFetch([{ role: 'assistant', content: 'Hello there.' }]);
  const r = await agentRespond('hi', { url: 'https://x.test', title: 'T' }, CFG, async () => []);
  assert.deepEqual(r, { answer: 'Hello there.', searched: false, keywords: null });
  assert.equal(calls.length, 1);
  const userMsg = calls[0].body.messages.at(-1);
  assert.match(userMsg.content, /Page URL: https:\/\/x\.test/);
  assert.match(userMsg.content, /User: hi/);
  assert.equal(calls[0].body.tools[0].function.name, 'search_products');
});

test('agentRespond: search tool round-trip feeds product data back to the LLM', async () => {
  const calls = scriptFetch([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', function: { name: 'search_products', arguments: '{"keywords":"frame tv 65"}' } }]
    },
    { role: 'assistant', content: 'It is $1,999 at Samsung — tap Instant Buy below.' }
  ]);
  let searchedWith = null;
  const products = [
    { title: 'The Frame 65"', price_range: { min: 199900 }, domain_name: 'Samsung', has_available_variants: true, description: 'QLED art tv' }
  ];
  const r = await agentRespond('where can I buy the frame tv?', {}, CFG, async (kw) => {
    searchedWith = kw;
    return products;
  });
  assert.equal(searchedWith, 'frame tv 65');
  assert.equal(r.searched, true);
  assert.equal(r.keywords, 'frame tv 65');
  assert.match(r.answer, /Instant Buy/);
  // second round carries the tool result with title + formatted price
  const toolMsg = calls[1].body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'tc1');
  const toolData = JSON.parse(toolMsg.content);
  assert.equal(toolData[0].title, 'The Frame 65"');
  assert.equal(toolData[0].price, '$1999.00');
});

test('agentRespond: prior history is included in the messages', async () => {
  const calls = scriptFetch([{ role: 'assistant', content: 'About 8 hours.' }]);
  const history = [
    { role: 'user', content: 'tell me about buds' },
    { role: 'assistant', content: 'They are earbuds.' }
  ];
  await agentRespond('battery life?', {}, CFG, async () => [], { history });
  const roles = calls[0].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
});

test('agentRespond: non-OK LLM response returns null', async () => {
  scriptFetch([{ status: 500 }]);
  assert.equal(await agentRespond('hi', {}, CFG, async () => []), null);
});

test('agentRespond: thrown fetch (network/timeout) returns null', async () => {
  scriptFetch([new Error('boom')]);
  assert.equal(await agentRespond('hi', {}, CFG, async () => []), null);
});

test('agentRespond: caps tool rounds at 3 and returns empty answer', async () => {
  const toolReply = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 't', function: { name: 'search_products', arguments: '{"keywords":"x"}' } }]
  };
  const calls = scriptFetch([toolReply, toolReply, toolReply, toolReply]);
  const r = await agentRespond('hi', {}, CFG, async () => []);
  assert.equal(calls.length, 3);
  assert.deepEqual(r, { answer: '', searched: true, keywords: 'x' });
});

test('llmExtractKeywords: parses the JSON contract and clamps length', async () => {
  scriptFetch([{ role: 'assistant', content: JSON.stringify({ keywords: 'k'.repeat(200), buy_intent: true, is_question: false }) }]);
  const r = await llmExtractKeywords('buy k', {}, CFG);
  assert.equal(r.keywords.length, 120);
  assert.equal(r.buyIntent, true);
  assert.equal(r.isQuestion, false);
});

test('llmExtractKeywords: missing keywords in the reply returns null', async () => {
  scriptFetch([{ role: 'assistant', content: '{"buy_intent": true}' }]);
  assert.equal(await llmExtractKeywords('x', {}, CFG), null);
});
