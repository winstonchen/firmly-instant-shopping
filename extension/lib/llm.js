// ── LLM keyword extraction (the Sonar/Perplexity slot, working reference) ──
// Turns a natural-language ask + page context into product-search keywords
// using any OpenAI-compatible chat-completions endpoint. In the production
// integration the browser calls its own LLM (e.g. Perplexity Sonar — which is
// OpenAI-compatible: endpoint https://api.perplexity.ai/chat/completions)
// with its own key. No key ships in this repo — see config.js / the panel's
// Developer settings.
//
// Falls back to null on any failure; callers use the heuristic in
// keywords.js as the fallback path.

const SYSTEM_PROMPT = `You convert a shopper's ask (plus the title of the page they are reading, when given) into e-commerce product search keywords.
Reply ONLY with JSON: {"keywords": string, "buy_intent": boolean, "is_question": boolean}
Rules:
- keywords: 2-8 terms naming the product (brand, model, product type, key attribute). No verbs (buy/get/find), no question words, no publisher names.
- buy_intent: true if the shopper wants to buy/own the product or asks price/availability/where-from; false for purely informational asks.
- is_question: true when the shopper asks ABOUT the product (features, specs, comparisons, "is it good for X", differences) rather than only where/how to buy it.
- If the ask refers to "this" or the page, derive the product from the page title.`;

const ANSWER_PROMPT = `You are a shopping assistant inside a browser side panel. Answer the shopper's question in 2-3 short plain sentences (no markdown, no lists).
Ground your answer in the page title and the product data provided (titles, prices, descriptions from real merchant catalogs). You may add well-known general facts about the product; do not invent specs. If the data does not cover the question, say so briefly and share what is known. End without asking a follow-up question.`;

const AGENT_PROMPT = `You are Instant Shopping — an intelligent shopping agent living in the Samsung Browser side panel, powered by Firmly.
You receive the page the user is reading (URL, title, extracted content) and their message.

How to behave:
- Answer naturally and concisely (2-4 short plain sentences, no markdown, no lists), grounded in the page content and any product data you retrieve. Do not invent specs.
- MANDATORY: if the user's message OR the page involves any specific product or product category — even for purely informational questions (features, specs, comparisons) — you MUST call search_products BEFORE composing your answer. Never offer to search or ask if they want options; just search. Keywords: brand, model, product type, key attribute; no verbs, no question words.
- This applies to EVERY turn: cards are attached per answer, so call search_products again in each product-related turn even if you searched in an earlier turn of this conversation.
- Purchasable results render as Instant Buy cards under your answer. After results arrive, weave price and availability naturally into the answer, e.g. "It's $249.99 at Best Buy — tap Instant Buy below to get it."
- If the search returns nothing relevant, still answer helpfully and say nothing about the search.
- Only skip search_products when neither the message nor the page has any product angle at all.
- Never end with a question or an offer; end with the answer (and the Instant Buy pointer when products are shown).`;

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search_products',
    description:
      'Search real merchant catalogs (Best Buy, Samsung, and other Firmly-enabled merchants) for purchasable products. Results render as Instant Buy cards under your answer.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'string',
          description: 'Product search keywords: brand, model, product type, key attribute. No verbs or question words.'
        }
      },
      required: ['keywords']
    }
  }
};

/**
 * Agent loop: the LLM sees the user message + page context and decides
 * whether (and what) to search; searchFn executes Firmly discovery and
 * returns the product list (also rendering it progressively in the UI).
 *
 * @param {string} ask
 * @param {object} ctx { url?, title?, ogTitle?, productName?, pageText? }
 * @param {object} cfg { endpoint, model, apiKey }
 * @param {(keywords: string) => Promise<Array>} searchFn
 * @param {object} [opts] { history?: Array<{role:'user'|'assistant', content:string}>, timeoutMs?: number }
 * @returns {Promise<{answer: string, searched: boolean, keywords: string|null}|null>} null = LLM unavailable/failed
 */
export async function agentRespond(ask, ctx = {}, cfg = {}, searchFn, opts = {}) {
  if (!cfg.apiKey || !cfg.endpoint || !cfg.model) return null;
  const timeoutMs = opts.timeoutMs || 30000;
  const pageBits = [
    `Page URL: ${ctx.url || '(none)'}`,
    `Page title: ${ctx.productName || ctx.ogTitle || ctx.title || '(none)'}`,
    `Page content: ${(ctx.pageText || '').slice(0, 2200) || '(none)'}`
  ].join('\n');
  const messages = [
    { role: 'system', content: AGENT_PROMPT },
    ...(opts.history || []),
    { role: 'user', content: `${pageBits}\n\nUser: ${ask}` }
  ];

  let searched = false;
  let keywords = null;
  try {
    for (let round = 0; round < 3; round++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          tools: [SEARCH_TOOL],
          tool_choice: 'auto',
          max_tokens: 320,
          temperature: 0.2
        })
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const msg = (await res.json()).choices[0].message;
      messages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          let content = '[]';
          if (tc.function && tc.function.name === 'search_products') {
            searched = true;
            try {
              keywords = (JSON.parse(tc.function.arguments || '{}').keywords || '').slice(0, 120) || null;
            } catch { keywords = null; }
            const products = await searchFn(keywords || ask);
            content = JSON.stringify(
              (products || []).slice(0, 5).map((p) => ({
                title: p.title,
                price: p.price_range ? `$${(p.price_range.min / 100).toFixed(2)}` : undefined,
                merchant: p.domain_name || p.domain,
                available: p.has_available_variants,
                description: (p.description || '').slice(0, 200)
              }))
            );
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content });
        }
        continue;
      }
      return { answer: (msg.content || '').trim(), searched, keywords };
    }
    return { answer: '', searched, keywords };
  } catch {
    return null;
  }
}

/**
 * @param {string} ask         the user's natural-language input
 * @param {object} ctx         { productName?, ogTitle?, title?, url? } page context
 * @param {object} cfg         { endpoint, model, apiKey }
 * @param {number} [timeoutMs]
 * @returns {Promise<{keywords: string, buyIntent: boolean}|null>} null on any failure
 */
export async function llmExtractKeywords(ask, ctx = {}, cfg = {}, timeoutMs = 8000) {
  if (!cfg.apiKey || !cfg.endpoint || !cfg.model) return null;
  const pageTitle = ctx.productName || ctx.ogTitle || ctx.title || '';
  const user = `Ask: ${ask}${pageTitle ? `\nPage title: ${pageTitle}` : ''}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 80,
        temperature: 0
      })
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    if (!parsed.keywords || typeof parsed.keywords !== 'string') return null;
    return {
      keywords: parsed.keywords.slice(0, 120),
      buyIntent: !!parsed.buy_intent,
      isQuestion: !!parsed.is_question
    };
  } catch {
    return null;
  }
}

/**
 * Answer an informational product question, grounded in the page context and
 * the matched products' catalog data (from Firmly discovery).
 *
 * @param {string} ask
 * @param {object} ctx       page context ({ productName?, ogTitle?, title? })
 * @param {Array}  products  discovery hits — title/price/description are used
 * @param {object} cfg       { endpoint, model, apiKey }
 * @returns {Promise<string|null>} plain-text answer, or null on failure
 */
export async function llmAnswerQuestion(ask, ctx = {}, products = [], cfg = {}, timeoutMs = 10000) {
  if (!cfg.apiKey || !cfg.endpoint || !cfg.model) return null;
  const pageTitle = ctx.productName || ctx.ogTitle || ctx.title || '';
  const productData = products.slice(0, 3).map((p) => ({
    title: p.title,
    price: p.price_range ? `$${(p.price_range.min / 100).toFixed(2)}` : undefined,
    merchant: p.domain_name || p.domain,
    description: (p.description || '').slice(0, 500)
  }));
  const user = `Question: ${ask}${pageTitle ? `\nPage title: ${pageTitle}` : ''}\nMatched products: ${JSON.stringify(productData)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: ANSWER_PROMPT },
          { role: 'user', content: user }
        ],
        max_tokens: 220,
        temperature: 0.2
      })
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const answer = (data.choices[0].message.content || '').trim();
    return answer || null;
  } catch {
    return null;
  }
}
