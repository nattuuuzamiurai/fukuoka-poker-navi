#!/usr/bin/env node
/**
 * gen-sitemap.test.js — sitemap.xml(特に lastmod)のテスト
 *
 * 実行: node tools/gen-sitemap.test.js
 *
 * 【なぜこのファイルがあるか】
 *   lastmod(GEO監査2026-09-03 3章②)は git履歴から求めるため、
 *   「実行するたびに違う値になっていないか(決定論性を壊していないか)」
 *   「型として妥当か(ISO8601)」は目視では気づきにくい。機械で押さえる。
 *
 * 【何を守っているか】
 *   1. 同じ内容(git履歴)に対しては、何度実行しても同じ文字列が出ること(--checkの前提)
 *   2. 出てくる lastmod がすべて妥当な日時文字列(パース可能)であること
 *   3. トップの lastmod が `git log -1 --format=%cI -- data.js` と一致すること
 *      (「トップ→data.js全体の最終更新コミット日時」という仕様どおりであることの固定)
 *   4. <lastmod> がある行は <loc> の直後に来ること(サイトマッププロトコルの慣例に沿う)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildSitemap } = require('./gen-sitemap.js');

const REPO = path.resolve(__dirname, '..');

test('決定論性: 同じ内容に対して2回実行しても同じ文字列になる', () => {
  const a = buildSitemap(REPO);
  const b = buildSitemap(REPO);
  assert.strictEqual(a, b);
});

test('lastmod は1件以上存在し、すべてパース可能な日時文字列である', () => {
  const xml = buildSitemap(REPO);
  const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
  assert.ok(lastmods.length > 0, 'lastmod が1件も無い(git履歴が読めていない可能性)');
  lastmods.forEach(v => {
    assert.ok(!Number.isNaN(Date.parse(v)), `lastmodがパースできない: ${v}`);
  });
});

test('トップの lastmod は data.js の最終更新コミット日時と一致する', () => {
  const xml = buildSitemap(REPO);
  const m = xml.match(/<url>\s*<loc>https:\/\/fukuokapoker\.com\/<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/);
  assert.ok(m, 'トップのURLブロックに<lastmod>が見つからない');
  const expected = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'data.js'], { cwd: REPO, encoding: 'utf8' }).trim();
  assert.strictEqual(m[1], expected);
});

test('<lastmod> は <loc> の直後・<changefreq> の前に置く(値を持つ全<url>で)', () => {
  const xml = buildSitemap(REPO);
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  assert.ok(blocks.length > 0);
  blocks.forEach(b => {
    if (!b.includes('<lastmod>')) return; // lastmod が無いURL(git履歴が引けない等)は対象外
    const order = b.match(/<loc>|<lastmod>|<changefreq>|<priority>/g);
    const idx = { loc: order.indexOf('<loc>'), lastmod: order.indexOf('<lastmod>'), changefreq: order.indexOf('<changefreq>') };
    assert.ok(idx.loc < idx.lastmod && idx.lastmod < idx.changefreq, `順序が不正: ${b}`);
  });
});

test('URLはすべて一意(重複が無い)', () => {
  const xml = buildSitemap(REPO);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.strictEqual(new Set(locs).size, locs.length);
});
