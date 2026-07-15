# FAQ — for browser-team engineers

Practical answers for working with this codebase: where things live, what to change for your integration, and what to leave alone. Companion to [DESIGN.md](DESIGN.md) (architecture + sequence diagrams).

---

## 1. Where is what?

| Path | What it is | Typical reason you'd touch it |
|---|---|---|
| `extension/manifest.json` | MV3 manifest: side panel, permissions, content-script sites | Rename, icons, add sites |
| `extension/config.js` | **All configuration**: App ID, API hosts, target merchants, LLM endpoint/model/key | Most integration changes start here |
| `extension/sidepanel.html/.css/.js` | The entire UI: chat thread, product carousel, drop-in checkout sheet, ⚙ settings | Replace with your native UI |
| `extension/lib/firmly-client.js` | Pure Firmly API client (~200 lines, plain `fetch`, no browser APIs) | Shouldn't need changes — reuse as-is |
| `extension/lib/jwe.js` | Card encryption (RFC 7516 JWE via WebCrypto) | Do not change (see §7) |
| `extension/lib/llm.js` | The shopping-agent loop (LLM + `search_products` tool) and prompts | Point at your LLM (§3) |
| `extension/lib/keywords.js` | Deterministic fallback when no LLM key is configured | Rarely |
| `extension/content.js` | Page-context extraction on merchant sites | Add merchant sites |
| `extension/background.js` | 3 lines: opens the side panel on toolbar click | Rarely |
| `web-demo/` | The same panel as a plain web page (no extension APIs) — proof the code is environment-portable | Reference for native embedding (§8) |

No build step, no dependencies, no TypeScript — every file is vanilla ES modules you can read top to bottom.

## 2. Where do I set the App ID?

Two places, in precedence order:

1. **Runtime (no code change):** panel → **⚙ → Setup → Firmly App ID → Save**. Stored in `chrome.storage.local` under `firmlyAppIdOverride`.
2. **Code default:** `extension/config.js` → `appId: '<your app id>'`.

The runtime override wins when both are set. The ⚙ screen shows which is active (`(default)` vs `(override)`). Sessions are stored **keyed per App ID** (`firmlySession:<appId>` in `sidepanel.js`), so switching IDs never mixes carts between tenants.

## 3. Where do I plug in our Perplexity / Sonar key?

`extension/config.js` → the `llm` block:

```js
llm: {
  endpoint: 'https://api.perplexity.ai/chat/completions',  // any OpenAI-compatible endpoint
  model: 'sonar',                                          // your model
  apiKey: ''                                               // your key — or set at runtime via ⚙ → Setup → LLM API key
}
```

The runtime override (`firmlyLlmKeyOverride` in storage) beats the config value, same pattern as the App ID.

**What the endpoint must support:** OpenAI-format `chat/completions` **with function calling** — the agent loop (`lib/llm.js` → `agentRespond()`) gives the model one tool, `search_products(keywords)`, and lets it decide when to search. If your model doesn't support tool calling, you have two options:

- **Replace the orchestration** (recommended for the real integration anyway): in `sidepanel.js` → `runAsk()`, the agent seam is one call — `agentRespond(text, ctx, llmCfg, searchFn, {history})` returning `{answer, searched}`. Substitute your own agent that calls `searchFn(keywords)` whenever it wants products rendered; everything downstream is untouched.
- **No LLM at all:** leave `apiKey` empty — the panel falls back to `lib/keywords.js` (deterministic keyword extraction) and works as pure search.

Also note: the page **URL** is already in the prompt (`Page URL: …`), so a browsing-capable model like Sonar can fetch the page itself and you can drop the local page-text extraction entirely.

## 4. Where does the page context come from?

Three layers, in `sidepanel.js` → `getPageContext()`:

1. `content.js` message — on the merchant sites listed in `manifest.json` `content_scripts.matches` (rich product context incl. JSON-LD).
2. On-demand injection — `chrome.scripting.executeScript` with the `extractPageContext()` function, allowed by the `activeTab` grant (user invoked the extension on that tab). Works on any page without broad host permissions.
3. Fallback — tab title/URL via the `tabs` API.

The context object: `{ url, host, title, ogTitle, ogType, metaDescription, productName, pageText }` (`pageText` capped at 2,500 chars). In your browser you'd replace all three layers with your own page-understanding pipeline — just produce the same object shape.

## 5. Where do I prefill the user's address from the browser profile?

`sidepanel.js` — three small functions are the entire seam:

- `loadProfile()` / `saveProfile(p)` — currently `chrome.storage.local` key `firmlyProfile`. **Replace these two with reads from your browser profile store.**
- `addressFrom(profile)` — maps the profile to the Firmly shipping payload. Field names matter (`state_or_province`, not `state`):

```js
{ first_name, last_name, email, phone, address1, city, state_or_province, postal_code, country }
```

Consumption points: `startCheckout()` auto-applies the address when the profile is complete (`profileHasAddress()`), and `renderCheckout()` prefills the editable form. Nothing else reads the profile.

## 6. Where do I prefill the card from the browser's card-on-file?

Same `firmlyProfile` object, fields `card_number`, `card_name`, `card_month`, `card_year` — **CVV is never stored**; it's captured per purchase in the checkout form (`#payForm`), by design for this phase.

Flow at purchase (`sidepanel.js` → `placeOrder()`):

```js
const { jwk, kid } = await client.getPaymentKey();          // fresh public key, PCI host
const encryptedCard = await encryptCardJWE({
  number, name, verification_value /* CVV */, month, year   // all strings
}, jwk, kid);
await client.completeOrder(domain, encryptedCard, billingInfo);
```

To use your card-on-file: source `number/name/month/year` from your store instead of the profile fields, keep the CVV prompt, and leave the encryption exactly as is. The card object never exists outside the device unencrypted.

## 7. What must NOT change?

- **`lib/jwe.js`** — the JWE construction (RSA-OAEP-256 + A256GCM, protected header as AAD) is what the Firmly payment service decrypts. Fetch the key fresh each purchase; echo the `x-firmly-kid` header as the JWE `kid`.
- **The PCI host split** — payment key + `complete-order` go to `cc.firmly.work`; everything else to `api.firmly.work`. Don't proxy card traffic through your own backend.
- **Session renewal semantics** (`lib/firmly-client.js` → `ensureSession()`) — renewing with the prior token preserves the device ID, which is what keeps carts alive. A fresh session without it is a new device with empty carts.

## 8. How does this integrate into the browser natively (not as an extension)?

The code is deliberately layered for that:

- **`lib/firmly-client.js` and `lib/jwe.js` have zero browser-extension dependencies** — plain `fetch` + WebCrypto. They run unchanged in any web/renderer context (they also run in Node).
- **`web-demo/` is the existence proof**: the identical panel as a plain web page, with `localStorage` standing in for extension storage and no page-context capture. Diff `web-demo/app.js` against `extension/sidepanel.js` to see exactly which lines are extension-specific — it's only storage, tabs, and the context capture.
- So the native integration is: keep the two lib modules + the API sequences from [DESIGN.md](DESIGN.md) §3, and rebuild the presentation in your own UI stack. The drop-in sheet's states (configure → checkout → confirmation) map 1:1 to the API calls.
- CORS: Firmly's API serves permissive CORS, so calls work from any origin — no proxy needed even from a plain webview.

## 9. Where do I change the target merchants?

`config.js` → `targetDomains` (discovery is scoped to these first) and `demoFallback` (when a scoped search finds nothing, retry across all merchants enabled on your App ID and badge the results as demo catalog). Which merchants an App ID can actually transact on is provisioned server-side by Firmly per tenant — `targetDomains` only scopes the search.

`domainAliases` handles a current UAT quirk (demo store indexed as `luma.gift`, checkout on `staging.luma.gift`); remove once environments align.

## 10. How do I test safely?

- **Demo merchant (full checkout OK):** search `abominable hoodie` → the Luma staging store. Test card `4111 1111 1111 1111`, any future expiry/CVV — places a real sandbox order with an order ID.
- **Live merchants (browse + cart only):** Best Buy / samsung.com products, PDP, add-to-cart, and shipping/tax quotes are all real — but **do not press Place order** on them in UAT.
- The repo ships with an automated reference of the whole flow in `docs/DESIGN.md` §3; every step is a plain `curl`-able API call if you want to verify outside the extension.

## 11. Common issues

| Symptom | Cause / fix |
|---|---|
| "No Firmly App ID configured" | Set it via ⚙ → Setup (or `config.js`). |
| Search returns nothing for real products | Your App ID's tenant doesn't have those merchants enabled — ask Firmly. The demo badge tells you fallback kicked in. |
| Answers are keyword-y, not conversational | No LLM key configured (or the LLM call failed — the panel falls back to heuristics silently; check the panel console). |
| Products differ from the agent's answer | The agent may search more than once; only the final result set renders. |
| Cart disappeared after restart | Sessions renew with the prior token to keep the device; if storage was cleared, a new device (empty carts) is expected. |
| 401s in console | Normal once per hour — the client renews and retries automatically. |
