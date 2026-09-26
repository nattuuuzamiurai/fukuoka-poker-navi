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
 *   組む経路。既存の画像バナーの経路を壊していないか)の2点は固定しておかないと次に誰かが
 *   触ったときの巻き戻りに気づけない。
 *   ③「サイト全体のバナーの中での連結順(常に最後尾)」は、2026-09-26に visibleSiteBanners()
 *   (site-banner.js)へ集約されたため、そちらのテスト(tools/site-banner.test.js)で固定する
 *   (以前はここに renderBigEventBanner() の連結順を検証するテストがあったが、
 *   index.html 側が visibleSiteBanners() を呼ぶだけになり検証対象が無くなったため撤去した)。
 *
 * 【bigEventBannerHtml()について】2026-09-26に big-events.js へ移設された(店舗ページ生成
 *   〔tools/gen-venue-pages.js〕からもNodeで呼べるようにするため)。以前はindex.html内にしか
 *   存在せず、vmで文字列を切り出して実行していたが、今は素直に require() で取れる。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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
  assert.strictEqual(LB.LISTING_BANNER.href, '/guide/partners/');
});

test('LISTING_BANNER: hrefはサイトルート起点の絶対パス(先頭が"/")である(2026-09-26追加。店舗ページ等1階層下のページでもリンクが壊れないことの回帰防止)', () => {
  assert.ok(LB.LISTING_BANNER.href.startsWith('/'), `href が相対パスのままになっている(実際: ${LB.LISTING_BANNER.href})`);
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
// big-events.js: bigEventBannerHtml() の customBanner 分岐
// ============================================================
function loadBigEventBannerHtml() {
  return require('../big-events.js').bigEventBannerHtml;
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
  assert.ok(html.includes('href="/guide/partners/"'), 'href が反映されていない');
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
  // src は 2026-09-26 からサイトルート起点の絶対パス('/img/...')に正規化されている
  // (big-events.js の bannerImgSrc() 参照。店舗ページ等の1階層下のページからも壊れず解決できるようにするため)。
  assert.ok(html.includes('<img class="eb-img" src="/img/fst/fst-banner.svg"'), '既存の画像バナーの出力が変わっている');
  assert.ok(!html.includes('eb-custom'), '画像バナーなのにeb-customが出力されている');
  assert.ok(html.includes('日程を見る →'), 'btnText省略時の既定文言(日程を見る →)が出ていない');
});

// ============================================================
// CSS: 状態バッジ(開催中/まもなく/終了)を打ち消していること
// ============================================================
test('CSS: .evtBanner.ev-listing では eb-tag::before(状態バッジ)を content:none で打ち消している', () => {
  assert.match(INDEX_HTML, /\.evtBanner\.ev-listing \.eb-tag::before\{content:none\}/);
});
