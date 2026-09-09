# Tests

Unit tests for every module in `extension/lib/` (the web-demo shares the same
files). Node ≥ 18, zero dependencies, zero network — `fetch` is mocked and the
fixtures are captured Firmly API payloads.

```
cd tests
npm test
```

| Suite | Module under test | What it locks in |
|---|---|---|
| `unit/configurator.test.mjs` | `lib/configurator.js` | the variant configurator: chip states on sparse Model × Size matrices, auto-repair selection, numeric size ordering, per-variant price/MSRP/image/add_to_cart_ref |
| `unit/firmly-client.test.mjs` | `lib/firmly-client.js` | session lifecycle (create/reuse/renew, 401 retry), endpoint paths, request shaping, error surfacing |
| `unit/jwe.test.mjs` | `lib/jwe.js` | JWE compact structure and full encrypt→decrypt roundtrip (RSA-OAEP-256 + A256GCM) |
| `unit/keywords.test.mjs` | `lib/keywords.js` | heuristic keyword derivation and ask parsing (the no-LLM fallback path) |
| `unit/llm.test.mjs` | `lib/llm.js` | the tool-calling agent loop: search round-trip, history, failure → heuristic fallback |

`fixtures/` holds real product payloads from the Firmly catalog API
(public product data only — no credentials, no session tokens):
three bestbuy.com TVs with a single Screen Size Class group, and three
samsung.com TVs with sparse Model × Size matrices (e.g. Neo QLED QN90F:
4 models × 9 sizes, 21 real variants). These shapes are what the
configurator exists to handle.
