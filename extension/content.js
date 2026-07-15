// Page-context capture on target merchant sites (samsung.com, bestbuy.com,
// demo store). Extracts the product name / page title so the side panel can
// turn "what the user is looking at" into search keywords.
//
// In the agreed flow this is step 1: browser captures user intent/query +
// page URL. The side panel requests this context on demand.

function jsonLdProductName() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const node of nodes) {
        const type = node && node['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
          if (node.name) return String(node.name);
        }
      }
    } catch {
      /* malformed JSON-LD on the page — ignore */
    }
  }
  return null;
}

function metaContent(selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute('content') : null;
}

// Main readable content of the page, for the agent to ground its answers in.
function pageText() {
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.body;
  const text = (root && root.innerText) || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 2500);
}

function pageContext() {
  return {
    url: location.href,
    host: location.hostname,
    title: document.title,
    ogTitle: metaContent('meta[property="og:title"]'),
    ogType: metaContent('meta[property="og:type"]'),
    metaDescription: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
    productName: jsonLdProductName(),
    pageText: pageText()
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'FIRMLY_GET_PAGE_CONTEXT') {
    sendResponse(pageContext());
  }
});
