// Unit tests for lib/firmly-client.js with a mocked fetch — verifies the API
// contract the extension depends on: session lifecycle, endpoint paths,
// request shaping, 401 renewal, and error surfacing. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FirmlyClient } from '../../extension/lib/firmly-client.js';

const CFG = { appId: 'app-1', apiBase: 'https://api.test', paymentBase: 'https://cc.test' };
const now = () => Math.floor(Date.now() / 1000);

// fetch mock: records calls, replies from a queue (or a default session reply).
function mockFetch() {
  const calls = [];
  const queue = [];
  const sessionReply = () =>
    jsonResponse({ access_token: 'tok-' + (calls.length + 1), expires: now() + 3600, device_id: 'dev-1' });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (queue.length) return queue.shift()(String(url), init);
    return sessionReply();
  };
  return { calls, queue };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const sessionOk = () => (url) => {
  assert.match(url, /\/api\/v1\/browser-session$/);
  return jsonResponse({ access_token: 'tok-a', expires: now() + 3600, device_id: 'dev-1' });
};

test('ensureSession: creates a session with the app id header and persists it', async () => {
  const { calls, queue } = mockFetch();
  queue.push(sessionOk());
  let saved = null;
  const client = new FirmlyClient({ ...CFG, tokenStore: { load: async () => saved, save: async (v) => (saved = v) } });
  const token = await client.ensureSession();
  assert.equal(token, 'tok-a');
  assert.equal(calls[0].init.headers['x-firmly-app-id'], 'app-1');
  assert.equal(calls[0].init.body, undefined); // fresh session: no prior token
  assert.equal(saved.access_token, 'tok-a');
  assert.equal(saved.device_id, 'dev-1');
});

test('ensureSession: reuses a still-valid saved token without a network call', async () => {
  const { calls } = mockFetch();
  const client = new FirmlyClient({
    ...CFG,
    tokenStore: { load: async () => ({ access_token: 'tok-live', expires: now() + 3600 }), save: async () => {} }
  });
  assert.equal(await client.ensureSession(), 'tok-live');
  assert.equal(calls.length, 0);
});

test('ensureSession: renews an expiring token, passing the old token to keep the device', async () => {
  const { calls, queue } = mockFetch();
  queue.push(sessionOk());
  const client = new FirmlyClient({
    ...CFG,
    tokenStore: { load: async () => ({ access_token: 'tok-old', expires: now() + 30 }), save: async () => {} }
  });
  assert.equal(await client.ensureSession(), 'tok-a');
  assert.deepEqual(JSON.parse(calls[0].init.body), { access_token: 'tok-old' });
});

test('_request: sends the session token and retries exactly once on 401', async () => {
  const { calls, queue } = mockFetch();
  queue.push(sessionOk()); // initial session
  queue.push(() => jsonResponse({ error: 'expired' }, { status: 401 })); // API rejects
  queue.push(sessionOk()); // renewal
  queue.push(() => jsonResponse({ products: [] })); // retry succeeds
  const client = new FirmlyClient(CFG);
  const res = await client.search('tv');
  assert.deepEqual(res, { products: [] });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].init.headers['x-firmly-authorization'], 'tok-a');
});

test('search: shapes the discovery body (domains, in_stock default, page size)', async () => {
  const { calls, queue } = mockFetch();
  queue.push(sessionOk());
  queue.push((url, init) => {
    assert.match(url, /\/api\/v1\/discovery\/search$/);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      query: '65 inch tv',
      filters: { domains: ['bestbuy.com'], in_stock: true },
      page_size: 4
    });
    return jsonResponse({ products: [] });
  });
  const client = new FirmlyClient(CFG);
  await client.search('65 inch tv', { domains: ['bestbuy.com'], pageSize: 4 });
});

test('getProduct: URI-encodes the handle', async () => {
  const { calls, queue } = mockFetch();
  queue.push(sessionOk());
  queue.push((url) => {
    assert.match(url, /\/api\/v1\/domains-products\/samsung\.com\/QN65%20X$/);
    return jsonResponse({ title: 'tv' });
  });
  const client = new FirmlyClient(CFG);
  await client.getProduct('samsung.com', 'QN65 X');
});

test('getProductByUrl: passes the PDP url as a query param', async () => {
  const { queue } = mockFetch();
  queue.push(sessionOk());
  queue.push((url) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/api/v1/domains-pdp');
    assert.equal(u.searchParams.get('url'), 'https://www.bestbuy.com/p/x');
    return jsonResponse({ title: 'tv' });
  });
  const client = new FirmlyClient(CFG);
  await client.getProductByUrl('https://www.bestbuy.com/p/x');
});

test('cart: addLineItem posts add_to_cart_ref verbatim to the v2 route', async () => {
  const { queue } = mockFetch();
  queue.push(sessionOk());
  queue.push((url, init) => {
    assert.match(url, /\/api\/v2\/domains\/bestbuy\.com\/cart\/line-items$/);
    assert.deepEqual(JSON.parse(init.body), { add_to_cart_ref: { variant_id: '6670834' }, quantity: 2 });
    return jsonResponse({ line_items: [] });
  });
  const client = new FirmlyClient(CFG);
  await client.addLineItem('bestbuy.com', { variant_id: '6670834' }, 2);
});

test('cart: getCart uses the v2 route with required trailing slash', async () => {
  const { queue } = mockFetch();
  queue.push(sessionOk());
  queue.push((url) => {
    assert.match(url, /\/api\/v2\/domains\/d\.com\/cart\/$/);
    return jsonResponse({});
  });
  await new FirmlyClient(CFG).getCart('d.com');
});

test('payment: getPaymentKey hits the PCI host unauthenticated and reads the kid header', async () => {
  const { calls, queue } = mockFetch();
  queue.push((url) => {
    assert.match(url, /^https:\/\/cc\.test\/api\/v1\/payment\/key$/);
    return jsonResponse({ kty: 'RSA', n: 'n', e: 'AQAB' }, { headers: { 'x-firmly-kid': 'kid-7' } });
  });
  const { jwk, kid } = await new FirmlyClient(CFG).getPaymentKey();
  assert.equal(kid, 'kid-7');
  assert.equal(jwk.kty, 'RSA');
  assert.equal(calls.length, 1); // no session call for the public key
});

test('payment: completeOrder posts to the PCI host with encrypted card + billing', async () => {
  const { queue } = mockFetch();
  queue.push(sessionOk());
  queue.push((url, init) => {
    assert.match(url, /^https:\/\/cc\.test\/api\/v1\/payment\/domains\/staging\.luma\.gift\/complete-order$/);
    const body = JSON.parse(init.body);
    assert.equal(body.encrypted_card, 'jwe-token');
    assert.equal(body.billing_info.first_name, 'Sam');
    return jsonResponse({ total: { value: 1 } });
  });
  await new FirmlyClient(CFG).completeOrder('staging.luma.gift', 'jwe-token', { first_name: 'Sam' });
});

test('errors: non-OK responses surface status + error description', async () => {
  const { queue } = mockFetch();
  queue.push(sessionOk());
  queue.push(() => jsonResponse({ error: 'CartNotFound', description: 'no cart' }, { status: 404 }));
  await assert.rejects(
    () => new FirmlyClient(CFG).getCart('d.com'),
    (err) => err.status === 404 && /CartNotFound/.test(err.message) && /no cart/.test(err.message)
  );
});
