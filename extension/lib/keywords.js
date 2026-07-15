// ── SONAR / LLM INTEGRATION POINT ───────────────────────────────────────────
// In the agreed flow the *browser* turns user intent + page URL into search
// keywords via its own Perplexity / Sonar keys, then hands the keywords to
// Firmly. This module is the placeholder for that hop: it derives keywords
// from page context with plain heuristics so the extension works standalone.
//
// To integrate: replace deriveKeywords() with a call to the browser's LLM
// endpoint and return its keyword string. Everything downstream (Firmly
// discovery → cards → drop-in checkout) is unchanged.
// ────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'on', 'at', 'to',
  'by', 'buy', 'shop', 'online', 'best', 'new', 'official', 'site', 'store',
  'home', 'page', 'deals', 'price', 'prices', 'review', 'reviews', 'us'
]);

// Words to drop when the user phrases the query as a question to the agent.
const QUESTION_FILLER = new Set([
  'where', 'can', 'i', 'you', 'do', 'does', 'how', 'much', 'is', 'are', 'the',
  'a', 'an', 'to', 'from', 'buy', 'purchase', 'get', 'order', 'show', 'me',
  'find', 'for', 'about', 'what', 'whats', 'price', 'of', 'available', 'want',
  'please', 'similar', 'like', 'this', 'it', 'one', 'that', 'tell', 'more',
  'looking', 'need', 'my', 'in', 'stock', 'shop', 'cheapest', 'best'
]);

// Site-name suffixes commonly appended to titles ("… | Samsung US", "… - Best Buy").
const SITE_SUFFIX = /\s*[|\-–—:]\s*(samsung(\s+us)?|best\s*buy|bestbuy(\.com)?|luma.*)\s*$/i;

/**
 * @param {object} ctx { productName?, ogTitle?, title?, url?, query? }
 * @returns {string} space-separated search keywords for Firmly discovery
 */
export function deriveKeywords(ctx = {}) {
  if (ctx.query && ctx.query.trim()) return ctx.query.trim();

  let source = ctx.productName || ctx.ogTitle || ctx.title || '';
  source = source.replace(SITE_SUFFIX, '');
  // Generic publisher suffix: "Product name … | WIRED", "… - The Verge".
  const parts = source.split(/\s+[|–—]\s+/);
  if (parts.length > 1 && parts[parts.length - 1].split(/\s+/).length <= 3) {
    parts.pop();
    source = parts.join(' ');
  }

  const tokens = source
    .toLowerCase()
    .replace(/["'’‘“”(),!?#®™:;]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && t.length > 1);

  const seen = new Set();
  const keywords = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      keywords.push(t);
    }
    if (keywords.length >= 8) break;
  }
  return keywords.join(' ');
}

/**
 * Interpret a natural-language ask ("where can I buy this?", "how much is the
 * frame tv?") into { keywords, buyIntent, usedPageContext }.
 *
 * This is the second half of the Sonar swap-in point: the browser's LLM would
 * do this interpretation. The heuristic: detect purchase intent, drop question
 * filler; if the ask refers to "this" (or nothing product-like remains), fall
 * back to the page context the user is looking at.
 */
export function parseAsk(text, ctx = {}) {
  const q = (text || '').trim();
  const lower = q.toLowerCase();

  const buyIntent =
    /\b(buy|purchase|order|get one|shop|price|cost|deal|want)\b/.test(lower) ||
    /how much/.test(lower) ||
    /where.*\b(from|at)\b/.test(lower);
  const refersToPage = /\b(this|it|that one|similar)\b/.test(lower);

  const remainder = lower
    .replace(/["'’?!.,()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !QUESTION_FILLER.has(t))
    .join(' ')
    .trim();

  let keywords = remainder;
  let usedPageContext = false;
  if ((refersToPage || !keywords) && (ctx.productName || ctx.ogTitle || ctx.title)) {
    keywords = deriveKeywords(ctx);
    usedPageContext = true;
  }
  if (!keywords) keywords = q;
  return { keywords, buyIntent, usedPageContext };
}
