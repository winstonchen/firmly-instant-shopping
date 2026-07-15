# Firmly Instant Shopping — browser extension reference implementation

A lightweight Chrome (Manifest V3) extension demonstrating **in-browser instant shopping powered by the [Firmly API](https://developers.firmly.ai/)**: ask about a product while reading any page, see matching products from real merchants, and complete the purchase — product configuration, address, shipping, card entry, and order placement — inside a single side-panel sheet, without leaving the page.

Built as a reference for browser-vendor integration. It is intentionally a **simple, self-contained implementation on Firmly's public API**: no SDK, no build step, no third-party dependencies, ~1,100 lines of vanilla ES modules.

## The flow it implements

| # | Step | Where |
|---|---|---|
| 1 | Browser captures user query + page URL/title/content | `extension/content.js` (all pages) + tabs API |
| 2 | **Shopping agent**: LLM answers the ask and decides when product search is relevant (tool-calling; browser's own LLM in production) | `extension/lib/llm.js` `agentRespond()` — **bring your own key**; heuristic fallback in `lib/keywords.js` |
| 3 | Agent invokes Firmly product search whenever a shopping opportunity exists | `POST /api/v1/discovery/search` |
| 4 | Answer + Instant Buy cards rendered (browser's own UI in production) | side-panel agent line + product grid |
| 5 | Buy → drop-in: configure variant + add to cart | drop-in sheet, Cart API |
| 6 | Card captured on the same screen, encrypted on-device | `extension/lib/jwe.js` (RFC 7516 JWE via WebCrypto) |
| 7 | Order placed, pre-filled from profile | `complete-order` on the PCI-scoped host |

The agent behaves like a shopping assistant: ask *"what are the features of these earbuds?"* on a review page and it answers from the page + real catalog data, with purchasable product cards underneath; ask *"where can I buy this?"* and it answers with live price + merchant ("It's $249.99 at Best Buy — tap Instant Buy below"). The content script runs on all pages solely to extract the page's readable text for grounding — nothing is collected or transmitted anywhere except to the configured LLM endpoint at ask time.

## Repository layout

```
extension/            The MV3 extension (load unpacked)
  manifest.json       Side panel, service worker, content scripts, host permissions
  config.js           Environment + merchant targeting (App ID NOT committed — see below)
  background.js       Opens the side panel from the toolbar icon
  content.js          Page-context capture (product name / title) on merchant sites
  sidepanel.*         The panel UI: ask box → cards → drop-in checkout
  lib/firmly-client.js  Pure API client (no extension APIs — also runs in Node)
  lib/jwe.js          Card encryption: JWE RSA-OAEP-256 + A256GCM, WebCrypto only
  lib/keywords.js     Intent/keyword heuristics — the LLM swap-in point
web-demo/             The same panel as a plain static web page (zero-install demo)
docs/DESIGN.md        Architecture, API sequences, security model, integration contract
```

## Setup

1. **Get an App ID from Firmly** — it is shared separately, never committed to this repo.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`.
3. Pin the icon, click it to open the side panel.
4. Set the App ID: **⚙ → Developer → App ID override → Save** (or put it in `config.js` locally).
5. Optional but recommended — **LLM keywords (bring your own key)**: paste any OpenAI-compatible API key in **⚙ → Developer → LLM API key** (or configure `llm` in `config.js`; Perplexity Sonar works by pointing `endpoint` at `https://api.perplexity.ai/chat/completions`). Without a key, a built-in heuristic derives keywords — everything still works, LLM just understands asks better.
6. Optional: **⚙** → save a profile (name/address/card without CVV) to see checkout pre-fill.

## Try it

- Open a product review article (e.g. a TV or earbuds review) → the panel shows the page context → tap **Shop this page** or ask **“Where can I buy this?”**
- Or type a question: `where can I buy samsung galaxy buds 4 pro`
- Tap **Instant Buy** on a card → pick options → **Buy now** → address (pre-filled), live shipping + tax, card + CVV on one screen → **Place order** → confirmation with the merchant order reference.

On the Firmly UAT demo merchant, test card `4111 1111 1111 1111` (any future expiry, any CVV) completes real sandbox orders.

## Web demo (no install)

`web-demo/` is the identical experience as a static web page — same `lib/` modules, `localStorage` in place of extension storage. Host it anywhere static or run locally:

```bash
cd web-demo && ./run-local.sh   # serves on :8090 and opens the browser
```

## What this repo is (and isn't)

- **Is**: a clean-room reference client for Firmly's public API surface — every endpoint used is documented at [developers.firmly.ai](https://developers.firmly.ai/) ([OpenAPI](https://developers.firmly.ai/openapi.json)).
- **Isn't**: an SDK or any part of Firmly's product code. Nothing here is proprietary to Firmly's platform internals; card encryption is standard RFC 7516 done with the browser's WebCrypto.

See [docs/DESIGN.md](docs/DESIGN.md) for architecture, sequence diagrams, the security model, and the exact integration contract (LLM keywords, browser profile, card source).

---

© 2026 firmly.ai — released under the [MIT License](LICENSE). Firmly App IDs are provisioned per integration partner and shared separately.
