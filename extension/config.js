// Firmly environment + merchant-targeting configuration.
//
// The App ID is provisioned per integration partner by Firmly and is shared
// separately from this repository. Set it here, or at runtime without
// touching code via the panel: ⚙ → Developer → App ID override.

export const FIRMLY_CONFIG = {
  // App ID provided by Firmly (shared separately — not committed to this repo).
  appId: '',

  // Firmly UAT environment. Payment endpoints live on a separate PCI-scoped
  // host by design — see docs/DESIGN.md.
  apiBase: 'https://api.firmly.work',
  paymentBase: 'https://cc.firmly.work',

  // Merchants this build targets: discovery search is scoped to these first.
  // Which merchants an App ID can actually see is provisioned server-side by
  // Firmly per tenant.
  targetDomains: [
    'samsung.com',
    'www.samsung.com',
    'bestbuy.com',
    'www.bestbuy.com'
  ],

  // When a target-scoped search returns no products (e.g. merchants not yet
  // enabled on the App ID), retry unscoped across all enabled merchants and
  // flag the results as demo-catalog in the UI.
  demoFallback: true,

  // UAT quirk: discovery may report the demo merchant as `luma.gift` while
  // its checkout is provisioned on `staging.luma.gift` (same catalog).
  // Remove once the environments align.
  domainAliases: {
    'luma.gift': 'staging.luma.gift'
  },

  // ── LLM keyword extraction (the Sonar slot) ──────────────────────────────
  // Any OpenAI-compatible chat-completions endpoint works. For Samsung this
  // is where Perplexity Sonar plugs in with the browser's own key, e.g.:
  //   endpoint: 'https://api.perplexity.ai/chat/completions', model: 'sonar'
  // No key is committed to this repo — bring your own. Set it here or at
  // runtime via ⚙ → Developer → LLM API key. With no key configured the
  // extension falls back to the built-in heuristic (lib/keywords.js).
  llm: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiKey: ''
  },

  pageSize: 8
};
