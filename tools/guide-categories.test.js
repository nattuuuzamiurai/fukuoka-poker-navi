#!/usr/bin/env node
/**
 * guide-categories.test.js — 「福岡のポーカー店を目的別に探す」カテゴリー定義のテスト
 *
 * 実行: node tools/guide-categories.test.js
 *
 * 【何を守っているか】
 *   1. CATEGORIES の形(id・shortLabel・featured/chipsからidが取れること)が壊れていないこと
 *   2. categoryStoreIds() が featured と chips を両方拾うこと
 *   3. categoriesByVenueId() が「複数カテゴリーに属する店」を正しく複数件返すこと、
 *      「どのカテゴリーにも属さない店」に対しては空(undefined)を返すこと
 *   4. 実データ(data.js)に対して、CATEGORIES が参照している店舗idが実在すること
 *      (店舗の削除・ID変更で参照が浮くと、店舗ページ側が気づかないまま壊れたリンクを
 *      出し続ける。gen-guide-pages.js の venueById() は生成時に落ちるが、
 *      ここでも独立に固定しておく)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CATEGORIES, categoryStoreIds, categoriesByVenueId } = require('./guide-categories.js');

// ---- 1. 形の検査 ----
test('CATEGORIES の各カテゴリーは id・shortLabel・heading・featured/chips を持つ', () => {
  assert.ok(CATEGORIES.length >= 1, 'CATEGORIES が空です');
  for (const c of CATEGORIES) {
    assert.equal(typeof c.id, 'string');
    assert.ok(c.id, 'idが空文字列のカテゴリーがあります');
    assert.equal(typeof c.shortLabel, 'string');
    assert.ok(c.shortLabel, `${c.id}: shortLabel が空です（店舗ページの「関連ガイド」リンク文言に使う）`);
    assert.equal(typeof c.heading, 'string');
    assert.ok(Array.isArray(c.featured), `${c.id}: featured が配列ではありません`);
    if (c.chips !== undefined) assert.ok(Array.isArray(c.chips), `${c.id}: chips が配列ではありません`);
  }
});

test('id は全カテゴリーでユニーク', () => {
  const ids = CATEGORIES.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---- 2. categoryStoreIds() ----
test('categoryStoreIds() は featured と chips の両方から id を集める', () => {
  const withBoth = { featured: [{ id: 'v1' }, { id: 'v2' }], chips: ['v3', 'v4'] };
  assert.deepEqual(categoryStoreIds(withBoth), ['v1', 'v2', 'v3', 'v4']);
});

test('categoryStoreIds() は chips が無いカテゴリーでも落ちない(featuredのみ)', () => {
  const featuredOnly = { featured: [{ id: 'v1' }] };
  assert.deepEqual(categoryStoreIds(featuredOnly), ['v1']);
});

// ---- 3. categoriesByVenueId() ----
test('categoriesByVenueId() は実際の CATEGORIES から店舗id→所属カテゴリーの対応表を作る', () => {
  const map = categoriesByVenueId();
  // 複数カテゴリーに属することが分かっている店(v22=CRownCLownは
  // cat-tournament/ring-advanced/cat-mixの3カテゴリー)。
  const multi = map.get('v22');
  assert.ok(multi, 'v22 がどのカテゴリーにも属していません');
  assert.ok(multi.length >= 2, `v22 は複数カテゴリーに属するはずですが ${multi.length}件でした`);
  assert.deepEqual(multi.map(c => c.id).sort(), ['cat-mix', 'cat-tournament', 'ring-advanced']);

  // どのカテゴリーにも登場しない架空のidはエントリを持たない。
  assert.equal(map.get('v-not-exist'), undefined);
});

test('categoriesByVenueId() は呼ぶたびに独立したMapを返す(呼び出し元が壊してもCATEGORIES自体は無事)', () => {
  const map1 = categoriesByVenueId();
  map1.clear();
  const map2 = categoriesByVenueId();
  assert.ok(map2.size > 0, '2回目の呼び出しが1回目の副作用を引きずっています');
});

// ---- 4. 実データ(data.js)との整合性 ----
test('CATEGORIES が参照している店舗idは、data.js の VENUES に実在する', () => {
  const { VENUES } = require(path.join(__dirname, '..', 'data.js'));
  const known = new Set(VENUES.map(v => v.id));
  const missing = [];
  CATEGORIES.forEach(c => {
    categoryStoreIds(c).forEach(id => {
      if (!known.has(id)) missing.push(`${c.id}: ${id}`);
    });
  });
  assert.deepEqual(missing, [],
    'CATEGORIES が data.js に存在しない店舗idを参照しています(店舗の削除/ID変更に伴い、'
    + 'tools/guide-categories.js の該当行も見直してください): ' + missing.join(', '));
});

test('CATEGORIES が参照している店舗idは、data.js で closed:true になっていない', () => {
  // 【方針】閉店した可能性がある店を目的別カテゴリーで積極的におすすめしない
  // (gen-guide-pages.js の validateCategoryCoverage() のコメントと同じ方針)。
  // ここでは逆方向、「CATEGORIES 側に closed な店が紛れ込んでいないか」を固定する。
  const { VENUES } = require(path.join(__dirname, '..', 'data.js'));
  const closedIds = new Set(VENUES.filter(v => v.closed).map(v => v.id));
  const offenders = [];
  CATEGORIES.forEach(c => {
    categoryStoreIds(c).forEach(id => {
      if (closedIds.has(id)) offenders.push(`${c.id}: ${id}`);
    });
  });
  assert.deepEqual(offenders, [],
    '閉店した可能性がある店(closed:true)が CATEGORIES に残っています: ' + offenders.join(', '));
});
