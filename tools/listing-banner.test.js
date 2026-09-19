#!/usr/bin/env node
/**
 * listing-banner.test.js — 掲載店舗募集の常設バナー(listing-banner.js)のテスト
 *
 * 実行: node tools/listing-banner.test.js (または node --test tools/*.test.js)
 *
 * 【なぜこのファイルがあるか】
 *   promo-banners.test.js / big-events.test.js と同じ考え方。listing-banner.js は日付を
 *   持たない常設バナーで掲載期間の計算は無いが、①オン/オフの切り替え口(visibleListingBanner)、
 *   ②index.html の bigEventBannerHtml() 側に追加した customBanner 分岐(画像を使わずCSSで
 *   組む経路。既存の画像バナーの経路を壊していないか)、③renderBigEventBanner() 内の連結順
 *   (常に最後尾)、の3点は固定しておかないと次に誰かが触ったときの巻き戻りに気づけない。
 *
 * 【index.htmlから関数を切り出す理由】tools/recurring-dedupe.test.js と同じ流儀。
 *   このリポジトリのテストは外部依存ゼロ(node:test のみ、jsdomは使わない)。
 *   bigEventBannerHtml() / renderBigEventBanner() の該当部分はDOMに(ほぼ)触れないので
 *   vm で足りる。目印を動かしたときはこのテストが明示的に落ちる。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const LB = require('../listing-banner.js');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ============================================================
// listing-banner.js 単体
// ============================================================

test('LISTING_BANNER_ENABLEDは現在オンである(巻き戻り検知用)', () => {
  assert.strictEqual(LB.LISTING_BANNER_ENABLED, true);
});

test('visibleListingBanner(): 既定(引数省略)ではLISTING_BANNER_ENABLEDに従う', () => {
  assert.deepStrictEqual(LB.visibleListingBanner().map(x => x.id), ['listing-recruit']);
});

test('visibleListingBanner(): オフに切り替えると0件になる(テスト用の差し替え口)', () => {
  assert.deepStrictEqual(LB.visibleListingBanner(false), []);
});

test('visibleListingBanner(): 明示的にオンを渡しても1件のまま', () => {
  assert.deepStrictEqual(LB.visibleListingBanner(true).map(x => x.id), ['listing-recruit']);
});

test('LISTING_BANNER: リンク先はguide/partners/(確定仕様・2026-09-19変更: 直接問い合わせフォームではなく案内ページを経由させる)', () => {
  assert.strictEqual(LB.LISTING_BANNER.href, 'guide/partners/');
});

test('LISTING_BANNER: 確定文言(見出し/サブ/eyebrow/下部説明文/ボタン)', () => {
  assert.strictEqual(LB.LISTING_BANNER.eyebrow, '掲載店舗様へ');
  assert.strictEqual(LB.LISTING_BANNER.heading, 'この枠に、あなたのお店の告知を');
  assert.strictEqual(LB.LISTING_BANNER.sub, 'トップページの目立つ場所に掲載できます');
  assert.strictEqual(LB.LISTING_BANNER.bannerDesc, 'お店の告知バナー、掲載受付中');
  assert.strictEqual(LB.LISTING_BANNER.btnText, '詳しくは →');
});

test('LISTING_BANNER: days を持たない(常設のため掲載期間の計算対象ではない)', () => {
  assert.strictEqual(LB.LISTING_BANNER.days, undefined);
});

test('LISTING_BANNER: customBanner フラグが立っている(画像バナーではなくCSSで組む)', () => {
  assert.strictEqual(LB.LISTING_BANNER.customBanner, true);
});

test('LISTING_BANNER: label を持つ(カルーセルのec-dotsのaria-labelで使うため必須)', () => {
  assert.ok(LB.LISTING_BANNER.label);
});

// ============================================================
// big-events.js の日付ヘルパーが days=undefined でも落ちないこと
// (index.html の bigEventBannerHtml() が isEventArchived/eventFirstDay に
//  ev.days をそのまま渡せる前提。big-events.js側のArray.isArrayチェックに依存)
// ============================================================
test('big-events.js: days が undefined の告知でも isEventArchived/eventFirstDay はクラッシュせず false/null を返す', () => {
  const BE = require('../big-events.js');
  assert.strictEqual(BE.isEventArchived(undefined), false);
  assert.strictEqual(BE.eventFirstDay(undefined), null);
});

// ============================================================
// index.html: bigEventBannerHtml() の customBanner 分岐
// ============================================================
function loadBigEventBannerHtml() {
  const start = INDEX_HTML.indexOf('  function bigEventBannerHtml(ev){');
  const end = INDEX_HTML.indexOf('  // アーカイブ時にページ冒頭へ出す共通の告知ボックス');
  if (start < 0 || end <= start) {
    throw new Error('index.html から bigEventBannerHtml() を切り出せませんでした。'
      + '目印(`function bigEventBannerHtml(ev){` 〜 `// アーカイブ時にページ冒頭へ出す共通の告知ボックス`)'
      + 'を動かしたなら、このテストの目印も直すこと。');
  }
  const src = INDEX_HTML.slice(start, end);
  const sandbox = {
    // bigEventBannerHtml() が参照する big-events.js 側の関数群
    localTodayGlobal: () => '2026-09-17',
    isEventArchived: (days) => (Array.isArray(days) && days.length) ? false : false,
    eventFirstDay: (days) => (Array.isArray(days) && days.length) ? days[0] : null,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'bigEventBannerHtml-extract.js' }).runInContext(sandbox);
  return sandbox.bigEventBannerHtml;
}

test('bigEventBannerHtml(): customBanner:true のとき<img>を出さず、CSSで組む見出しブロックを出す', () => {
  const bigEventBannerHtml = loadBigEventBannerHtml();
  const html = bigEventBannerHtml(LB.LISTING_BANNER);
  assert.ok(!html.includes('<img'), `customBannerなのに<img>が出力されている:\n${html}`);
  assert.ok(html.includes('eb-custom'), 'eb-customブロックが無い');
  assert.ok(html.includes('掲載店舗様へ'), 'eyebrowが出力されていない');
  assert.ok(html.includes('この枠に、あなたのお店の告知を'), 'headingが出力されていない');
  assert.ok(html.includes('トップページの目立つ場所に掲載できます'), 'subが出力されていない');
  assert.ok(html.includes('お店の告知バナー、掲載受付中'), 'bannerDesc(eb-tag)が出力されていない');
  assert.ok(html.includes('詳しくは →'), 'btnTextが出力されていない(既定の「日程を見る →」のままになっている)');
  assert.ok(html.includes('class="evtBanner ev-listing"'), 'bannerClass(ev-listing)が付いていない');
  assert.ok(html.includes('href="guide/partners/"'), 'href が反映されていない');
});

test('bigEventBannerHtml(): 既存の画像バナー(customBannerなし)は今まで通り<img>のまま(回帰防止)', () => {
  const bigEventBannerHtml = loadBigEventBannerHtml();
  const ev = {
    bannerClass: 'ev-fst',
    hash: '#fst',
    banner: 'img/fst/fst-banner.svg',
    bannerAlt: 'FST 5.0 2026 福岡',
    bannerDesc: '福岡・渡辺通/怒涛の5日間',
    days: ['2026-09-19', '2026-09-20']
  };
  const html = bigEventBannerHtml(ev);
  assert.ok(html.includes('<img class="eb-img" src="img/fst/fst-banner.svg"'), '既存の画像バナーの出力が変わっている');
  assert.ok(!html.includes('eb-custom'), '画像バナーなのにeb-customが出力されている');
  assert.ok(html.includes('日程を見る →'), 'btnText省略時の既定文言(日程を見る →)が出ていない');
});

// ============================================================
// index.html: renderBigEventBanner() 内の連結順(常に最後尾)
// ============================================================
test('renderBigEventBanner(): 掲載店舗募集バナーは promos/visibleBigEvents の【最後尾】に連結される', () => {
  const start = INDEX_HTML.indexOf('    const promos = (typeof visiblePromoBanners === \'function\')');
  const end = INDEX_HTML.indexOf('    // JOPT/NIPPONのデータ読み込み後に描き直すことがある');
  if (start < 0 || end <= start) {
    throw new Error('index.html から renderBigEventBanner() の連結部分を切り出せませんでした。'
      + '目印を動かしたなら、このテストの目印も直すこと。');
  }
  const src = INDEX_HTML.slice(start, end);
  const sandbox = {
    visiblePromoBanners: () => [{ id: 'promoX' }],
    visibleBigEvents: () => [{ id: 'fst' }, { id: 'spadie' }],
    visibleListingBanner: () => [{ id: 'listing-recruit' }]
  };
  vm.createContext(sandbox);
  new vm.Script(src + '\n;evs', { filename: 'renderBigEventBanner-extract.js' }).runInContext(sandbox);
  const ids = new vm.Script('evs.map(e => e.id)').runInContext(sandbox);
  assert.deepStrictEqual(ids, ['promoX', 'fst', 'spadie', 'listing-recruit']);
});

test('renderBigEventBanner(): 他の告知が0件でも掲載店舗募集バナー単体で1件返る', () => {
  const start = INDEX_HTML.indexOf('    const promos = (typeof visiblePromoBanners === \'function\')');
  const end = INDEX_HTML.indexOf('    // JOPT/NIPPONのデータ読み込み後に描き直すことがある');
  const src = INDEX_HTML.slice(start, end);
  const sandbox = {
    visiblePromoBanners: () => [],
    visibleBigEvents: () => [],
    visibleListingBanner: () => [{ id: 'listing-recruit' }]
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'renderBigEventBanner-extract2.js' }).runInContext(sandbox);
  const ids = new vm.Script('evs.map(e => e.id)').runInContext(sandbox);
  assert.deepStrictEqual(ids, ['listing-recruit']);
});

// ============================================================
// CSS: 状態バッジ(開催中/まもなく/終了)を打ち消していること
// ============================================================
test('CSS: .evtBanner.ev-listing では eb-tag::before(状態バッジ)を content:none で打ち消している', () => {
  assert.match(INDEX_HTML, /\.evtBanner\.ev-listing \.eb-tag::before\{content:none\}/);
});
