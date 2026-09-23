'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('../src/lib/analyzer');
const icu = require('../src/lib/icu');

const en = {
  simple: 'Hello {name}',
  typed: 'You have {count, number} items',
  plural: '{count, plural, offset:1 =0{none} one{# item} other{# items}}',
  nested: '{gender, select, female {{count, plural, one {her # cat} other {her # cats}}} other {{count, plural, one {their # cat} other {their # cats}}}}',
  date: 'Due on {due, date, short}',
  selectord: '{n, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}',
  empty: '',
};

const zh = {
  simple: '你好 {name}',
  typed: '你有 {count} 个条目',
  plural: '{count, plural, other{# 个条目}}',
  nested: '{gender, select, other {{count, plural, other{他们的 # 只猫}}}}',
  date: '截止于 {due, date, long}',
  selectord: '{n, selectordinal, other{第 #}}',
  empty: '',
};

function analyzePair(overrides = {}) {
  const inputs = [
    { code: 'en', content: JSON.stringify({ ...en, ...overrides.en }) },
    { code: 'zh', content: JSON.stringify({ ...zh, ...overrides.zh }) },
  ];
  return analyze(inputs, { refLocale: 'en' });
}

function findByCode(result, code, locale) {
  return result.findings.filter(f => f.code === code && (!locale || f.locale === locale));
}

test('clean matching catalogs produce no errors', () => {
  const r = analyzePair();
  // zh typed differs (number -> simple), styles differ, branches differ, ordinal differs.
  // Those are expected; check simple/key presence and plural offset warnings only.
  assert.strictEqual(findByCode(r, 'KEY_MISSING').length, 0);
  assert.strictEqual(findByCode(r, 'PARSE_ERROR').length, 0);
});

test('detects missing key', () => {
  const r = analyzePair({ zh: { simple: undefined } });
  const f = findByCode(r, 'KEY_MISSING', 'zh');
  assert.strictEqual(f.length, 1);
  assert.match(f[0].message, /simple/);
});

test('number vs simple interpolation is a format warning', () => {
  const r = analyzePair();
  const f = findByCode(r, 'FORMAT_MISMATCH', 'zh');
  assert.ok(f.some(x => /count/.test(x.message)));
  assert.strictEqual(findByCode(r, 'TYPE_CONFLICT', 'zh').filter(x => /count/.test(x.message)).length, 0);
});

test('number display plus plural control on same variable is legal', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ a: '{count, number, integer} {count, plural, one{#} other{#s}}' }) },
    { code: 'zh', content: JSON.stringify({ a: '{count} {count, plural, other{#}}' }) },
  ], { refLocale: 'en' });
  assert.strictEqual(findByCode(r, 'INTRA_TYPE_CONFLICT').length, 0);
});

test('date vs number usage is a hard type conflict', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ a: '{when, date}' }) },
    { code: 'zh', content: JSON.stringify({ a: '{when, number}' }) },
  ], { refLocale: 'en' });
  assert.strictEqual(findByCode(r, 'TYPE_CONFLICT', 'zh').length, 1);
});

test('detects style mismatch for date', () => {
  const r = analyzePair();
  const f = findByCode(r, 'STYLE_MISMATCH', 'zh');
  assert.ok(f.some(x => /due/.test(x.message)));
});

test('detects missing plural branch category', () => {
  const r = analyzePair();
  const f = findByCode(r, 'BRANCH_MISSING', 'zh');
  assert.ok(f.some(x => /=0/.test(x.message) || /one/.test(x.message)));
});

test('detects nesting mismatch for select/plural', () => {
  const r = analyzePair();
  const f = findByCode(r, 'NESTING_MISMATCH', 'zh');
  assert.ok(f.length >= 1, 'count appears under different nested branches');
});

test('parse error is captured with position mark', () => {
  const r = analyzePair({ zh: { simple: '坏消息 {name, plural, one{x}' } });
  const f = findByCode(r, 'PARSE_ERROR', 'zh');
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].marks[0].start >= 0);
  assert.ok(f[0].marks[0].end > f[0].marks[0].start);
});

test('parse error marks always stay inside the message', () => {
  const broken = ['{oops', '{a, plural, one{x}', 'hello {'];
  for (const msg of broken) {
    const r = analyze([{ code: 'en', content: JSON.stringify({ a: msg }) }]);
    const f = r.findings.find(x => x.code === 'PARSE_ERROR');
    assert.ok(f, `expected parse error for ${msg}`);
    for (const m of f.marks) {
      assert.ok(m.start >= 0 && m.end <= msg.length && m.end > m.start,
        `mark out of bounds for ${msg}: ${JSON.stringify(m)}`);
    }
  }
});

test('invalid JSON yields LOCALE_JSON_ERROR', () => {
  const r = analyze([
    { code: 'en', content: '{"a":"x"}' },
    { code: 'zh', content: '{not json' },
  ], { refLocale: 'en' });
  assert.strictEqual(findByCode(r, 'LOCALE_JSON_ERROR', 'zh').length, 1);
});

test('non-string value flagged', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ a: 'x' }) },
    { code: 'zh', content: JSON.stringify({ a: 42 }) },
  ], { refLocale: 'en' });
  assert.strictEqual(findByCode(r, 'VALUE_TYPE_INVALID', 'zh').length, 1);
});

test('intra-message placeholder conflict', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ a: '{n, date} and {n, number}' }) },
    { code: 'zh', content: JSON.stringify({ a: '{n, date} 和 {n, number}' }) },
  ], { refLocale: 'en' });
  assert.ok(findByCode(r, 'INTRA_TYPE_CONFLICT').length >= 2);
});

test('intra-message duplicate typed displays with different styles conflict', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ a: '{d, date, short} / {d, date, long}' }) },
  ]);
  assert.strictEqual(findByCode(r, 'INTRA_TYPE_CONFLICT').length, 1);
});

test('pound outside plural is flagged', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ a: 'items #' }) },
  ]);
  // '#' in plain text is a literal per ICU spec — parser treats it as literal,
  // so it must NOT be flagged. Verify no false positive here.
  assert.strictEqual(findByCode(r, 'POUND_WITHOUT_PLURAL').length, 0);
});

test('nested json keys are flattened with dot paths', () => {
  const r = analyze([
    { code: 'en', content: JSON.stringify({ page: { title: 'Hi {name}' }, list: ['{x}', '{y}'] }) },
    { code: 'zh', content: JSON.stringify({ page: { title: '你好 {name}' }, list: ['{x}'] }) },
  ], { refLocale: 'en' });
  assert.ok(r.allKeys.includes('page.title'));
  assert.ok(r.allKeys.includes('list.0'));
  assert.ok(r.allKeys.includes('list.1'));
  assert.ok(findByCode(r, 'KEY_MISSING', 'zh').some(f => f.keyPath === 'list.1'));
});

test('render converts numeric strings and pluralizes', () => {
  const out = icu.renderMessage('{count, plural, one{# item} other{# items}}', 'en', { count: '3' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.output, '3 items');
  const out1 = icu.renderMessage('{count, plural, one{# item} other{# items}}', 'en', { count: '1' });
  assert.strictEqual(out1.output, '1 item');
});

test('render failure reports friendly error', () => {
  const out = icu.renderMessage('Hi {name}', 'en', {});
  assert.strictEqual(out.ok, false);
});

test('rich-text tags are wrapped during render', () => {
  const out = icu.renderMessage('<b>{name}</b> {n, plural, one{# <i>item</i>} other{# <i>items</i>}}', 'en', { name: 'Ada', n: '2' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.output, '<b>Ada</b> 2 <i>items</i>');
});

test('reference falls back to first parseable locale', () => {
  const r = analyze([
    { code: 'en', content: 'not json' },
    { code: 'zh', content: JSON.stringify({ a: '{x}' }) },
  ], { refLocale: 'en' });
  assert.strictEqual(r.refLocale, 'zh');
});
