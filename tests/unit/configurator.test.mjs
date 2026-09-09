// Tests for lib/configurator.js — the variant configurator engine behind the
// drop-in's Instant Buy sheet.
//
// Fixtures are REAL captured Firmly PDP payloads (tests/fixtures/):
//   bestbuy.com — Samsung U8000H (6 sizes), Samsung S90H OLED (4 sizes),
//                 LG NU700B (4 sizes)         — single "Screen Size Class" group
//   samsung.com — The Frame LS03FA (2 models × 6 sizes, 7 variants),
//                 Neo QLED QN90F (4 × 9, 21), QLED Q7F (3 × 8, 20)
//                 — sparse Model × Size matrices
//
// Part 1 locks in the v0.4.1 semantics (default = first available variant,
// exact-match variant lookup). Part 2 specifies the configurator feature:
// per-value chip states on a sparse matrix, auto-repair on selection, natural
// size ordering, per-variant price/MSRP/image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigurator, optionGroups } from '../../extension/lib/configurator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', `${name}.pdp.json`), 'utf8'));

const qn90f = () => fixture('samsung-neo-qled-qn90f');
const frame = () => fixture('samsung-frame-ls03fa');
const q7f = () => fixture('samsung-qled-q7f');
const u8000h = () => fixture('bb-samsung-u8000h');
const s90h = () => fixture('bb-samsung-s90h-oled');
const nu700b = () => fixture('bb-lg-nu700b');

// ───────────────────────── Part 1 — v0.4.1 semantics ─────────────────────────

test('optionGroups: keeps only groups that actually have option values', () => {
  const groups = optionGroups({
    variant_option_values: [
      { property_accessor: 'option1', display_name: 'Model', option_values: [{ value: 'a', display_name: 'a' }] },
      { property_accessor: 'option2', display_name: 'Empty', option_values: [] },
      null
    ]
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].display_name, 'Model');
});

test('optionGroups: absent variant_option_values yields an empty list', () => {
  assert.deepEqual(optionGroups({}), []);
});

test('default selection is the first AVAILABLE variant (QN90F: 115" QN90F, not the 100" QN80F listed first)', () => {
  const cfg = createConfigurator(qn90f());
  assert.deepEqual(cfg.selection, { option1: 'Neo QLED 4K QN90F', option2: '115"' });
  assert.equal(cfg.variant.sku, 'QN115QN90FFXZA');
  assert.equal(cfg.variant.available, true);
});

test('default selection on a single-group Best Buy TV is the first available size', () => {
  const cfg = createConfigurator(u8000h());
  assert.deepEqual(cfg.selection, { option1: '43"' });
  assert.equal(cfg.variant.sku, '6670834');
});

test('a product with no option groups resolves to its only variant', () => {
  const product = {
    variants: [{ available: true, sku: 'only-1', price: { value: 9.99, symbol: '$' }, add_to_cart_ref: { variant_id: 'only-1' } }]
  };
  const cfg = createConfigurator(product);
  assert.deepEqual(cfg.groups, []);
  assert.equal(cfg.variant.sku, 'only-1');
  assert.deepEqual(cfg.selection, {});
});

test('a product with no variants at all yields a null variant (sheet shows unavailable)', () => {
  const cfg = createConfigurator({ title: 'ghost', variants: [] });
  assert.equal(cfg.variant, null);
});

test('exact-match lookup: selecting an existing exact combo lands on that variant', () => {
  const cfg = createConfigurator(frame());
  cfg.select('option2', '65"'); // The Frame 65" exists and is available
  assert.deepEqual(cfg.selection, { option1: 'The Frame', option2: '65"' });
  assert.equal(cfg.variant.available, true);
  assert.equal(cfg.variant.price.value, 949.99);
});

// ───────────────────── Part 2 — the configurator feature ─────────────────────

// -- natural ordering ---------------------------------------------------------

test('size values render in numeric order, not the lexicographic API order', () => {
  const cfg = createConfigurator(qn90f());
  const sizeGroup = cfg.groups.find((g) => g.display_name === 'Size');
  assert.deepEqual(
    sizeGroup.option_values.map((v) => v.value),
    ['43"', '50"', '55"', '65"', '75"', '85"', '98"', '100"', '115"']
  );
});

test('non-numeric groups (Model) keep the API order', () => {
  const cfg = createConfigurator(qn90f());
  const modelGroup = cfg.groups.find((g) => g.display_name === 'Model');
  assert.deepEqual(
    modelGroup.option_values.map((v) => v.value),
    ['Neo QLED 4K QN80F', 'Neo QLED 4K QN90F', 'Neo QLED 4K QN1EF Online Exclusive', 'Neo QLED 4K QN70F']
  );
});

test('groups are ordered by their position field', () => {
  const cfg = createConfigurator(frame());
  assert.deepEqual(cfg.groups.map((g) => g.display_name), ['Model', 'Size']);
});

// -- per-value chip states on a sparse matrix ---------------------------------

test('valueState: in-stock combo is "available"', () => {
  const cfg = createConfigurator(qn90f()); // selected: QN90F 115"
  assert.equal(cfg.valueState('option2', '98"'), 'available'); // QN90F 98" in stock
});

test('valueState: the currently selected value is "selected"', () => {
  const cfg = createConfigurator(qn90f());
  assert.equal(cfg.valueState('option2', '115"'), 'selected');
  assert.equal(cfg.valueState('option1', 'Neo QLED 4K QN90F'), 'selected');
});

test('valueState: existing but out-of-stock combo is "unavailable"', () => {
  const cfg = createConfigurator(qn90f()); // QN90F selected
  assert.equal(cfg.valueState('option2', '43"'), 'unavailable'); // QN90F 43" exists, OOS
  const bb = createConfigurator(u8000h());
  assert.equal(bb.valueState('option1', '70"'), 'unavailable'); // BB 70" exists, OOS
});

test('valueState: combo that does not exist for the current selection but exists elsewhere is "repair"', () => {
  const cfg = createConfigurator(qn90f()); // QN90F selected — 100" only exists as QN80F
  assert.equal(cfg.valueState('option2', '100"'), 'repair');
  const f = createConfigurator(frame()); // The Frame selected — 75" only exists as Frame Pro
  assert.equal(f.valueState('option2', '75"'), 'repair');
});

test('valueState: value with no variant anywhere is "missing"', () => {
  const p = frame();
  // Inject a phantom size the catalog lists but no variant carries.
  p.variant_option_values.find((g) => g.display_name === 'Size').option_values.push({ value: '32"', display_name: '32"' });
  const cfg = createConfigurator(p);
  assert.equal(cfg.valueState('option2', '32"'), 'missing');
});

// -- auto-repair on selection -------------------------------------------------

test('select: never strands the user on a non-existent combo — other groups snap to a real variant', () => {
  const cfg = createConfigurator(qn90f()); // QN90F 115"
  cfg.select('option1', 'Neo QLED 4K QN70F'); // QN70F has no 115"
  assert.equal(cfg.selection.option1, 'Neo QLED 4K QN70F');
  assert.notEqual(cfg.variant, null);
  assert.equal(cfg.variant.option1, 'Neo QLED 4K QN70F');
});

test('select: repair prefers an AVAILABLE variant of the chosen value (QN70F → its only in-stock size, 85")', () => {
  const cfg = createConfigurator(qn90f());
  cfg.select('option1', 'Neo QLED 4K QN70F');
  assert.equal(cfg.selection.option2, '85"');
  assert.equal(cfg.variant.available, true);
});

test('select: repair keeps other selections when the exact combo exists', () => {
  const cfg = createConfigurator(qn90f()); // QN90F 115"
  cfg.select('option2', '75"'); // QN90F 75" exists (OOS) — model must not change
  assert.deepEqual(cfg.selection, { option1: 'Neo QLED 4K QN90F', option2: '75"' });
  assert.equal(cfg.variant.available, false);
});

test('select: choosing a "repair" value switches the other group (Frame 55" → Frame Pro jumps size)', () => {
  const cfg = createConfigurator(frame()); // The Frame 55"
  cfg.select('option1', 'The Frame Pro'); // Pro has no 55"
  assert.equal(cfg.selection.option1, 'The Frame Pro');
  assert.ok(['65"', '75"', '85"'].includes(cfg.selection.option2));
  assert.equal(cfg.variant.available, true);
});

test('select: a value no variant carries is a no-op', () => {
  const cfg = createConfigurator(frame());
  const before = { ...cfg.selection };
  cfg.select('option2', '999"');
  assert.deepEqual(cfg.selection, before);
});

test('select: works across all six captured products without ever stranding', () => {
  for (const p of [qn90f(), frame(), q7f(), u8000h(), s90h(), nu700b()]) {
    const cfg = createConfigurator(p);
    for (const g of cfg.groups) {
      for (const ov of g.option_values) {
        if (cfg.valueState(g.property_accessor, ov.value) === 'missing') continue;
        cfg.select(g.property_accessor, ov.value);
        assert.notEqual(cfg.variant, null, `${p.title}: stranded on ${g.display_name}=${ov.value}`);
        assert.equal(cfg.variant[g.property_accessor], ov.value);
      }
    }
  }
});

// -- per-variant presentation -------------------------------------------------

test('price and MSRP track the selected variant (U8000H: 43"=$229.99 → 65"=$379.99)', () => {
  const cfg = createConfigurator(u8000h());
  assert.equal(cfg.price.value, 229.99);
  cfg.select('option1', '65"');
  assert.equal(cfg.price.value, 379.99);
});

test('msrp is exposed only when it beats the price (savings shown)', () => {
  const cfg = createConfigurator(frame()); // The Frame 55": 799.99, msrp 1299.99
  assert.equal(cfg.msrp.value, 1299.99);
  assert.equal(cfg.price.value, 799.99);
});

test('msrp is null when it does not beat the price', () => {
  const cfg = createConfigurator({
    variants: [{ available: true, price: { value: 10, symbol: '$' }, msrp: { value: 10, symbol: '$' } }]
  });
  assert.equal(cfg.msrp, null);
});

test('image: follows the selected variant and skips broken "undefined" image urls', () => {
  const p = qn90f();
  // The captured QN80F 100" variant genuinely carries images with url "undefined".
  const cfg = createConfigurator(p);
  cfg.select('option2', '100"'); // repairs model to QN80F
  assert.ok(cfg.image && cfg.image.startsWith('https://'), `got: ${cfg.image}`);
  assert.ok(!cfg.image.includes('undefined'));
});

test('image: falls back to the product-level image when the variant has none', () => {
  const cfg = createConfigurator({
    images: [{ url: 'https://p.example/prod.jpg' }],
    variants: [{ available: true, price: { value: 1, symbol: '$' } }]
  });
  assert.equal(cfg.image, 'https://p.example/prod.jpg');
});

test('displayName reflects the selected variant on samsung.com matrices', () => {
  const cfg = createConfigurator(frame());
  cfg.select('option1', 'The Frame Pro');
  assert.match(cfg.variant.display_name || cfg.displayName, /Frame Pro/);
});

test('addToCartRef is the selected variant ref, verbatim', () => {
  const cfg = createConfigurator(s90h());
  cfg.select('option1', '48"');
  assert.deepEqual(cfg.addToCartRef, { variant_id: '6671660' });
});

// -- accessor fallback --------------------------------------------------------

test('variants missing accessor properties fall back to variant_option_list by position', () => {
  const product = {
    variant_option_values: [
      { property_accessor: 'option1', position: 0, display_name: 'Color', option_values: [
        { value: 'Black', display_name: 'Black' }, { value: 'White', display_name: 'White' }
      ] }
    ],
    variants: [
      { available: true, variant_option_list: ['Black'], price: { value: 5, symbol: '$' }, sku: 'b' },
      { available: true, variant_option_list: ['White'], price: { value: 6, symbol: '$' }, sku: 'w' }
    ]
  };
  const cfg = createConfigurator(product);
  cfg.select('option1', 'White');
  assert.equal(cfg.variant.sku, 'w');
  assert.equal(cfg.valueState('option1', 'Black'), 'available');
});

// ── Part 3 — card-seeded selection (the clicked card IS the default) ─────────
// A discovery card names ONE family member ("75\" Class Neo QLED 4K QN90F…")
// but the PDP payload is the whole family; without a seed the sheet opened on
// the family's first available variant (e.g. the 115" at $14,999.99).
// createConfigurator(product, hint) must land on the card's variant.

const discovery = (name) => JSON.parse(readFileSync(join(HERE, '..', 'fixtures', `${name}.discovery.json`), 'utf8'));

test('seed: bestbuy card title picks that exact size (65" S90H card → 65", not the 42" default)', () => {
  const cfg = createConfigurator(s90h(), { title: 'Samsung - 65" Class S90H OLED 4K Glare-Free TV with SamsungVisionAI (2024)' });
  assert.equal(cfg.selection.option1, '65"');
  assert.equal(cfg.variant.available, true);
});

test('seed: samsung card title matches across "98\"" vs "98 Inch" and token reordering', () => {
  const cfg = createConfigurator(qn90f(), { title: '98" Class Neo QLED 4K QN90F Samsung Vision AI Smart TV (2025)' });
  assert.deepEqual(cfg.selection, { option1: 'Neo QLED 4K QN90F', option2: '98"' });
});

test('seed: the captured discovery hits all land on their own card variant', () => {
  const cases = [
    ['bb-samsung-u8000h', { option1: '55"' }],
    ['bb-samsung-s90h-oled', { option1: '42"' }],
    ['bb-lg-nu700b', { option1: '50"' }],
    ['samsung-frame-ls03fa', { option1: 'The Frame', option2: '43"' }],
    ['samsung-qled-q7f', { option1: 'QLED Q7F', option2: '65"' }]
  ];
  for (const [name, expected] of cases) {
    const cfg = createConfigurator(fixture(name), discovery(name));
    for (const [acc, val] of Object.entries(expected)) {
      assert.equal(cfg.selection[acc], val, `${name}: ${acc} should be ${val}, got ${cfg.selection[acc]}`);
    }
  }
});

test('seed: an out-of-stock card variant is still selected and reported honestly', () => {
  const cfg = createConfigurator(frame(), { title: '43" Class The Frame LS03FA QLED 4K Art Mode Samsung Vision AI Smart TV' });
  assert.deepEqual(cfg.selection, { option1: 'The Frame', option2: '43"' });
  assert.equal(cfg.variant.available, false); // honest: card said 43", 43" is OOS
});

test('seed: unmatchable hint falls back to the first available variant', () => {
  const cfg = createConfigurator(qn90f(), { title: 'Totally Unrelated Blender 9000' });
  assert.deepEqual(cfg.selection, { option1: 'Neo QLED 4K QN90F', option2: '115"' });
});

test('seed: no hint keeps the v0.4.1 default (first available)', () => {
  const cfg = createConfigurator(qn90f());
  assert.deepEqual(cfg.selection, { option1: 'Neo QLED 4K QN90F', option2: '115"' });
});
