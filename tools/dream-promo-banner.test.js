#!/usr/bin/env node
/**
 * dream-promo-banner.test.js — CASINO BAR DreaM PR掲載の常設バナー(dream-promo-banner.js)のテスト
 *
 * 実行: node tools/dream-promo-banner.test.js (または node --test tools/*.test.js)
 *
 * 【なぜこのファイルがあるか】listing-banner.test.js と同じ考え方。
 *   dream-promo-banner.js は日付を持たない常設バナーで掲載期間の計算は無いが、
 *   ①オン/オフの切り替え口(visibleDreamPromoBanner)、②実画像を使う経路(customBannerではない
 *   ことの回帰防止)、③renderBigEventBanner() 内の連結順(promo-banners.js の直後・大型大会の
 *   【前】= 大型大会より常に先頭という設計原則を守っていること)、④「PR」バッジの常時表示
 *   (CSS上書き)、⑤リンク先がトーナメント専用ページであること、の5点は固定しておかないと
 *   次に誰かが触ったときの巻き戻りに気づけない。
 *
 * 【2026-09-19の指摘を踏まえた変更点】
 *   - 表示順: 当初 visibleBigEvents() の【後ろ】に連結してしまい「FSTに隠れている」と
 *     指摘された。promo-banners.js と同じ「常に大型大会より先頭」に直したことをここで固定する。
 *   - 画像: 正方形フライヤーを CSS でトリミングしていたが「見切れている」と指摘された。
 *     横長画像に差し替える方針になったため、imgAspect 等のクロップ指定は一切持たない
 *     (=他の画像バナーと全く同じ経路で描画されることを固定する)。
 *   - リンク先: 店舗ページ(venues/dream-casinobar-kurume/)からトーナメント専用ページ
 *     (events/dream-saturday-tournament/)に変更。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DB = require('../dream-promo-banner.js');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ============================================================
// dream-promo-banner.js 単体
// ============================================================

test('DREAM_PROMO_BANNER_ENABLEDは現在オンである(巻き戻り検知用)', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER_ENABLED, true);
});

test('visibleDreamPromoBanner(): 既定(引数省略)ではDREAM_PROMO_BANNER_ENABLEDに従う', () => {
  assert.deepStrictEqual(DB.visibleDreamPromoBanner().map(x => x.id), ['dream-saturday-tournament']);
});

test('visibleDreamPromoBanner(): オフに切り替えると0件になる(テスト用の差し替え口)', () => {
  assert.deepStrictEqual(DB.visibleDreamPromoBanner(false), []);
});

test('visibleDreamPromoBanner(): 明示的にオンを渡しても1件のまま', () => {
  assert.deepStrictEqual(DB.visibleDreamPromoBanner(true).map(x => x.id), ['dream-saturday-tournament']);
});

test('DREAM_PROMO_BANNER: リンク先はトーナメント専用ページ(2026-09-19: 店舗ページから変更・確定仕様)', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.href, '/events/dream-saturday-tournament/');
});

test('DREAM_PROMO_BANNER: 確定文言(bannerDesc/btnText)・配色・画像パス', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.bannerClass, 'ev-dream');
  assert.strictEqual(DB.DREAM_PROMO_BANNER.banner, 'img/dream/dream-saturday-tournament.jpg');
  assert.strictEqual(DB.DREAM_PROMO_BANNER.bannerDesc, '毎週土曜開催・久留米');
  assert.strictEqual(DB.DREAM_PROMO_BANNER.btnText, '特典を見る →');
  assert.ok(DB.DREAM_PROMO_BANNER.bannerAlt, 'bannerAlt(alt属性)が無い');
});

test('DREAM_PROMO_BANNER: days を持たない(常設のため掲載期間の計算対象ではない)', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.days, undefined);
});

test('DREAM_PROMO_BANNER: customBanner フラグを持たない(実画像を使うため。listing-banner.jsとの違い)', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.customBanner, undefined);
});

test('DREAM_PROMO_BANNER: imgAspect(クロップ指定)を持たない(2026-09-19: 正方形トリミングの指摘を受けて廃止)', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.imgAspect, undefined);
});

test('DREAM_PROMO_BANNER: label を持つ(カルーセルのec-dotsのaria-labelで使うため必須)', () => {
  assert.ok(DB.DREAM_PROMO_BANNER.label);
});

// ============================================================
// 実ファイル: 画像アセットが実在すること
// ============================================================
test('画像アセット: img/dream/dream-saturday-tournament.jpg が実在する', () => {
  const p = path.join(__dirname, '..', DB.DREAM_PROMO_BANNER.banner);
  assert.ok(fs.existsSync(p), `${p} が存在しません`);
});

// ============================================================
// index.html: bigEventBannerHtml() は他の画像バナーと全く同じ経路で描画される
// (imgAspect等の特別なクロップ処理を持ち込んでいないことの回帰防止)
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
    localTodayGlobal: () => '2026-09-19',
    isEventArchived: (days) => (Array.isArray(days) && days.length) ? false : false,
    eventFirstDay: (days) => (Array.isArray(days) && days.length) ? days[0] : null,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'bigEventBannerHtml-extract.js' }).runInContext(sandbox);
  return sandbox.bigEventBannerHtml;
}

test('bigEventBannerHtml(): DREAM_PROMO_BANNERは<img>のまま(customBannerではない)で、他の画像バナーと同じ出力形(style属性等の特別扱いなし)', () => {
  const bigEventBannerHtml = loadBigEventBannerHtml();
  const html = bigEventBannerHtml(DB.DREAM_PROMO_BANNER);
  assert.ok(!html.includes('eb-custom'), 'eb-customブロックが出力されている(実画像なのにCSS組み立て経路に入っている)');
  assert.strictEqual(
    html.match(/<img[^>]*>/)[0],
    '<img class="eb-img" src="img/dream/dream-saturday-tournament.jpg" alt="CASINO BAR DreaM Saturdayトーナメント（久留米）">',
    '既存の画像バナー(FST等)と同じ<img class="eb-img" src="..." alt="...">の形になっていない'
    + '(style属性等のクロップ指定が付いていないか確認すること)'
  );
  assert.ok(html.includes('class="evtBanner ev-dream"'), 'bannerClass(ev-dream)が付いていない');
  assert.ok(html.includes('href="/events/dream-saturday-tournament/"'), 'href が反映されていない');
  assert.ok(html.includes('毎週土曜開催・久留米'), 'bannerDesc(eb-tag)が出力されていない');
  assert.ok(html.includes('特典を見る →'), 'btnTextが出力されていない');
});

// ============================================================
// index.html: renderBigEventBanner() 内の連結順
// (運営指摘の再発防止: 大型大会より【常に先頭】に出ること)
// ============================================================
function extractRenderConcat() {
  const start = INDEX_HTML.indexOf('    const promos = (typeof visiblePromoBanners === \'function\')');
  const end = INDEX_HTML.indexOf('    // JOPT/NIPPONのデータ読み込み後に描き直すことがある');
  if (start < 0 || end <= start) {
    throw new Error('index.html から renderBigEventBanner() の連結部分を切り出せませんでした。'
      + '目印を動かしたなら、このテストの目印も直すこと。');
  }
  return INDEX_HTML.slice(start, end);
}

test('★renderBigEventBanner(): DreaMのPRバナーは大型大会(FST等)より【常に先頭】に連結される(運営指摘の再発防止)', () => {
  const src = extractRenderConcat();
  const sandbox = {
    visiblePromoBanners: () => [{ id: 'promoX' }],
    visibleBigEvents: () => [{ id: 'fst' }, { id: 'spadie' }],
    visibleDreamPromoBanner: () => [{ id: 'dream-saturday-tournament' }],
    visibleListingBanner: () => [{ id: 'listing-recruit' }]
  };
  vm.createContext(sandbox);
  new vm.Script(src + '\n;evs', { filename: 'renderBigEventBanner-extract.js' }).runInContext(sandbox);
  const ids = new vm.Script('evs.map(e => e.id)').runInContext(sandbox);
  assert.deepStrictEqual(ids, ['promoX', 'dream-saturday-tournament', 'fst', 'spadie', 'listing-recruit']);
});

test('renderBigEventBanner(): 他の告知が0件でもDreaMのPRバナー単体で1件返る', () => {
  const src = extractRenderConcat();
  const sandbox = {
    visiblePromoBanners: () => [],
    visibleBigEvents: () => [],
    visibleDreamPromoBanner: () => [{ id: 'dream-saturday-tournament' }],
    visibleListingBanner: () => []
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'renderBigEventBanner-extract2.js' }).runInContext(sandbox);
  const ids = new vm.Script('evs.map(e => e.id)').runInContext(sandbox);
  assert.deepStrictEqual(ids, ['dream-saturday-tournament']);
});

test('renderBigEventBanner(): dream-promo-banner.js が読み込まれていなくても(typeofの保険)他のバナーは壊れない', () => {
  const src = extractRenderConcat();
  const sandbox = {
    visiblePromoBanners: () => [{ id: 'promoX' }],
    visibleBigEvents: () => [{ id: 'fst' }],
    // visibleDreamPromoBanner を渡さない(未読み込みを再現)
    visibleListingBanner: () => [{ id: 'listing-recruit' }]
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'renderBigEventBanner-extract3.js' }).runInContext(sandbox);
  const ids = new vm.Script('evs.map(e => e.id)').runInContext(sandbox);
  assert.deepStrictEqual(ids, ['promoX', 'fst', 'listing-recruit']);
});

// ============================================================
// CSS: 「PR」バッジを常に表示していること(景品表示法のステマ規制対応)
// ============================================================
test('CSS: .evtBanner.ev-dream では eb-tag::before(状態バッジ)を常に「PR」に上書きしている', () => {
  assert.match(INDEX_HTML, /\.evtBanner\.ev-dream \.eb-tag::before\{content:"PR"/);
});
