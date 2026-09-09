// Side panel app — wires the agreed flow end-to-end:
//   1. page context (content.js / tabs)  →  2. keywords (lib/keywords.js — the
//   Sonar swap-in point)  →  3. Firmly discovery  →  4. result cards  →
//   5. drop-in sheet: configure + add to cart  →  6. card capture on the same
//   screen  →  7. place order pre-filled from the profile.

import { FIRMLY_CONFIG } from './config.js';
import { FirmlyClient } from './lib/firmly-client.js';
import { createConfigurator } from './lib/configurator.js';
import { encryptCardJWE } from './lib/jwe.js';
import { parseAsk } from './lib/keywords.js';
import { agentRespond } from './lib/llm.js';

// ---- Firmly client with a chrome.storage-backed token store ----------------
// Persisting the token keeps the Firmly device_id stable across panel opens,
// which is what keeps carts alive.
//
// An App ID override can be set for testing without editing config.js:
//   chrome.storage.local.set({ firmlyAppIdOverride: '<app id>' })
// Sessions are keyed per App ID because tokens are app-bound.

const appId =
  (await chrome.storage.local.get('firmlyAppIdOverride')).firmlyAppIdOverride || FIRMLY_CONFIG.appId;
const sessionKey = `firmlySession:${appId}`;

// LLM config: endpoint/model from config, key from config or runtime override.
const llmKeyOverride = (await chrome.storage.local.get('firmlyLlmKeyOverride')).firmlyLlmKeyOverride;
const llmCfg = { ...(FIRMLY_CONFIG.llm || {}), ...(llmKeyOverride ? { apiKey: llmKeyOverride } : {}) };

const client = new FirmlyClient({
  ...FIRMLY_CONFIG,
  appId,
  tokenStore: {
    load: async () => (await chrome.storage.local.get(sessionKey))[sessionKey] || null,
    save: async (v) => chrome.storage.local.set({ [sessionKey]: v })
  }
});

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const sheetOverlay = $('sheetOverlay');
const sheetEl = $('sheet');

// Conversation memory passed to the agent so follow-ups work.
const conversationHistory = [];

function scrollChat() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function appendMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  scrollChat();
  return div;
}

// The newest agent bubble carries id="agentLine" (stable hook for tests/tools).
function markLatestAgent(el) {
  const prev = document.getElementById('agentLine');
  if (prev) prev.removeAttribute('id');
  el.id = 'agentLine';
}

// ---- toast ------------------------------------------------------------------

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}

// ---- money helpers ------------------------------------------------------------

const fmtCents = (cents, symbol = '$') => `${symbol}${(cents / 100).toFixed(2)}`;
const fmtMoney = (m) => (m ? `${m.symbol || '$'}${Number(m.value).toFixed(2)}` : '—');

// ---- step 1: page context ------------------------------------------------------

// Self-contained extractor for on-demand injection (chrome.scripting) —
// mirrors content.js. Injection is permitted via activeTab (granted when the
// user invokes the extension on a tab); no broad host permissions needed.
function extractPageContext() {
  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute('content') : null;
  };
  let productName = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const node of nodes) {
        const type = node && node['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
          if (node.name) { productName = String(node.name); break; }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
    if (productName) break;
  }
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.body;
  const pageText = ((root && root.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
  return {
    url: location.href,
    host: location.hostname,
    title: document.title,
    ogTitle: meta('meta[property="og:title"]'),
    ogType: meta('meta[property="og:type"]'),
    metaDescription: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    productName,
    pageText
  };
}

async function getPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return null;
  try {
    // Rich context from content.js where it runs (target merchant sites)…
    const ctx = await chrome.tabs.sendMessage(tab.id, { type: 'FIRMLY_GET_PAGE_CONTEXT' });
    if (ctx) return ctx;
  } catch {
    /* no content script on this page */
  }
  try {
    // …other pages: inject the extractor on demand (activeTab grant).
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageContext });
    if (res && res.result) return res.result;
  } catch {
    /* activeTab not granted for this tab — fall through */
  }
  // …otherwise fall back to what the tabs API exposes.
  return { url: tab.url, host: new URL(tab.url).hostname, title: tab.title || '' };
}

async function refreshContextBar() {
  const ctx = await getPageContext();
  const bar = $('contextBar');
  const hasContext = !!(ctx && (ctx.productName || ctx.title));
  if (hasContext) {
    $('contextTitle').textContent = ctx.productName || ctx.title;
    bar.classList.remove('hidden');
    bar.dataset.host = ctx.host || '';
  } else {
    bar.classList.add('hidden');
  }
  $('chips').classList.toggle('hidden', !hasContext);
  return ctx;
}

// ---- steps 2–4: ask → intent/keywords → discovery → cards ---------------------

function renderSkeletons(container, n = 3) {
  container.innerHTML = Array.from(
    { length: n },
    () => `<div class="skel"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line short"></div><div class="sk-line btn"></div></div>`
  ).join('');
}

// Firmly discovery scoped to the target merchants, with demo-catalog fallback.
async function searchProducts(keywords) {
  let res = await client.search(keywords, {
    domains: FIRMLY_CONFIG.targetDomains,
    pageSize: FIRMLY_CONFIG.pageSize
  });
  let demo = false;
  if ((!res.products || !res.products.length) && FIRMLY_CONFIG.demoFallback) {
    res = await client.search(keywords, { pageSize: FIRMLY_CONFIG.pageSize });
    demo = true;
  }
  return { products: res.products || [], demo };
}

async function runAsk(text) {
  if (!text || !text.trim()) return;
  $('searchInput').value = '';
  appendMsg('user', text.trim());
  const agentBubble = appendMsg('agent', 'Thinking…');
  markLatestAgent(agentBubble);
  const turnResults = document.createElement('div');
  turnResults.className = 'turn-results';
  chatEl.appendChild(turnResults);
  renderSkeletons(turnResults);
  $('demoBadge').classList.add('hidden');
  scrollChat();

  // Products render exactly ONCE per turn, when the turn concludes — the
  // agent may search more than once while reasoning, and re-rendering each
  // pass makes cards flicker/swap mid-answer.
  let collected = { products: [], demo: false };
  const finishTurn = (source, answerText) => {
    if (collected.products.length) {
      renderResults(collected.products, turnResults);
      $('demoBadge').classList.toggle('hidden', !collected.demo);
    } else {
      turnResults.remove();
    }
    agentBubble.dataset.source = source;
    agentBubble.textContent = answerText;
    conversationHistory.push({ role: 'user', content: text.trim() }, { role: 'assistant', content: answerText });
    scrollChat();
  };

  try {
    const ctx = await getPageContext();

    // Agent path: the LLM sees the conversation + page URL/title/content and
    // decides itself when product search is relevant (lib/llm.js agent loop —
    // any OpenAI-compatible endpoint; Sonar in the Samsung integration).
    if (llmCfg.apiKey) {
      const result = await agentRespond(
        text,
        ctx || {},
        llmCfg,
        async (kw) => {
          const r = await searchProducts(kw);
          if (r.products.length) collected = r; // keep the last non-empty set
          return r.products;
        },
        { history: conversationHistory.slice(-10) }
      );
      if (result) {
        finishTurn(
          'llm',
          result.answer ||
            (collected.products.length ? 'Here is what I found — tap Instant Buy to get it.' : 'I could not find anything for that.')
        );
        return;
      }
      // Final LLM round failed after searching — show what it found anyway.
      if (collected.products.length) {
        console.warn('agentRespond failed after search; rendering collected products');
        finishTurn('llm', 'Here is what I found — tap Instant Buy to get it.');
        return;
      }
    }

    // Heuristic path (no LLM key configured, or LLM unavailable).
    const { keywords, buyIntent, usedPageContext } = parseAsk(text, ctx || {});
    collected = await searchProducts(keywords);
    const merchants = [...new Set(collected.products.map((p) => p.domain_name || productDomain(p)))].filter(Boolean);
    finishTurn(
      'heuristic',
      collected.products.length
        ? (buyIntent
            ? `You can buy ${usedPageContext ? 'this' : `“${keywords}”`} right now from ${merchants.join(' and ')} — tap Instant Buy:`
            : `Here's what I found for “${keywords}”:`)
        : `No matches for “${keywords}” across the enabled merchants yet.`
    );
  } catch (err) {
    turnResults.remove();
    agentBubble.textContent = `Something went wrong: ${err.message}`;
    scrollChat();
  }
}

// Discovery hits occasionally omit `domain` (seen on some samsung.com
// products) — derive it from the PDP URL so cart/catalog calls never get
// `undefined` as the merchant.
function productDomain(p) {
  let d = p.domain;
  if (!d && p.pdp_url) {
    try {
      d = new URL(p.pdp_url).hostname;
    } catch { /* leave undefined */ }
  }
  return (d || '').replace(/^www\./, '');
}

function renderResults(products, container) {
  if (!products.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '';
  products.forEach((p, i) => {
    const img =
      (p.images && p.images[0] && p.images[0].url) ||
      (p.variants && p.variants[0] && p.variants[0].images && p.variants[0].images[0] && p.variants[0].images[0].url) ||
      '';
    const price =
      p.price_range && p.price_range.min != null
        ? p.price_range.min === p.price_range.max
          ? fmtCents(p.price_range.min)
          : `${fmtCents(p.price_range.min)} – ${fmtCents(p.price_range.max)}`
        : '';
    const desc = String(p.description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = `${Math.min(i * 45, 320)}ms`;
    card.innerHTML = `
      ${img ? `<img src="${escapeAttr(img)}" alt="" loading="lazy" />` : '<img alt="" />'}
      <div class="card-body">
        <div class="title">${escapeHtml(p.title || '')}</div>
        <div class="merchant">${escapeHtml(p.domain_name || productDomain(p))}</div>
        <div class="price">${price}</div>
        ${desc ? `<div class="desc">${escapeHtml(desc)}</div>` : ''}
        <button class="btn btn-primary btn-small">Instant Buy</button>
      </div>`;
    card.querySelector('button').addEventListener('click', () => openDropIn(products[i]));
    container.appendChild(card);
  });
}

// ---- steps 5–7: the drop-in sheet ------------------------------------------------

const dropin = {
  product: null,   // full PDP payload
  domain: null,
  cfg: null,       // configurator engine (lib/configurator.js)
  quantity: 1,
  cart: null,      // cart state after add / shipping
  shipCart: null   // response of shipping-info (has options + totals)
};

function openSheet() {
  sheetOverlay.classList.remove('hidden');
}
function closeSheet() {
  sheetOverlay.classList.add('hidden');
  sheetEl.innerHTML = '';
}
sheetOverlay.addEventListener('click', (e) => {
  if (e.target === sheetOverlay) closeSheet();
});

async function openDropIn(searchProduct) {
  openSheet();
  sheetEl.innerHTML = '<div class="spinner"></div>';
  try {
    const raw = productDomain(searchProduct);
    const domain = (FIRMLY_CONFIG.domainAliases || {})[raw] || raw;
    dropin.product = await loadPdp(domain, searchProduct);
    dropin.domain = domain;
    dropin.quantity = 1;
    dropin.cfg = createConfigurator(dropin.product, searchProduct);
    renderConfigure();
  } catch (err) {
    sheetEl.innerHTML = `<p class="status-line">Could not load product: ${escapeHtml(err.message)}</p>`;
  }
}

// PDP with graceful degradation: by handle → by URL → the discovery result
// itself (search hits already carry variants + add_to_cart_ref). Needed
// because some merchants (e.g. bestbuy.com on UAT) 500 on the by-handle route
// while the by-URL route works.
async function loadPdp(domain, searchProduct) {
  if (searchProduct.handle) {
    try {
      return await client.getProduct(domain, searchProduct.handle);
    } catch { /* fall through */ }
  }
  if (searchProduct.pdp_url) {
    try {
      return await client.getProductByUrl(searchProduct.pdp_url);
    } catch { /* fall through */ }
  }
  if (searchProduct.variants && searchProduct.variants.length && searchProduct.variants[0].add_to_cart_ref) {
    return searchProduct;
  }
  throw new Error('product details unavailable');
}

// -- state ①: configure (the variant configurator + qty) --

function renderConfigure() {
  const cfg = dropin.cfg;
  const v = cfg.variant;
  const img = cfg.image;
  const msrp = cfg.msrp;
  const savings = msrp && v ? { symbol: msrp.symbol, value: Number(msrp.value) - Number(v.price.value) } : null;

  sheetEl.innerHTML = `
    <div class="sheet-head">
      <h2>Instant Buy</h2>
      <button class="icon-btn" id="sheetClose">✕</button>
    </div>
    <div class="pdp">
      ${img ? `<img id="pdpImage" src="${escapeAttr(img)}" alt="" />` : ''}
      <div class="pdp-info">
        <p class="pdp-title">${escapeHtml(cfg.displayName)}</p>
        <div class="pdp-merchant">${escapeHtml(dropin.domain)}</div>
        <div class="pdp-price">
          ${v ? fmtMoney(v.price) : ''}
          ${msrp ? `<span class="pdp-msrp">${fmtMoney(msrp)}</span><span class="pdp-save">Save ${fmtMoney(savings)}</span>` : ''}
        </div>
        ${v && !v.available ? '<div class="unavailable">Out of stock — pick another option</div>' : ''}
        ${!v ? '<div class="unavailable">This product is not purchasable right now</div>' : ''}
      </div>
    </div>
    <div id="optGroups"></div>
    <div class="qty-row">
      <span class="opt-label" style="margin:0">Qty</span>
      <button id="qtyMinus">−</button><span id="qtyVal">${dropin.quantity}</span><button id="qtyPlus">+</button>
    </div>
    <button class="btn btn-primary btn-block" id="buyBtn" ${!v || !v.available ? 'disabled' : ''}>
      Buy now · ${v ? fmtMoney(v.price) : ''}
    </button>
    <p class="fine" style="margin-top:10px">Merchant of record: ${escapeHtml(dropin.domain)}. Checkout stays in this panel.</p>
  `;

  const optWrap = sheetEl.querySelector('#optGroups');
  for (const g of cfg.groups) {
    const selectedLabel =
      (g.option_values.find((ov) => ov.value === cfg.selection[g.property_accessor]) || {}).display_name || '';
    const div = document.createElement('div');
    div.className = 'opt-group';
    div.innerHTML = `<span class="opt-label">${escapeHtml(g.display_name || 'Option')}<span class="opt-selected">${escapeHtml(selectedLabel)}</span></span><div class="opt-values"></div>`;
    const values = div.querySelector('.opt-values');
    for (const ov of g.option_values) {
      const stateName = cfg.valueState(g.property_accessor, ov.value);
      if (stateName === 'missing') continue; // dead option — no variant carries it
      const chip = document.createElement('button');
      chip.className = `opt-chip ${stateName}`;
      chip.dataset.state = stateName;
      chip.textContent = ov.display_name;
      if (stateName === 'unavailable') chip.title = 'Out of stock in this combination';
      if (stateName === 'repair') chip.title = 'Available in a different combination — selecting adjusts the other options';
      chip.addEventListener('click', () => {
        cfg.select(g.property_accessor, ov.value);
        renderConfigure();
      });
      values.appendChild(chip);
    }
    optWrap.appendChild(div);
  }

  sheetEl.querySelector('#sheetClose').addEventListener('click', closeSheet);
  sheetEl.querySelector('#qtyMinus').addEventListener('click', () => {
    dropin.quantity = Math.max(1, dropin.quantity - 1);
    sheetEl.querySelector('#qtyVal').textContent = dropin.quantity;
  });
  sheetEl.querySelector('#qtyPlus').addEventListener('click', () => {
    dropin.quantity = Math.min(9, dropin.quantity + 1);
    sheetEl.querySelector('#qtyVal').textContent = dropin.quantity;
  });
  sheetEl.querySelector('#buyBtn').addEventListener('click', startCheckout);
}

// -- state ②: single-page checkout (address + shipping + card on one screen) --

async function startCheckout() {
  const ref = dropin.cfg && dropin.cfg.addToCartRef;
  if (!ref) return;
  sheetEl.innerHTML = '<div class="spinner"></div><p class="status-line">Adding to cart…</p>';
  try {
    await client.clearCart(dropin.domain).catch(() => {}); // instant-buy semantics: one item per order
    dropin.cart = await client.addLineItem(dropin.domain, ref, dropin.quantity);
    const profile = await loadProfile();
    if (profileHasAddress(profile)) {
      sheetEl.innerHTML = '<div class="spinner"></div><p class="status-line">Calculating shipping &amp; tax…</p>';
      dropin.shipCart = await client.setShippingInfo(dropin.domain, addressFrom(profile)).catch(() => null);
    } else {
      dropin.shipCart = null;
    }
    renderCheckout(profile);
  } catch (err) {
    const pdpUrl = dropin.product && dropin.product.pdp_url;
    sheetEl.innerHTML = `
      <div class="sheet-head"><h2>Checkout unavailable</h2><button class="icon-btn" id="sheetClose">✕</button></div>
      <p class="status-line">Instant checkout isn't enabled for ${escapeHtml(dropin.domain || 'this merchant')} on this environment yet.<br/><span class="fine">${escapeHtml(err.message)}</span></p>
      ${pdpUrl ? `<p style="text-align:center"><a href="${escapeAttr(pdpUrl)}" target="_blank" rel="noopener">View this product on the merchant site →</a></p>` : ''}`;
    sheetEl.querySelector('#sheetClose').addEventListener('click', closeSheet);
  }
}

function renderCheckout(profile) {
  const cart = dropin.shipCart || dropin.cart;
  const li = (cart.line_items || [])[0] || {};
  const shipOptions = (dropin.shipCart && dropin.shipCart.shipping_method_options) || [];
  const selectedShip = dropin.shipCart && dropin.shipCart.shipping_method;

  sheetEl.innerHTML = `
    <div class="sheet-head">
      <h2>Checkout — ${escapeHtml(cart.display_name || dropin.domain)}</h2>
      <button class="icon-btn" id="sheetClose">✕</button>
    </div>
    <div class="pdp">
      ${li.image && li.image.url ? `<img src="${escapeAttr(li.image.url)}" alt="" />` : ''}
      <div class="pdp-info">
        <p class="pdp-title">${escapeHtml(li.description || dropin.product.title || '')}</p>
        <div class="pdp-merchant">Qty ${li.quantity || dropin.quantity}</div>
        <div class="pdp-price">${fmtMoney(li.line_price || li.price)}</div>
      </div>
    </div>

    <div class="section-title">Ship to (from browser profile)</div>
    <form id="addrForm" class="form-grid">
      <input name="first_name" placeholder="First name" required value="${escapeAttr(profile.first_name || '')}" />
      <input name="last_name" placeholder="Last name" required value="${escapeAttr(profile.last_name || '')}" />
      <input name="email" placeholder="Email" type="email" required class="span2" value="${escapeAttr(profile.email || '')}" />
      <input name="phone" placeholder="Phone" required class="span2" value="${escapeAttr(profile.phone || '')}" />
      <input name="address1" placeholder="Address" required class="span2" value="${escapeAttr(profile.address1 || '')}" />
      <input name="city" placeholder="City" required value="${escapeAttr(profile.city || '')}" />
      <input name="state_or_province" placeholder="State" required value="${escapeAttr(profile.state_or_province || '')}" />
      <input name="postal_code" placeholder="ZIP" required value="${escapeAttr(profile.postal_code || '')}" />
      <input name="country" placeholder="Country" required value="${escapeAttr(profile.country || 'US')}" />
      <button type="submit" class="btn span2" id="applyAddr">${dropin.shipCart ? 'Update address' : 'Apply address'}</button>
    </form>

    <div id="shipBlock" class="${dropin.shipCart ? '' : 'hidden'}">
      <div class="section-title">Shipping</div>
      <div class="ship-options" id="shipOptions"></div>
    </div>

    <div id="totalsBlock"></div>

    <div class="section-title">Payment — card captured here, encrypted on-device</div>
    <form id="payForm" class="form-grid">
      <input name="card_number" placeholder="Card number" inputmode="numeric" required class="span2" value="${escapeAttr(profile.card_number || '')}" />
      <input name="card_name" placeholder="Name on card" required class="span2" value="${escapeAttr(profile.card_name || '')}" />
      <input name="card_month" placeholder="MM" inputmode="numeric" maxlength="2" required value="${escapeAttr(profile.card_month || '')}" />
      <input name="card_year" placeholder="YYYY" inputmode="numeric" maxlength="4" required value="${escapeAttr(profile.card_year || '')}" />
      <input name="cvv" placeholder="CVV" inputmode="numeric" maxlength="4" required />
      <button type="submit" class="btn btn-primary span2" id="placeOrderBtn" ${dropin.shipCart ? '' : 'disabled'}>
        Place order${dropin.shipCart ? ' · ' + fmtMoney(dropin.shipCart.total) : ''}
      </button>
    </form>
    <p class="fine" style="margin-top:8px">Card is JWE-encrypted (RSA-OAEP-256 + AES-256-GCM) with Firmly's public key before it leaves this device. CVV is never stored.</p>
  `;

  sheetEl.querySelector('#sheetClose').addEventListener('click', closeSheet);

  renderShipOptions(shipOptions, selectedShip);
  renderTotals();

  sheetEl.querySelector('#addrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = formValues(e.target);
    const btn = sheetEl.querySelector('#applyAddr');
    btn.disabled = true;
    btn.textContent = 'Calculating…';
    try {
      dropin.shipCart = await client.setShippingInfo(dropin.domain, addr);
      await saveProfile({ ...(await loadProfile()), ...addr });
      renderCheckout(await loadProfile());
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Apply address';
      toast(err.message, true);
    }
  });

  sheetEl.querySelector('#payForm').addEventListener('submit', (e) => {
    e.preventDefault();
    placeOrder(formValues(e.target));
  });

  const cardInput = sheetEl.querySelector('#payForm [name="card_number"]');
  cardInput.addEventListener('input', () => {
    const digits = cardInput.value.replace(/\D/g, '').slice(0, 19);
    cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
  });
}

function renderShipOptions(options, selected) {
  const wrap = sheetEl.querySelector('#shipOptions');
  if (!wrap) return;
  wrap.innerHTML = '';
  const selId = selected && (selected.id || selected.sku);
  options.forEach((o) => {
    const id = o.id || o.sku;
    const div = document.createElement('label');
    div.className = 'ship-option' + (id === selId ? ' selected' : '');
    div.innerHTML = `<input type="radio" name="ship" ${id === selId ? 'checked' : ''}/>
      <span>${escapeHtml(o.description || id)}</span>
      <span class="ship-price">${o.price && o.price.value ? fmtMoney(o.price) : 'Free'}</span>`;
    div.querySelector('input').addEventListener('change', () => switchShipping(id));
    wrap.appendChild(div);
  });
}

async function switchShipping(shippingMethodId) {
  try {
    const cart = await client.getCart(dropin.domain);
    const shipment = (cart.shipments || [])[0];
    if (!shipment) throw new Error('no shipment');
    const updated = await client.setShippingMethod(dropin.domain, shipment.shipment_id, shippingMethodId);
    dropin.shipCart = { ...dropin.shipCart, ...updated };
    renderCheckout(await loadProfile());
  } catch {
    // Endpoint not yet live on UAT — keep the auto-selected default.
    toast('Shipping-method switching is not enabled on this environment yet; using the default option.');
    renderCheckout(await loadProfile());
  }
}

function renderTotals() {
  const el = sheetEl.querySelector('#totalsBlock');
  if (!el) return;
  const c = dropin.shipCart;
  if (!c) {
    el.innerHTML = '<p class="fine">Apply a shipping address to see shipping, tax and total.</p>';
    return;
  }
  el.innerHTML = `
    <div class="section-title">Summary</div>
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${fmtMoney(c.sub_total)}</span></div>
      <div class="row"><span>Shipping</span><span>${c.shipping_total && c.shipping_total.value ? fmtMoney(c.shipping_total) : 'Free'}</span></div>
      <div class="row"><span>Tax</span><span>${fmtMoney(c.tax)}</span></div>
      <div class="row grand"><span>Total</span><span>${fmtMoney(c.total)}</span></div>
    </div>`;
}

// -- state ③: place order + confirmation --

async function placeOrder(pay) {
  const btn = sheetEl.querySelector('#placeOrderBtn');
  btn.disabled = true;
  btn.textContent = 'Placing order…';
  try {
    // Persist card (never the CVV) as the stand-in for browser card-on-file.
    const profile = await loadProfile();
    await saveProfile({
      ...profile,
      card_number: pay.card_number,
      card_name: pay.card_name,
      card_month: pay.card_month,
      card_year: pay.card_year
    });

    const { jwk, kid } = await client.getPaymentKey();
    const encryptedCard = await encryptCardJWE(
      {
        number: pay.card_number.replace(/\s+/g, ''),
        name: pay.card_name,
        verification_value: pay.cvv,
        month: pay.card_month.padStart(2, '0'),
        year: pay.card_year
      },
      jwk,
      kid
    );

    const ship = dropin.shipCart.shipping_info || {};
    const billing = {
      first_name: ship.first_name,
      last_name: ship.last_name,
      address1: ship.address1,
      city: ship.city,
      state_or_province: ship.state_or_province,
      postal_code: ship.postal_code,
      country: 'US',
      email: ship.email,
      phone: ship.phone
    };

    const order = await client.completeOrder(dropin.domain, encryptedCard, billing);
    renderConfirmation(order);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Place order';
    toast(`Order failed: ${err.message}`, true);
  }
}

function renderConfirmation(order) {
  const li = (order.line_items || [])[0] || {};
  const thankYou = order.urls && order.urls.thank_you_page;
  sheetEl.innerHTML = `
    <div class="sheet-head">
      <h2>Order placed</h2>
      <button class="icon-btn" id="sheetClose">✕</button>
    </div>
    <div class="confirm">
      <div class="check">✓</div>
      <h3>Thanks — your order is in!</h3>
      <p class="fine">
        ${escapeHtml(li.description || '')}${li.platform_line_item_id ? ` · Order line #${escapeHtml(String(li.platform_line_item_id))}` : ''}<br/>
        Merchant: ${escapeHtml(order.display_name || dropin.domain)} · Total ${fmtMoney(order.total)}
      </p>
      ${thankYou ? `<a href="${escapeAttr(thankYou)}" target="_blank" rel="noopener">View order confirmation on merchant site →</a>` : ''}
    </div>`;
  sheetEl.querySelector('#sheetClose').addEventListener('click', closeSheet);
}

// ---- profile (stand-in for browser profile + card-on-file) ---------------------

async function loadProfile() {
  return (await chrome.storage.local.get('firmlyProfile')).firmlyProfile || {};
}
async function saveProfile(p) {
  await chrome.storage.local.set({ firmlyProfile: p });
}
function profileHasAddress(p) {
  return ['first_name', 'last_name', 'email', 'phone', 'address1', 'city', 'state_or_province', 'postal_code'].every(
    (k) => p[k]
  );
}
function addressFrom(p) {
  return {
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    phone: p.phone,
    address1: p.address1,
    city: p.city,
    state_or_province: p.state_or_province,
    postal_code: p.postal_code,
    country: p.country || 'US'
  };
}

// ---- small utils -----------------------------------------------------------------

function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('input, select')) {
    if (el.name) out[el.name] = el.value.trim();
  }
  return out;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ---- wire up the static UI ----------------------------------------------------------

$('searchBtn').addEventListener('click', () => runAsk($('searchInput').value));
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAsk($('searchInput').value);
});

$('shopPageBtn').addEventListener('click', () => runAsk('Where can I buy this?'));

for (const chip of document.querySelectorAll('#chips .ask-chip')) {
  chip.addEventListener('click', () => runAsk(chip.textContent));
}

$('profileBtn').addEventListener('click', async () => {
  const p = await loadProfile();
  const form = $('profileForm');
  for (const el of form.querySelectorAll('input')) {
    if (el.name && p[el.name] !== undefined) el.value = p[el.name];
  }
  form.querySelector('[name="app_id_override"]').value =
    (await chrome.storage.local.get('firmlyAppIdOverride')).firmlyAppIdOverride || '';
  $('activeAppId').textContent =
    `Active App ID: …${appId.slice(-12)}${appId === FIRMLY_CONFIG.appId ? ' (default)' : ' (override)'}`;
  form.querySelector('[name="llm_key_override"]').value = llmKeyOverride || '';
  $('activeLlm').textContent = llmCfg.apiKey
    ? `LLM keywords: on (${llmCfg.model})`
    : 'LLM keywords: off — using heuristic. Paste an OpenAI-compatible API key to enable.';
  $('profileOverlay').classList.remove('hidden');
});
$('profileClose').addEventListener('click', () => $('profileOverlay').classList.add('hidden'));
$('profileOverlay').addEventListener('click', (e) => {
  if (e.target === $('profileOverlay')) $('profileOverlay').classList.add('hidden');
});
$('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = formValues(e.target);
  const override = values.app_id_override;
  const llmOverride = values.llm_key_override;
  delete values.app_id_override;
  delete values.llm_key_override;
  await saveProfile({ ...(await loadProfile()), ...values });
  const prev = (await chrome.storage.local.get('firmlyAppIdOverride')).firmlyAppIdOverride || '';
  const prevLlm = (await chrome.storage.local.get('firmlyLlmKeyOverride')).firmlyLlmKeyOverride || '';
  if (override) await chrome.storage.local.set({ firmlyAppIdOverride: override });
  else await chrome.storage.local.remove('firmlyAppIdOverride');
  if (llmOverride) await chrome.storage.local.set({ firmlyLlmKeyOverride: llmOverride });
  else await chrome.storage.local.remove('firmlyLlmKeyOverride');
  $('profileOverlay').classList.add('hidden');
  if ((override || '') !== prev || (llmOverride || '') !== prevLlm) {
    toast('Settings changed — reloading panel…');
    setTimeout(() => location.reload(), 600);
  } else {
    toast('Profile saved.');
  }
});

// keep the context bar current as the user moves between tabs/pages
refreshContextBar();
chrome.tabs.onActivated.addListener(refreshContextBar);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete') refreshContextBar();
});

// greet + warm the session so the first ask is instant
const welcome = appendMsg(
  'agent',
  appId
    ? 'Hi! Ask me about any product — or open an article and tap “Shop this page”. I can answer questions and you can buy right here.'
    : 'No Firmly App ID configured. Add the App ID you received from Firmly: ⚙ → Developer → App ID override (or set it in config.js).'
);
markLatestAgent(welcome);
if (appId) {
  client.ensureSession().catch((err) => toast(`Firmly session failed: ${err.message}`, true));
}
