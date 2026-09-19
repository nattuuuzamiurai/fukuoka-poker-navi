#!/usr/bin/env node
/**
 * dream-promo-banner.test.js — CASINO BAR DreaM PR掲載の常設バナー(dream-promo-banner.js)のテスト
 *
 * 実行: node tools/dream-promo-banner.test.js (または node --test tools/*.test.js)
 *
 * 【なぜこのファイルがあるか】listing-banner.test.js と同じ考え方。
 *   dream-promo-banner.js は日付を持たない常設バナーで掲載期間の計算は無いが、
 *   ①オン/オフの切り替え口(visibleDreamPromoBanner)、②実画像を使う経路(customBannerではない
 *   ことの回帰防止・正方形フライヤー用のimgAspectトリミング)、③renderBigEventBanner() 内の
 *   連結順(会期のある告知の後ろ・掲載店舗募集の前)、④「PR」バッジの常時表示(CSS上書き)、
 *   の4点は固定しておかないと次に誰かが触ったときの巻き戻りに気づけない。
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

test('DREAM_PROMO_BANNER: リンク先は店舗ページ(確定仕様)', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.href, '/venues/dream-casinobar-kurume/');
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

test('DREAM_PROMO_BANNER: imgAspect(正方形フライヤーのトリミング比率)が指定されている', () => {
  assert.strictEqual(DB.DREAM_PROMO_BANNER.imgAspect, '2/1');
});

test('DREAM_PROMO_BANNER: label を持つ(カルーセルのec-dotsのaria-labelで使うため必須)', () => {
  assert.ok(DB.DREAM_PROMO_BANNER.label);
});

// ============================================================
// 実ファイル: 画像アセットが実在し、正方形であること(imgAspectのトリミング前提の確認)
// ============================================================
test('画像アセット: img/dream/dream-saturday-tournament.jpg が実在する', () => {
  const p = path.join(__dirname, '..', DB.DREAM_PROMO_BANNER.banner);
  assert.ok(fs.existsSync(p), `${p} が存在しません`);
});

// ============================================================
// index.html: bigEventBannerHtml() の imgAspect 分岐
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

test('bigEventBannerHtml(): DREAM_PROMO_BANNERは<img>のまま(customBannerではない)で、imgAspectがstyleに反映される', () => {
  const bigEventBannerHtml = loadBigEventBannerHtml();
  const html = bigEventBannerHtml(DB.DREAM_PROMO_BANNER);
  assert.ok(html.includes('<img class="eb-img"'), '<img>が出力されていない(customBanner経路に誤って入っていないか)');
  assert.ok(!html.includes('eb-custom'), 'eb-customブロックが出力されている(実画像なのにCSS組み立て経路に入っている)');
  assert.ok(html.includes('src="img/dream/dream-saturday-tournament.jpg"'), '画像srcが反映されていない');
  assert.ok(html.includes('aspect-ratio:2/1'), 'imgAspectがstyleのaspect-ratioに反映されていない');
  assert.ok(html.includes('object-fit:cover'), 'object-fitが反映されていない');
  assert.ok(html.includes('class="evtBanner ev-dream"'), 'bannerClass(ev-dream)が付いていない');
  assert.ok(html.includes('href="/venues/dream-casinobar-kurume/"'), 'href が反映されていない');
  assert.ok(html.includes('毎週土曜開催・久留米'), 'bannerDesc(eb-tag)が出力されていない');
  assert.ok(html.includes('特典を見る →'), 'btnTextが出力されていない');
});

test('bigEventBannerHtml(): imgAspectを持たない既存の画像バナーはstyle属性が付かない(回帰防止)', () => {
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
  assert.ok(html.includes('<img class="eb-img" src="img/fst/fst-banner.svg" alt="FST 5.0 2026 福岡">'),
    '既存の画像バナーの出力が変わっている(style属性が余分に付いていないか)');
});

// ============================================================
// index.html: renderBigEventBanner() 内の連結順
// (会期のある告知の後ろ・掲載店舗募集バナーの前)
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

test('renderBigEventBanner(): DreaMのPRバナーは promos/visibleBigEvents の後ろ・掲載店舗募集の前に連結される', () => {
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
  assert.deepStrictEqual(ids, ['promoX', 'fst', 'spadie', 'dream-saturday-tournament', 'listing-recruit']);
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
    visibleBigEvents: () => [],
    // visibleDreamPromoBanner を渡さない(未読み込みを再現)
    visibleListingBanner: () => [{ id: 'listing-recruit' }]
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'renderBigEventBanner-extract3.js' }).runInContext(sandbox);
  const ids = new vm.Script('evs.map(e => e.id)').runInContext(sandbox);
  assert.deepStrictEqual(ids, ['promoX', 'listing-recruit']);
});

// ============================================================
// CSS: 「PR」バッジを常に表示していること(景品表示法のステマ規制対応)
// ============================================================
test('CSS: .evtBanner.ev-dream では eb-tag::before(状態バッジ)を常に「PR」に上書きしている', () => {
  assert.match(INDEX_HTML, /\.evtBanner\.ev-dream \.eb-tag::before\{content:"PR"/);
});
