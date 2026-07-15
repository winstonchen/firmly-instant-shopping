# Design — Firmly Instant Shopping extension

Reference architecture for an in-browser instant-shopping experience on the Firmly public API. Written for browser-team engineers evaluating the integration.

## 1. Architecture

```
┌────────────────────────── Browser ──────────────────────────┐
│                                                             │
│  Any web page                    Side panel (extension)     │
│  ┌─────────────┐   page ctx    ┌─────────────────────────┐  │
│  │ content.js  │──────────────▶│ sidepanel.js (UI shell) │  │
│  │ (merchant   │  title/og/    │  ask box → cards →      │  │
│  │  sites) or  │  JSON-LD      │  drop-in sheet          │  │
│  │  tabs API   │               └───────────┬─────────────┘  │
│  └─────────────┘                           │                │
│                       lib/keywords.js      │ lib/firmly-client.js
│                       (intent → keywords,  │ (pure fetch client)
│                        LLM SWAP-IN POINT)  │                │
│                                            │ lib/jwe.js     │
│                                            │ (card → JWE,   │
│                                            │  on-device)    │
└────────────────────────────────────────────┼────────────────┘
                                             │ HTTPS
                    ┌────────────────────────┴───────────────────────┐
                    │                Firmly platform                 │
                    │  api.firmly.work          cc.firmly.work       │
                    │  auth, discovery,         payment key,         │
                    │  catalog, cart, checkout  complete-order (PCI) │
                    └────────────────────────┬───────────────────────┘
                                             │ native merchant checkout
                                     Merchant (merchant of record)
```

Three modules carry all logic; the UI files are presentation only:

| Module | Responsibility | Environment coupling |
|---|---|---|
| `lib/firmly-client.js` | Auth/session lifecycle, every API call, 401-renew | None — pure `fetch`; runs in extension, web page, or Node |
| `lib/jwe.js` | Card object → JWE compact token | None — WebCrypto only |
| `lib/keywords.js` | Natural-language ask → `{keywords, buyIntent}` | None — pure functions; **replace with the browser's LLM** |

## 2. Session & device model

- `POST /api/v1/browser-session` with `x-firmly-app-id` returns a 1-hour JWT + `device_id`. Every subsequent call sends the JWT in `x-firmly-authorization`.
- **Carts are device-scoped.** The client persists `{access_token, expires, device_id}` (extension storage / localStorage) and renews by POSTing the prior token — this keeps the same device, and therefore carts, across restarts. A fresh session without the prior token is a new device with empty carts.
- On a 401 the client drops the stored session, re-creates one, and retries the request once.
- Sessions are stored keyed by App ID, so switching App IDs cannot leak carts between tenants.

## 3. Request flow per UX stage

```
ask "where can I buy this?"                    (page: Buds4 Pro review)
  │ parseAsk(): buyIntent=true, refers-to-page → keywords from page title
  ▼
POST /api/v1/discovery/search {query, filters:{domains:[targets], in_stock}, page_size}
  │ empty? → retry unscoped (demoFallback) + badge the results
  ▼
cards (title, merchant, price_range, variants[].add_to_cart_ref)
  │ Instant Buy
  ▼
PDP:  GET /api/v1/domains-products/{domain}/{handle}
  │ fallback → GET /api/v1/domains-pdp?url={pdp_url}
  │ fallback → use the discovery hit itself (already carries variants)
  ▼
configure: variant_option_values ↔ variants[].option1..3 → selected add_to_cart_ref
  │ Buy now
  ▼
DELETE /api/v1/domains/{d}/cart/line-items        (instant-buy = single-item order)
POST   /api/v2/domains/{d}/cart/line-items        {add_to_cart_ref, quantity}
POST   /api/v1/domains/{d}/cart/shipping-info     (profile-prefilled address)
  │ response: shipping_method_options, auto-selected method, tax, totals
  ▼
GET  https://cc.firmly.work/api/v1/payment/key    (fetched fresh; kid from x-firmly-kid)
JWE  encrypt {number,name,verification_value,month,year}  ← on-device, lib/jwe.js
POST https://cc.firmly.work/api/v1/payment/domains/{d}/complete-order
     {encrypted_card, billing_info}
  ▼
confirmation: cart_status=submitted, platform_line_item_id, urls.thank_you_page
```

Field notes that matter (all per the public docs):
- Shipping field is `state_or_province` (not `state`).
- Cart v2 GET requires the trailing slash; add-line-item takes the PDP variant's `add_to_cart_ref` verbatim.
- PDP-by-URL requires uppercase percent-encoding (`encodeURIComponent` is correct).
- Prices in discovery `price_range` are integer cents; cart totals are decimal values.

## 4. Payment security model

- Card fields are captured in the panel and **never leave the device in plaintext**: they are serialized and encrypted as an RFC 7516 JWE (RSA-OAEP-256 key wrap + AES-256-GCM content encryption, protected header as AAD) against Firmly's payment public key.
- The public key is fetched fresh before each encryption (it rotates); the `x-firmly-kid` response header is echoed as the JWE `kid`.
- Payment endpoints live on a **separate PCI-scoped host** (`cc.firmly.work`) so the catalog/cart stack stays out of PCI scope.
- CVV is captured per purchase and never persisted. The saved profile stores only number/name/expiry — standing in for the browser's own card-on-file, which replaces it in production.
- Implementation is ~60 lines of WebCrypto in `lib/jwe.js` — no third-party crypto, no Firmly-proprietary code.

## 5. App ID handling

- The App ID is a **public identifier, not a secret** — any browser client exposes it in DevTools. Nothing in the design depends on hiding it.
- What it controls is server-side: which merchants/environment the tenant sees, attribution, and metering. Compromise of an App ID exposes no user data (sessions are device-scoped; payment data is JWE-encrypted end-to-end).
- Hardening is server-side and per-App-ID: origin binding (e.g. to `chrome-extension://<id>`), rate limits, rotation. Rotation is config-only in this client.
- This repo ships **without an App ID** (`config.js` → empty; the panel prompts for it). Firmly provides the App ID through a separate channel.

## 6. Error handling & graceful degradation

| Condition | Behavior |
|---|---|
| Target merchants not enabled on the App ID | Unscoped retry + "demo catalog" badge (`demoFallback`) |
| Discovery hit missing `domain` | Derived from `pdp_url` hostname |
| PDP-by-handle unavailable for a merchant | Falls back to PDP-by-URL, then to the discovery hit itself |
| Shipping-method switch route unavailable | Keeps the auto-selected default, informs the user |
| Merchant without instant checkout | "Checkout unavailable" sheet + link to the merchant PDP |
| Token expiry / 401 | Silent renew + single retry |

## 7. Integration contract (what the browser replaces)

1. **The shopping agent** (`lib/llm.js` `agentRespond()`): the LLM receives the user message plus the page URL, title, and extracted readable content, and is given one tool — `search_products(keywords)`, backed by Firmly discovery. It answers conversationally and decides itself when a product search is relevant (the system prompt mandates searching on every product-related ask, informational ones included; truly non-product asks skip it). Works against any OpenAI-compatible chat-completions endpoint with function calling — Perplexity Sonar included (`endpoint: https://api.perplexity.ai/chat/completions`); Sonar's own browsing can even replace the local page-content extraction since the page URL is already in the prompt. **No key ships in this repo** — configured in `config.js` `llm` or the panel's Developer settings. With no key, a deterministic heuristic (`lib/keywords.js`) drives search-only behavior. Everything downstream is unchanged.
2. **Results UI**: `renderResults()` is plain DOM — replace with the browser's native surface; each card needs only the discovery-hit object.
3. **Profile pre-fill**: `loadProfile()/saveProfile()` — replace with the browser's profile store (name, email, phone, address).
4. **Card source**: the checkout card fields — replace with the browser's card-on-file (CVV entry remains per-purchase in this phase).
5. **Everything Firmly-side** (`lib/firmly-client.js`, `lib/jwe.js`) carries over as-is.

## 8. Known environment notes (UAT)

- Merchant visibility is provisioned per App ID tenant; a scoped search against un-enabled merchants returns `[]` (not an error).
- `domainAliases` maps a discovery/checkout domain mismatch on the demo merchant; remove when environments align.
- The cart-v2 shipping-method switch endpoint is documented but not yet deployed on UAT; the UI degrades to the default method.
