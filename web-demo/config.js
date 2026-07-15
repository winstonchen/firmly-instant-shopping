// Firmly environment + merchant-targeting configuration (web-demo build).
//
// The App ID is provisioned per integration partner by Firmly and is shared
// separately from this repository. Set it here, or at runtime via the
// browser console: localStorage.setItem('firmlyAppIdOverride', '<app id>')

export const FIRMLY_CONFIG = {
  // App ID provided by Firmly (shared separately — not committed to this repo).
  appId: '',

  apiBase: 'https://api.firmly.work',
  paymentBase: 'https://cc.firmly.work',

  targetDomains: [
    'samsung.com',
    'www.samsung.com',
    'bestbuy.com',
    'www.bestbuy.com'
  ],

  demoFallback: true,

  domainAliases: {
    'luma.gift': 'staging.luma.gift'
  },

  // LLM keyword extraction (the Sonar slot). Any OpenAI-compatible endpoint.
  // No key committed — set at runtime: localStorage.setItem('firmlyLlmKeyOverride', '<key>')
  llm: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiKey: ''
  },

  pageSize: 8
};
