#!/usr/bin/env node
/**
 * contact-category-param.test.js — contact.html の「URLの ?type=... で
 * お問い合わせ種別を選択済みにする」ロジックのテスト
 *
 * 実行: node tools/contact-category-param.test.js (または node --test tools/*.test.js)
 *
 * 【背景】index.html の掲載店舗募集バナー(listing-banner.js)は
 *   contact.html?type=listing にリンクする。#category の既存の<option>
 *   (general/correction/listing/other)のいずれかと一致すればその選択肢を選択済みにし、
 *   一致しない値・パラメータ無しのときは何もしない(先頭のgeneralのまま)仕様。
 *
 * 【なぜ関数を切り出すか】pickCategoryFromQuery() 自体はDOMに触れない純粋関数のため、
 *   contact.html から文字列で切り出してそのまま実行して検証する(tools/recurring-dedupe.test.js
 *   と同じ流儀。jsdomは使わない)。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTACT_HTML = fs.readFileSync(path.join(__dirname, '..', 'contact.html'), 'utf8');

function loadPickCategoryFromQuery() {
  const marker = 'function pickCategoryFromQuery(requested, validValues) {';
  const start = CONTACT_HTML.indexOf(marker);
  if (start < 0) {
    throw new Error('contact.html から pickCategoryFromQuery() を切り出せませんでした。'
      + '目印(`function pickCategoryFromQuery(requested, validValues) {`)を動かしたなら、'
      + 'このテストの目印も直すこと。');
  }
  const end = CONTACT_HTML.indexOf('\n  }', start) + '\n  }'.length;
  const src = CONTACT_HTML.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(src + '\n;pickCategoryFromQuery', { filename: 'pickCategoryFromQuery-extract.js' }).runInContext(sandbox);
  return vm.runInContext('pickCategoryFromQuery', sandbox);
}

const VALID = ['general', 'correction', 'listing', 'other'];

test('pickCategoryFromQuery(): 既存の値(listing)と一致すればそれを返す', () => {
  const f = loadPickCategoryFromQuery();
  assert.strictEqual(f('listing', VALID), 'listing');
});

test('pickCategoryFromQuery(): 既存の値(correction/other/general)もそれぞれ通る', () => {
  const f = loadPickCategoryFromQuery();
  assert.strictEqual(f('correction', VALID), 'correction');
  assert.strictEqual(f('other', VALID), 'other');
  assert.strictEqual(f('general', VALID), 'general');
});

test('pickCategoryFromQuery(): 存在しない値はnull(何もしない=先頭のgeneralのまま)', () => {
  const f = loadPickCategoryFromQuery();
  assert.strictEqual(f('bogus', VALID), null);
});

test('pickCategoryFromQuery(): パラメータ無し(null/空文字)もnull', () => {
  const f = loadPickCategoryFromQuery();
  assert.strictEqual(f(null, VALID), null);
  assert.strictEqual(f('', VALID), null);
});

test('contact.html: #category の<option>はgeneral/correction/listing/otherの4つ(巻き戻り検知用)', () => {
  const options = [...CONTACT_HTML.matchAll(/<option value="([^"]+)">/g)].map(m => m[1]);
  assert.deepStrictEqual(options, VALID);
});
