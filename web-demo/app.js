// Web-demo build of the extension's side panel: identical flow and identical
// lib/ modules; the only differences are (a) localStorage instead of
// chrome.storage and (b) no page-context capture (that needs the extension).

import { FIRMLY_CONFIG } from './config.js';
import { FirmlyClient } from './lib/firmly-client.js';
import { encryptCardJWE } from './lib/jwe.js';
import { parseAsk } from './lib/keywords.js';
import { agentRespond } from './lib/llm.js';

// App ID override without editing config.js:
//   localStorage.setItem('firmlyAppIdOverride', '<app id>')
const appId = localStorage.getItem('firmlyAppIdOverride') || FIRMLY_CONFIG.appId;
const sessionKey = `firmlySession:${appId}`;

// LLM key override: localStorage.setItem('firmlyLlmKeyOverride', '<key>')
const llmCfg = {
  ...(FIRMLY_CONFIG.llm || {}),
  ...(localStorage.getItem('firmlyLlmKeyOverride') ? { apiKey: localStorage.getItem('firmlyLlmKeyOverride') } : {})
};

const client = new FirmlyClient({
  ...FIRMLY_CONFIG,
  appId,
  tokenStore: {
    load: async () => JSON.parse(localStorage.getItem(sessionKey) || 'null'),
    save: async (v) => localStorage.setItem(sessionKey, JSON.stringify(v))
  }
});

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const sheetOverlay = $('sheetOverlay');
const sheetEl = $('sheet');

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

// ---- keywords → discovery → cards -----------------------------------------------

function renderSkeletons(container, n = 3) {
  container.innerHTML = Array.from(
    { length: n },
    () => `<div class="skel"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line short"></div><div class="sk-line btn"></div></div>`
  ).join('');
}

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

  // Render products exactly once, when the turn concludes (no mid-loop flicker).
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
    if (llmCfg.apiKey) {
      const result = await agentRespond(
        text,
        {},
        llmCfg,
        async (kw) => {
          const r = await searchProducts(kw);
          if (r.products.length) collected = r;
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
      if (collected.products.length) {
        finishTurn('llm', 'Here is what I found — tap Instant Buy to get it.');
        return;
      }
    }

    const { keywords, buyIntent } = parseAsk(text, {});
    collected = await searchProducts(keywords);
    const merchants = [...new Set(collected.products.map((p) => p.domain_name || productDomain(p)))].filter(Boolean);
    finishTurn(
      'heuristic',
      collected.products.length
        ? (buyIntent
            ? `You can buy “${keywords}” right now from ${merchants.join(' and ')} — tap Instant Buy:`
            : `Here's what I found for “${keywords}”:`)
        : `No matches for “${keywords}” across the enabled merchants yet.`
    );
  } catch (err) {
    turnResults.remove();
    agentBubble.textContent = `Something went wrong: ${err.message}`;
    scrollChat();
  }
}

// Discovery hits occasionally omit `domain` — derive from the PDP URL.
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

// ---- drop-in sheet ------------------------------------------------------------------

const dropin = {
  product: null,
  domain: null,
  selections: {},
  quantity: 1,
  cart: null,
  shipCart: null
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
    dropin.selections = defaultSelections(dropin.product);
    renderConfigure();
  } catch (err) {
    sheetEl.innerHTML = `<p class="status-line">Could not load product: ${escapeHtml(err.message)}</p>`;
  }
}

// PDP with graceful degradation: by handle → by URL → the discovery result
// itself (search hits already carry variants + add_to_cart_ref).
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

function optionGroups(product) {
  return (product.variant_option_values || []).filter(
    (g) => g && g.option_values && g.option_values.length
  );
}

function defaultSelections(product) {
  const groups = optionGroups(product);
  const firstAvailable = (product.variants || []).find((v) => v.available) || (product.variants || [])[0];
  const sel = {};
  for (const g of groups) {
    sel[g.property_accessor] = firstAvailable ? firstAvailable[g.property_accessor] : g.option_values[0].value;
  }
  return sel;
}

function selectedVariant() {
  const groups = optionGroups(dropin.product);
  const variants = dropin.product.variants || [];
  if (!groups.length) return variants[0] || null;
  return (
    variants.find((v) => groups.every((g) => v[g.property_accessor] === dropin.selections[g.property_accessor])) ||
    null
  );
}

function renderConfigure() {
  const p = dropin.product;
  const v = selectedVariant();
  const groups = optionGroups(p);
  const img =
    (v && v.images && v.images[0] && v.images[0].url) ||
    (p.images && p.images[0] && p.images[0].url) ||
    '';

  sheetEl.innerHTML = `
    <div class="sheet-head">
      <h2>Instant Buy</h2>
      <button class="icon-btn" id="sheetClose">✕</button>
    </div>
    <div class="pdp">
      ${img ? `<img src="${escapeAttr(img)}" alt="" />` : ''}
      <div class="pdp-info">
        <p class="pdp-title">${escapeHtml(p.title || '')}</p>
        <div class="pdp-merchant">${escapeHtml(dropin.domain)}</div>
        <div class="pdp-price">${v ? fmtMoney(v.price) : ''}</div>
        ${v && !v.available ? '<div class="unavailable">Out of stock</div>' : ''}
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
  for (const g of groups) {
    const div = document.createElement('div');
    div.className = 'opt-group';
    div.innerHTML = `<span class="opt-label">${escapeHtml(g.display_name || 'Option')}</span><div class="opt-values"></div>`;
    const values = div.querySelector('.opt-values');
    for (const ov of g.option_values) {
      const chip = document.createElement('button');
      chip.className = 'opt-chip' + (dropin.selections[g.property_accessor] === ov.value ? ' selected' : '');
      chip.textContent = ov.display_name;
      chip.addEventListener('click', () => {
        dropin.selections[g.property_accessor] = ov.value;
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

async function startCheckout() {
  const v = selectedVariant();
  if (!v) return;
  sheetEl.innerHTML = '<div class="spinner"></div><p class="status-line">Adding to cart…</p>';
  try {
    await client.clearCart(dropin.domain).catch(() => {});
    dropin.cart = await client.addLineItem(dropin.domain, v.add_to_cart_ref, dropin.quantity);
    const profile = loadProfile();
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
      saveProfile({ ...loadProfile(), ...addr });
      renderCheckout(loadProfile());
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
    renderCheckout(loadProfile());
  } catch {
    toast('Shipping-method switching is not enabled on this environment yet; using the default option.');
    renderCheckout(loadProfile());
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

async function placeOrder(pay) {
  const btn = sheetEl.querySelector('#placeOrderBtn');
  btn.disabled = true;
  btn.textContent = 'Placing order…';
  try {
    const profile = loadProfile();
    saveProfile({
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

// ---- profile (localStorage stand-in for browser profile) ---------------------------

function loadProfile() {
  return JSON.parse(localStorage.getItem('firmlyProfile') || '{}');
}
function saveProfile(p) {
  localStorage.setItem('firmlyProfile', JSON.stringify(p));
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

// ---- small utils ---------------------------------------------------------------------

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

// ---- wire up ----------------------------------------------------------------------------

$('searchBtn').addEventListener('click', () => runAsk($('searchInput').value));
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAsk($('searchInput').value);
});

$('profileBtn').addEventListener('click', () => {
  const p = loadProfile();
  const form = $('profileForm');
  for (const el of form.querySelectorAll('input')) {
    if (el.name && p[el.name] !== undefined) el.value = p[el.name];
  }
  $('profileOverlay').classList.remove('hidden');
});
$('profileClose').addEventListener('click', () => $('profileOverlay').classList.add('hidden'));
$('profileOverlay').addEventListener('click', (e) => {
  if (e.target === $('profileOverlay')) $('profileOverlay').classList.add('hidden');
});
$('profileForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveProfile({ ...loadProfile(), ...formValues(e.target) });
  $('profileOverlay').classList.add('hidden');
  toast('Profile saved.');
});

const welcome = appendMsg(
  'agent',
  appId
    ? 'Hi! Ask me about any product — I can answer questions and you can buy right here. Try “where can I buy a samsung frame tv?”'
    : "No Firmly App ID configured. Set it once via DevTools console: localStorage.setItem('firmlyAppIdOverride','<your app id>') — or in config.js."
);
markLatestAgent(welcome);
if (appId) {
  client.ensureSession().catch((err) => toast(`Firmly session failed: ${err.message}`, true));
}
