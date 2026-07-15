// Firmly API client — plain ES module with no extension-API dependencies so
// the identical code runs in the side panel, a service worker, or Node.
//
// Endpoints per https://developers.firmly.ai/ :
//   api host  — auth, discovery, catalog, cart, checkout
//   payment host — public key + complete-order (PCI-scoped, separate host)

export class FirmlyClient {
  /**
   * @param {object} opts
   * @param {string} opts.appId        x-firmly-app-id value
   * @param {string} opts.apiBase      e.g. https://api.firmly.work
   * @param {string} opts.paymentBase  e.g. https://cc.firmly.work
   * @param {object} [opts.tokenStore] { load(): Promise<obj|null>, save(obj): Promise } —
   *   persists { access_token, expires, device_id } so the Firmly device (and
   *   therefore carts) survives restarts. Defaults to in-memory.
   */
  constructor({ appId, apiBase, paymentBase, tokenStore }) {
    this.appId = appId;
    this.apiBase = apiBase;
    this.paymentBase = paymentBase;
    this.tokenStore = tokenStore || memoryTokenStore();
  }

  // ---- auth ---------------------------------------------------------------

  /**
   * Returns a valid access token, creating or renewing the browser session as
   * needed. Renewal passes the prior token so the device_id (and carts) are
   * kept.
   */
  async ensureSession() {
    const saved = await this.tokenStore.load();
    const now = Math.floor(Date.now() / 1000);
    if (saved && saved.expires && saved.expires - now > 120) {
      return saved.access_token;
    }
    const body = saved && saved.access_token ? { access_token: saved.access_token } : undefined;
    const res = await fetch(`${this.apiBase}/api/v1/browser-session`, {
      method: 'POST',
      headers: {
        'x-firmly-app-id': this.appId,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw await asApiError(res, 'browser-session');
    const session = await res.json();
    await this.tokenStore.save({
      access_token: session.access_token,
      expires: session.expires,
      device_id: session.device_id
    });
    return session.access_token;
  }

  async _request(method, path, { base, body, query } = {}) {
    const token = await this.ensureSession();
    const url = new URL((base || this.apiBase) + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const doFetch = (tok) =>
      fetch(url, {
        method,
        headers: {
          'x-firmly-authorization': tok,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    let res = await doFetch(token);
    if (res.status === 401) {
      // Session invalidated server-side — renew once and retry.
      await this.tokenStore.save(null);
      res = await doFetch(await this.ensureSession());
    }
    if (!res.ok) throw await asApiError(res, path);
    return res.json();
  }

  // ---- discovery ------------------------------------------------------------

  /**
   * Keyword search across merchant catalogs.
   * filters: { domains?: string[], in_stock?: boolean, min_price?: cents, max_price?: cents }
   */
  search(query, { domains, inStock = true, minPrice, maxPrice, pageSize = 8, page } = {}) {
    const filters = {};
    if (domains && domains.length) filters.domains = domains;
    if (inStock !== undefined) filters.in_stock = inStock;
    if (minPrice !== undefined) filters.min_price = minPrice;
    if (maxPrice !== undefined) filters.max_price = maxPrice;
    return this._request('POST', '/api/v1/discovery/search', {
      body: { query, filters, page_size: pageSize, ...(page ? { page } : {}) }
    });
  }

  // ---- catalog --------------------------------------------------------------

  getProduct(domain, handle) {
    return this._request('GET', `/api/v1/domains-products/${domain}/${encodeURIComponent(handle)}`);
  }

  /** Product details from a merchant PDP URL (percent-encoding must be uppercase — encodeURIComponent is). */
  getProductByUrl(pdpUrl, postalCode) {
    return this._request('GET', '/api/v1/domains-pdp', {
      query: { url: pdpUrl, ...(postalCode ? { postal_code: postalCode } : {}) }
    });
  }

  // ---- cart -----------------------------------------------------------------

  /** addToCartRef comes verbatim from a PDP variant's `add_to_cart_ref`. */
  addLineItem(domain, addToCartRef, quantity = 1) {
    return this._request('POST', `/api/v2/domains/${domain}/cart/line-items`, {
      body: { add_to_cart_ref: addToCartRef, quantity }
    });
  }

  getCart(domain) {
    // Trailing slash is required by the v2 route.
    return this._request('GET', `/api/v2/domains/${domain}/cart/`);
  }

  clearCart(domain) {
    return this._request('DELETE', `/api/v1/domains/${domain}/cart/line-items`);
  }

  // ---- checkout ---------------------------------------------------------------

  /**
   * info: { first_name, last_name, email, phone, address1, address2?, city,
   *         state_or_province, postal_code, country }
   * Response carries shipping_method_options, auto-selected shipping_method,
   * tax and total.
   */
  setShippingInfo(domain, info) {
    return this._request('POST', `/api/v1/domains/${domain}/cart/shipping-info`, { body: info });
  }

  /**
   * Switch shipping method (Cart v2). Note: not yet deployed on the UAT
   * environment (returns 404 RouteNotFound) — callers should treat failure as
   * "keep the auto-selected default".
   */
  setShippingMethod(domain, shipmentId, shippingMethodId) {
    return this._request('POST', `/api/v2/domains/${domain}/cart/shipments/shipping-method`, {
      body: { shipment_id: shipmentId, shipping_method_id: shippingMethodId }
    });
  }

  // ---- payment (PCI host) ------------------------------------------------------

  /** Fetch fresh before every encryption — the key rotates. Returns { jwk, kid }. */
  async getPaymentKey() {
    const res = await fetch(`${this.paymentBase}/api/v1/payment/key`);
    if (!res.ok) throw await asApiError(res, 'payment/key');
    const jwk = await res.json();
    return { jwk, kid: res.headers.get('x-firmly-kid') || jwk.kid };
  }

  /**
   * Places the order. encryptedCard is the JWE compact token from lib/jwe.js.
   * billingInfo uses the same field names as shipping info.
   */
  completeOrder(domain, encryptedCard, billingInfo) {
    return this._request('POST', `/api/v1/payment/domains/${domain}/complete-order`, {
      base: this.paymentBase,
      body: { encrypted_card: encryptedCard, billing_info: billingInfo }
    });
  }
}

async function asApiError(res, context) {
  let detail = '';
  try {
    const data = await res.json();
    detail = data.error ? `${data.error}: ${data.description || ''}` : JSON.stringify(data);
  } catch {
    detail = await res.text().catch(() => '');
  }
  const err = new Error(`Firmly ${context} failed (${res.status}) ${detail}`.trim());
  err.status = res.status;
  return err;
}

function memoryTokenStore() {
  let value = null;
  return {
    load: async () => value,
    save: async (v) => { value = v; }
  };
}
