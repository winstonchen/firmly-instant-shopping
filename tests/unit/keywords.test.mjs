// Characterization tests for lib/keywords.js — the heuristic (no-LLM) path.
// These lock in the behavior that shipped in v0.4.1; a change that breaks one
// of these changes user-visible search behavior and must be deliberate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKeywords, parseAsk } from '../../extension/lib/keywords.js';

test('deriveKeywords: explicit query passes through trimmed', () => {
  assert.equal(deriveKeywords({ query: '  frame tv  ' }), 'frame tv');
});

test('deriveKeywords: strips publisher suffix and stopwords from article titles', () => {
  assert.equal(
    deriveKeywords({ title: 'Samsung Galaxy Buds4 Pro Review: AirPods Pro for Android | WIRED' }),
    'samsung galaxy buds4 pro airpods android'
  );
});

test('deriveKeywords: productName wins over title', () => {
  assert.equal(
    deriveKeywords({ productName: 'The Frame Pro 65" QLED TV', title: 'ignored title' }),
    'frame pro 65 qled tv'
  );
});

test('deriveKeywords: strips merchant site suffix ("- Best Buy")', () => {
  assert.equal(deriveKeywords({ title: '65" Class TV - Best Buy' }), '65 class tv');
});

test('deriveKeywords: empty context yields empty string', () => {
  assert.equal(deriveKeywords({}), '');
});

test('deriveKeywords: caps at 8 unique tokens', () => {
  const kw = deriveKeywords({ title: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' });
  assert.equal(kw.split(' ').length, 8);
});

test('parseAsk: "where can I buy this?" uses page context with buy intent', () => {
  const r = parseAsk('where can I buy this?', { title: 'Samsung Galaxy Buds4 Pro Review | WIRED' });
  assert.deepEqual(r, { keywords: 'samsung galaxy buds4 pro', buyIntent: true, usedPageContext: true });
});

test('parseAsk: "how much is the frame tv" extracts product with buy intent', () => {
  const r = parseAsk('how much is the frame tv');
  assert.deepEqual(r, { keywords: 'frame tv', buyIntent: true, usedPageContext: false });
});

test('parseAsk: plain product name is not buy intent', () => {
  const r = parseAsk('abominable hoodie');
  assert.deepEqual(r, { keywords: 'abominable hoodie', buyIntent: false, usedPageContext: false });
});

test('parseAsk: buy ask with no remainder and no context falls back to raw ask', () => {
  const r = parseAsk('buy it');
  assert.deepEqual(r, { keywords: 'buy it', buyIntent: true, usedPageContext: false });
});
