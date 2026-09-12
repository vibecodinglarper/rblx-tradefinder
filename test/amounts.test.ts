import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRange, parseAmount, parseRange, parseMixedRange, formatMixedRange, mixedRangeText } from '../src/amounts.js';
import { evaluate } from '../src/engine.js';
import { defaults } from '../src/domain.js';
import { fixtureProvider, item } from './fixtures.js';

const items = fixtureProvider().itemMap; // I10 = 50, I20 = 50, I30 = 110, I40 = 45
test('amounts accept numbers, item names and multiplied items; ranges accept the documented spellings', () => {
  assert.equal(parseAmount('1,000', items), 1000); assert.equal(parseAmount('-500', items), -500);
  assert.equal(parseAmount('I30', items), 110); assert.equal(parseAmount('Item 30', items), 110); assert.equal(parseAmount('30', items), 30, 'a bare number is an amount, not an item ID');
  assert.equal(parseAmount('2x I30', items), 220); assert.equal(parseAmount('0.5 I30', items), 55); assert.equal(parseAmount('3 × I10', items), 150);
  assert.throws(() => parseAmount('', items), /Enter an amount/); assert.throws(() => parseAmount('nothing here', items), /No Rolimons-tracked/);
  assert.deepEqual(parseRange('', items), { min: null, max: null });
  assert.deepEqual(parseRange('1000', items), { min: 1000, max: null });
  assert.deepEqual(parseRange('1000 - 5000', items), { min: 1000, max: 5000 });
  assert.deepEqual(parseRange('1000–5000', items), { min: 1000, max: 5000 });
  assert.deepEqual(parseRange('I10 to I30', items), { min: 50, max: 110 });
  assert.deepEqual(parseRange('-500 .. 500', items), { min: -500, max: 500 }, 'an attached dash is a sign');
  assert.deepEqual(parseRange('- 5000', items), { min: null, max: 5000 }, 'a spaced leading dash means "up to"');
  assert.throws(() => parseRange('5000 - 1000', items), /backwards/); assert.throws(() => parseRange('1 - 2 - 3', items), /at most two parts/);
  assert.equal(formatRange({ min: 1000, max: 5000 }), '1,000 – 5,000'); assert.equal(formatRange({ min: null, max: 5000 }), '≤ 5,000'); assert.equal(formatRange({ min: null, max: null }), 'any');
});
test('the engine applies the general profit window unless a received item carries its own rule', () => {
  // A downgrade: one item worth 110 for two worth 60 each, a gain of 10.
  const give = [{ assetId: 30, userAssetId: 3, onHold: false, item: item(30, 110) }];
  const receive = [{ assetId: 10, userAssetId: 1, onHold: false, item: item(10, 60) }, { assetId: 20, userAssetId: 2, onHold: false, item: item(20, 60) }];
  const general = { ...defaults(), minValueGain: 20, maxValueGain: 100 };
  assert.match(evaluate(give, receive, general).failures.join(' '), /Value gain is below 20\./);
  assert.match(evaluate(give, receive, { ...general, minValueGain: null, maxValueGain: 5 }).failures.join(' '), /Value gain is above 5\./);
  assert.ok(evaluate(give, receive, { ...general, itemRules: { '10': { min: 5, max: 15 } } }).passes, 'the rule for the received item replaces the general window');
  assert.match(evaluate(give, receive, { ...general, minValueGain: null, itemRules: { '10': { min: 50, max: null } } }).failures.join(' '), /below 50 \(your rule for Item 10\)/);
  assert.ok(evaluate(give, receive, { ...general, itemRules: { '30': { min: 1000, max: null } } }).failures.join(' ').includes('below 20'), 'rules on given items do not apply');
});

test('mixed ranges take a percent or an amount on each side and round-trip into form text', () => {
  const items = fixtureProvider().itemMap;
  assert.deepEqual(parseMixedRange('-5% - 3%', items), { min: { value: -5, pct: true }, max: { value: 3, pct: true } });
  assert.deepEqual(parseMixedRange('I10 - 1,000', items), { min: { value: 50, pct: false }, max: { value: 1000, pct: false } });
  assert.deepEqual(parseMixedRange('10%', items), { min: { value: 10, pct: true }, max: null });
  assert.deepEqual(parseMixedRange('- 20000', items), { min: null, max: { value: 20000, pct: false } });
  assert.equal(formatMixedRange(parseMixedRange('5% - 5000', items)), '5% – 5,000');
  assert.equal(mixedRangeText(parseMixedRange('-5% - 3%', items)), '-5% - 3%'); assert.equal(mixedRangeText({ min: null, max: null }), '');
  assert.throws(() => parseMixedRange('25% - 5%', items), /backwards/);
});
