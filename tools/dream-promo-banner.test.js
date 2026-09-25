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
 *     (=他の画像バナーと全く同じ経路で描画されることを固定する)。その後、横長(1024×412)の
 *     専用画像が用意でき、img/dream/dream-saturday-tournament.jpg を差し替えた
 *     (下の「画像アセット」テストで寸法を固定する)。
 *   - リンク先: 店舗ページ(venues/dream-casinobar-kurume/)からトーナメント専用ページ
 *     (events/dream-saturday-tournament/)に変更。
 *   - 【DreaM固有ではない構造的な指摘】カルーセルに並ぶバナーが「画像(.eb-img・縦横比まかせ)」と
 *     「CSS組み(.eb-custom・固定px)」の2系統でレンダリング方式自体が違い、PC幅で高さが揃わない
 *     (「FSTと掲載店舗募集バナーとDreaMのバナーがバラバラ」との指摘)。原因は listing-banner.js
 *     導入(2026-09-17)時点から潜在していたもので、DreaM追加で目立つようになっただけ。
 *     index.html 側で .eb-img/.eb-custom 両方に同じ aspect-ratio(1024/412)を指定して統一した
 *     (下の「メディア部分の高さ統一」テストで固定する)。
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
  assert.strictEqual(DB.DREAM_PROMO_BANNER.bannerDesc, '毎週土曜日・久留米・18時スタート');
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
// 実ファイル: 画像アセットが実在し、他の大型大会バナーと同じ比率(1024×412)であること
// (2026-09-19: 正方形の暫定画像 → 横長の専用画像に差し替え済み。依存ライブラリを増やさないよう
//  JPEGのSOFセグメントを直接読む最小限のパーサーで寸法だけ確認する)
// ============================================================
/** JPEGファイルの (width, height) を返す。JPEGでない/読めない場合は null。 */
function jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // SOIマーカーが無い
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xFF) { offset++; continue; }
    const marker = buf[offset + 1];
    // スタンドアロンマーカー(長さフィールドを持たない)。TEM(0x01)・RSTn(0xD0-0xD7)。
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
    if (marker === 0xD9) return null; // EOIまでSOFが見つからなかった
    const length = buf.readUInt16BE(offset + 2);
    // SOF0〜SOF15のうち、DHT(0xC4)/JPG(0xC8)/DAC(0xCC)は「SOFではない」例外
    const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSof) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

test('画像アセット: img/dream/dream-saturday-tournament.jpg が実在する', () => {
  const p = path.join(__dirname, '..', DB.DREAM_PROMO_BANNER.banner);
  assert.ok(fs.existsSync(p), `${p} が存在しません`);
});

test('画像アセット: 1024×412(他の大型大会バナーと同じ比率。カルーセルの高さ統一の前提)', () => {
  const p = path.join(__dirname, '..', DB.DREAM_PROMO_BANNER.banner);
  const dim = jpegDimensions(fs.readFileSync(p));
  assert.ok(dim, `${p} からJPEGの寸法を読み取れませんでした`);
  assert.strictEqual(dim.width, 1024, `幅が1024pxではありません(実際: ${dim.width}px)`);
  assert.strictEqual(dim.height, 412, `高さが412pxではありません(実際: ${dim.height}px)`);
});

// ============================================================
// big-events.js: bigEventBannerHtml() は他の画像バナーと全く同じ経路で描画される
// (imgAspect等の特別なクロップ処理を持ち込んでいないことの回帰防止)
// 2026-09-26: index.htmlから big-events.js へ移設されたため、vmでの文字列切り出しは不要になった。
// ============================================================
function loadBigEventBannerHtml() {
  return require('../big-events.js').bigEventBannerHtml;
}

test('bigEventBannerHtml(): DREAM_PROMO_BANNERは<img>のまま(customBannerではない)で、他の画像バナーと同じ出力形(style属性等の特別扱いなし)', () => {
  const bigEventBannerHtml = loadBigEventBannerHtml();
  const html = bigEventBannerHtml(DB.DREAM_PROMO_BANNER);
  assert.ok(!html.includes('eb-custom'), 'eb-customブロックが出力されている(実画像なのにCSS組み立て経路に入っている)');
  // src は 2026-09-26 からサイトルート起点の絶対パス('/img/...')に正規化されている
  // (big-events.js の bannerImgSrc() 参照。店舗ページ等の1階層下のページからも壊れず解決できるようにするため)。
  assert.strictEqual(
    html.match(/<img[^>]*>/)[0],
    '<img class="eb-img" src="/img/dream/dream-saturday-tournament.jpg" alt="CASINO BAR DreaM Saturdayトーナメント（久留米）">',
    '既存の画像バナー(FST等)と同じ<img class="eb-img" src="..." alt="...">の形になっていない'
    + '(style属性等のクロップ指定が付いていないか確認すること)'
  );
  assert.ok(html.includes('class="evtBanner ev-dream"'), 'bannerClass(ev-dream)が付いていない');
  assert.ok(html.includes('href="/events/dream-saturday-tournament/"'), 'href が反映されていない');
  assert.ok(html.includes('毎週土曜日・久留米・18時スタート'), 'bannerDesc(eb-tag)が出力されていない');
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

// ============================================================
// CSS: メディア部分(.eb-img/.eb-custom)の高さ統一(2026-09-19・DreaM固有ではない構造修正)
// 「FSTと掲載店舗募集バナーとDreaMのバナーがバラバラ」という指摘の原因は、画像バナー
// (.eb-img・縦横比まかせ)とCSS組みバナー(.eb-custom・固定112px)でレンダリング方式自体が
// 違ったこと。両方に同じ aspect-ratio を指定して高さを揃えたことをここで固定する。
// ============================================================
test('CSS: .evtBanner .eb-img は他の大型大会バナーと同じ 1024/412 の aspect-ratio + object-fit:cover を持つ', () => {
  assert.match(INDEX_HTML, /\.evtBanner \.eb-img\{[^}]*aspect-ratio:1024\/412[^}]*\}/,
    '.eb-img に aspect-ratio:1024/412 が指定されていません');
  assert.match(INDEX_HTML, /\.evtBanner \.eb-img\{[^}]*object-fit:cover[^}]*\}/,
    '.eb-img に object-fit:cover が指定されていません(比率が違う画像が来たときにクロップされない)');
});

test('CSS: .evtBanner .eb-custom(掲載店舗募集バナー等)も .eb-img と同じ aspect-ratio を持ち、min-height はその下限としてのみ残る', () => {
  assert.match(INDEX_HTML, /\.evtBanner \.eb-custom\{[^}]*aspect-ratio:1024\/412[^}]*\}/,
    '.eb-custom に aspect-ratio:1024/412 が指定されていません(.eb-imgと高さが揃わない)');
  assert.match(INDEX_HTML, /\.evtBanner \.eb-custom\{[^}]*min-height:112px[^}]*\}/,
    '.eb-custom の min-height:112px(狭い画面での下限)が消えています');
});

// ============================================================
// トーナメント専用詳細ページ(events/dream-saturday-tournament/)のヘッダー画像
// (2026-09-19: トップのバナー画像(横長1024×412)とは別に、賞金内訳・ENTRY/ADDON・
//  ST/RC/STACK等の情報がすべて入った正方形の元画像(900×900)を専用ファイル名で用意し、
//  詳細ページだけそちらを使う。トップのバナー用画像を詳細ページで使い回さないことを固定する)
// ============================================================
const EVENT_PAGE_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'events', 'dream-saturday-tournament', 'index.html'), 'utf8'
);

test('画像アセット: img/dream/dream-saturday-tournament-detail.jpg が実在し、900×900である', () => {
  const p = path.join(__dirname, '..', 'img', 'dream', 'dream-saturday-tournament-detail.jpg');
  assert.ok(fs.existsSync(p), `${p} が存在しません`);
  const dim = jpegDimensions(fs.readFileSync(p));
  assert.ok(dim, `${p} からJPEGの寸法を読み取れませんでした`);
  assert.strictEqual(dim.width, 900, `幅が900pxではありません(実際: ${dim.width}px)`);
  assert.strictEqual(dim.height, 900, `高さが900pxではありません(実際: ${dim.height}px)`);
});

test('詳細ページ: ヘッダー画像はトップのバナー画像(横長)ではなく専用の detail 画像(正方形)を使っている', () => {
  assert.ok(
    EVENT_PAGE_HTML.includes('src="/img/dream/dream-saturday-tournament-detail.jpg"'),
    '詳細ページが dream-saturday-tournament-detail.jpg を参照していません'
  );
  assert.ok(
    !EVENT_PAGE_HTML.includes('src="/img/dream/dream-saturday-tournament.jpg"'),
    '詳細ページがトップのバナー画像(横長)をそのまま使い回しています(正方形の元画像に一本化すること)'
  );
});

test('詳細ページ: .evt-banner は正方形(aspect-ratio:1/1)専用の指定で、他の大会ページと同じ1024/412ではない', () => {
  assert.match(EVENT_PAGE_HTML, /\.evt-banner\{[^}]*aspect-ratio:1\/1[^}]*\}/,
    '.evt-banner に aspect-ratio:1/1 が指定されていません');
  assert.ok(
    !/\.evt-banner\{[^}]*aspect-ratio:1024\/412[^}]*\}/.test(EVENT_PAGE_HTML),
    '.evt-banner が他の大会ページと同じ1024/412のままになっています(正方形画像が引き伸ばされる)'
  );
});
