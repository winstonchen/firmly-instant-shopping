// Variant configurator engine for the Instant Buy sheet — pure ES module (no
// DOM, no extension APIs) so the identical code runs in the panel and in the
// Node test harness.
//
// Real catalogs make this non-trivial:
//   - samsung.com TVs expose sparse Model × Size matrices (e.g. Neo QLED
//     QN90F: 4 models × 9 sizes = 36 combos, only 21 variants exist) — many
//     option combinations simply have no variant.
//   - Option values arrive lexicographically sorted (100", 115", 43", …).
//   - Some variants carry image entries whose url is the string "undefined".
//   - bestbuy.com uses a single "Screen Size Class" group with out-of-stock
//     sizes mixed in.
//
// The engine guarantees: the selection always resolves to a real variant
// (auto-repair), every option value has a render state, and price / MSRP /
// image / add_to_cart_ref always describe the selected variant.

/** Groups that actually have option values (v0.4.1 semantics). */
export function optionGroups(product) {
  return (product.variant_option_values || []).filter(
    (g) => g && g.option_values && g.option_values.length
  );
}

// "43"", "100"", "55 in", "75'" … — a value that is a bare measurement.
const NUMERIC_VALUE = /^\s*(\d+(?:\.\d+)?)\s*(?:"|”|''|'|in(?:ch(?:es)?)?)?\s*$/i;

// Title tokens for card↔variant matching. Catalogs disagree on form —
// bestbuy.com repeats the card title verbatim per variant, samsung.com writes
// `98" Class …` on cards but `98 Inch Class …` on variants, with model/4K
// tokens reordered — so match on normalized token sets, not strings.
function titleTokens(s) {
  const drop = new Set(['inch', 'inches', 'in']);
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[“”]/g, '"')
      .replace(/"/g, ' ')
      .replace(/[^a-z0-9.]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !drop.has(t))
  );
}

// The variant a discovery card names: highest token-set similarity between the
// card title and each variant's display name. null when nothing is close
// (similarity < 0.5) — callers fall back to the first available variant.
function cardVariant(variants, hint) {
  if (!hint || !hint.title) return null;
  const cardToks = titleTokens(hint.title);
  if (!cardToks.size) return null;
  let best = null;
  let bestScore = 0;
  for (const v of variants) {
    const toks = titleTokens(v.display_name || v.title);
    if (!toks.size) continue;
    let inter = 0;
    for (const t of toks) if (cardToks.has(t)) inter++;
    const score = inter / (toks.size + cardToks.size - inter); // Jaccard
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && best && v.available && !best.available)) {
      best = v;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/**
 * @param {object} product Firmly PDP payload (or discovery hit — same shape)
 * @param {object} [hint]  the discovery card the user clicked (its `title`
 *                         seeds the initial selection so the sheet opens on
 *                         the product the card showed, not the family default)
 * @returns configurator with: groups, selection, variant, select(), valueState(),
 *          price, msrp, image, displayName, available, addToCartRef
 */
export function createConfigurator(product, hint) {
  const variants = product.variants || [];

  // Normalized groups: ordered by position, sizes sorted numerically. A group
  // whose values are all bare measurements ("43"", "100"") is sorted by the
  // number; anything else keeps the catalog's order.
  const groups = optionGroups(product)
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((g, i) => {
      const option_values = g.option_values.slice();
      if (option_values.every((ov) => NUMERIC_VALUE.test(String(ov.value)))) {
        const num = (ov) => parseFloat(String(ov.value).match(NUMERIC_VALUE)[1]);
        option_values.sort((x, y) => num(x) - num(y));
      }
      return { ...g, option_values, _index: g.position ?? i };
    });

  // A variant's value for a group: the accessor property (option1/option2/…)
  // or, when a catalog omits it, the positional variant_option_list entry.
  const valueOf = (variant, group) => {
    const direct = variant[group.property_accessor];
    if (direct !== undefined && direct !== null) return direct;
    const list = variant.variant_option_list;
    return Array.isArray(list) ? list[group._index] : undefined;
  };

  const groupByAccessor = (accessor) => groups.find((g) => g.property_accessor === accessor);

  const matchesSelection = (variant, selection, exceptAccessor = null) =>
    groups.every(
      (g) =>
        g.property_accessor === exceptAccessor ||
        valueOf(variant, g) === selection[g.property_accessor]
    );

  const exactVariant = (selection) =>
    groups.length ? variants.find((v) => matchesSelection(v, selection)) || null : variants[0] || null;

  const selectionFromVariant = (variant) => {
    const sel = {};
    for (const g of groups) sel[g.property_accessor] = valueOf(variant, g);
    return sel;
  };

  // Initial selection: the variant the clicked card names (even when out of
  // stock — the sheet reports that honestly); else the first available
  // variant, else the first variant (v0.4.1 semantics).
  const initial = cardVariant(variants, hint) || variants.find((v) => v.available) || variants[0];
  let selection = initial ? selectionFromVariant(initial) : {};

  const state = {
    groups,

    get selection() {
      return { ...selection };
    },

    get variant() {
      return exactVariant(selection);
    },

    /**
     * Select an option value. The other groups auto-repair to a real variant:
     * exact combo kept when it exists; otherwise the best variant carrying the
     * chosen value (available beats out-of-stock, then most other selections
     * preserved). A value no variant carries is a no-op.
     */
    select(accessor, value) {
      const group = groupByAccessor(accessor);
      if (!group) return state.variant;
      const candidates = variants.filter((v) => valueOf(v, group) === value);
      if (!candidates.length) return state.variant;

      const tentative = { ...selection, [accessor]: value };
      if (exactVariant(tentative)) {
        selection = tentative;
        return state.variant;
      }

      const otherMatches = (v) =>
        groups.reduce(
          (n, g) =>
            n +
            (g.property_accessor !== accessor && valueOf(v, g) === selection[g.property_accessor]
              ? 1
              : 0),
          0
        );
      let best = candidates[0];
      let bestScore = -1;
      for (const v of candidates) {
        const score = (v.available ? 2 : 0) + otherMatches(v);
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
      selection = selectionFromVariant(best);
      return state.variant;
    },

    /**
     * Render state of one option value against the current selection:
     *   'selected'    — the chosen value
     *   'available'   — combo with the other selected options exists, in stock
     *   'unavailable' — combo exists but is out of stock
     *   'repair'      — no combo with the other options; picking it will
     *                   switch the other group(s) to a real variant
     *   'missing'     — no variant anywhere carries this value (dead option)
     */
    valueState(accessor, value) {
      if (selection[accessor] === value) return 'selected';
      const group = groupByAccessor(accessor);
      if (!group) return 'missing';
      const candidates = variants.filter((v) => valueOf(v, group) === value);
      if (!candidates.length) return 'missing';
      const held = candidates.filter((v) => matchesSelection(v, selection, accessor));
      if (!held.length) return 'repair';
      return held.some((v) => v.available) ? 'available' : 'unavailable';
    },

    get price() {
      const v = state.variant;
      return (v && v.price) || null;
    },

    /** MSRP of the selected variant, only when it beats the price. */
    get msrp() {
      const v = state.variant;
      if (!v || !v.msrp || !v.price) return null;
      return Number(v.msrp.value) > Number(v.price.value) ? v.msrp : null;
    },

    /** First usable image url: selected variant's, else the product's. */
    get image() {
      const usable = (imgs) =>
        (imgs || [])
          .map((im) => im && im.url)
          .find((u) => typeof u === 'string' && /^https?:\/\//.test(u) && !/\/undefined($|\?)/.test(u) && u !== 'undefined');
      const v = state.variant;
      return (v && usable(v.images)) || usable(product.images) || '';
    },

    get displayName() {
      const v = state.variant;
      return (v && (v.display_name || v.title)) || product.title || '';
    },

    get available() {
      const v = state.variant;
      return !!(v && v.available);
    },

    get addToCartRef() {
      const v = state.variant;
      return (v && v.add_to_cart_ref) || null;
    }
  };

  return state;
}
