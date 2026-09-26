#!/usr/bin/env node
/**
 * site-banner.test.js — サイト全体のバナー(site-banner.js)のテスト
 *
 * 実行: node tools/site-banner.test.js (または node --test tools/*.test.js)
 *
 * 【背景・2026-09-26】トップページ(index.html)の最上部にだけ出していたバナー(大型大会・
 * 単発/常設プロモ・掲載店舗募集)を、店舗ページ・エリアページ・大会ページ・初心者ガイド・
 * トップページ内SPAの店舗詳細ビュー(#venue/vXX)にも「トップと全く同じ内容」で出すようにした。
 * 直前には「店舗自身のページにだけ、その店舗のプロモを出す」という狭い実装
 * (promo-banners.js の venuePromoBanners())があったが、これを置き換える。
 *
 * 【何を固定するか】
 *   1. visibleSiteBanners() 単体: promos → 大型大会 → 掲載店舗募集 の順で連結されること。
 *   2. siteBannerInnerHtml() / siteBannerClass() / siteBannerBlockHtml(): 0件/1件/複数件の
 *      出し分け(空 / バナー1枚 / カルーセル)。
 *   3. 統合: 実際に gen-venue-pages.js / gen-area-pages.js / gen-event-pages.js /
 *      gen-guide-pages.js を(一時複製に対して)実行し、
 *      - 対象ページ(店舗/エリア/大会/初心者ガイド)の上部(h1より前)にバナーが出ること
 *      - 複数件あればカルーセル(.evtCarousel/.ec-track)になること
 *      - 対象外ページ(guide/partners・guide/webcoin-regulation)には出ないこと
 *      を、生成された実HTMLで確認する(本番の promo-banners.js は一切書き換えない。
 *      一時複製〔.gitを含まない〕の promo-banners.js だけをテスト用エントリで上書きする。
 *      tools/no-internal-leaks.test.js と同じやり方)。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SB = require('../site-banner.js');

// ============================================================
// 1. visibleSiteBanners(): 連結順
// ============================================================

test('visibleSiteBanners(): 単発/常設プロモ → 大型大会 → 掲載店舗募集 の順で連結される', () => {
  // FST 5.0(2026-09-19〜23)の掲載ウィンドウ内(2026-09-20)を使う。
  // このタイミングでは常設プロモ(dream-saturday-tournament)・FST・掲載店舗募集の3件が揃う。
  const ids = SB.visibleSiteBanners('2026-09-20').map(e => e.id);
  assert.deepEqual(ids, ['dream-saturday-tournament', 'fst', 'listing-recruit']);
});

test('visibleSiteBanners(): 大型大会が0件の日でも、常設プロモ・掲載店舗募集はそのまま出る', () => {
  // 2026-08-18〜08-19はどの大型大会の掲載ウィンドウにも入らない(big-events.js の仕様どおり0件)。
  const ids = SB.visibleSiteBanners('2026-08-18').map(e => e.id);
  assert.deepEqual(ids, ['dream-saturday-tournament', 'listing-recruit']);
});

// ============================================================
// 2. markup生成(0件/1件/複数件)
// ============================================================

const evA = { id: 'a', label: 'A', href: '/a/', banner: 'img/a.jpg', bannerAlt: 'A', bannerDesc: 'd1', bannerClass: 'ev-dream' };
const evB = { id: 'b', label: 'B', href: '/b/', banner: 'img/b.jpg', bannerAlt: 'B', bannerDesc: 'd2', bannerClass: 'ev-listing' };

test('siteBannerClass(): 0件/1件はクラス無し、2件以上はevtCarousel', () => {
  assert.equal(SB.siteBannerClass([]), '');
  assert.equal(SB.siteBannerClass([evA]), '');
  assert.equal(SB.siteBannerClass([evA, evB]), 'evtCarousel');
});

test('siteBannerInnerHtml(): 0件は空文字列', () => {
  assert.equal(SB.siteBannerInnerHtml([]), '');
});

test('siteBannerInnerHtml(): 1件はバナー1枚分のHTML(カルーセルUIなし)', () => {
  const html = SB.siteBannerInnerHtml([evA]);
  assert.ok(html.includes('href="/a/"'));
  assert.ok(!html.includes('ec-track'), '1件なのにカルーセルのUIが出ている');
});

test('siteBannerInnerHtml(): 2件以上は.ec-track/.ec-dots/矢印を含むカルーセルになる', () => {
  const html = SB.siteBannerInnerHtml([evA, evB]);
  assert.ok(html.includes('ec-track'));
  assert.ok(html.includes('ec-dots'));
  assert.ok(html.includes('ec-prev') && html.includes('ec-next'));
  assert.ok(html.includes('href="/a/"') && html.includes('href="/b/"'));
});

test('siteBannerBlockHtml(): <div id="…">…</div>で包む。0件でも空のdivを返す(:empty連動のため)', () => {
  assert.equal(SB.siteBannerBlockHtml([], 'x'), '<div id="x"></div>');
  const html1 = SB.siteBannerBlockHtml([evA], 'x');
  assert.ok(html1.startsWith('<div id="x">') && !html1.includes('class="evtCarousel"'));
  const html2 = SB.siteBannerBlockHtml([evA, evB], 'x');
  assert.ok(html2.startsWith('<div id="x" class="evtCarousel">'));
});

// ============================================================
// opts.staticPage の転送(2026-09-26追加)
// 【背景】WJPT/JOPT/NIPPON/FSTのように `hash`('#wjpt' 等)しか持たないイベントを、
// index.html を経由しない独立した静的ページ(店舗/エリア/大会/初心者ガイド)に埋め込むと、
// そのままでは「クリックしても何も起きないリンク」になる(big-events.js の
// bigEventBannerHtml() コメント参照)。siteBannerInnerHtml/siteBannerBlockHtml/mountSiteBanner
// のどれから呼んでも、渡した opts.staticPage が big-events.js まで届くことを固定する。
// ============================================================
const hashOnlyEv = { id: 'fst', label: 'FST', hash: '#fst', featureUrl: '/events/fst-2026-fukuoka/', banner: 'img/fst/fst-banner.svg', bannerAlt: 'FST', bannerDesc: 'd', bannerClass: 'ev-fst' };

test('siteBannerInnerHtml(): opts.staticPageを渡さないとhashのまま(index.html自身のハッシュルーター向け、既定)', () => {
  const html = SB.siteBannerInnerHtml([hashOnlyEv]);
  assert.ok(html.includes('href="#fst"'), `hashのまま出ていない: ${html}`);
});

test('siteBannerInnerHtml(): opts.staticPage:trueを渡すとfeatureUrlに切り替わる(1件のときも複数件のときも)', () => {
  const html1 = SB.siteBannerInnerHtml([hashOnlyEv], { staticPage: true });
  assert.ok(html1.includes('href="/events/fst-2026-fukuoka/"'), `1件のときfeatureUrlに切り替わっていない: ${html1}`);
  const html2 = SB.siteBannerInnerHtml([hashOnlyEv, evA], { staticPage: true });
  assert.ok(html2.includes('href="/events/fst-2026-fukuoka/"'), `複数件のときfeatureUrlに切り替わっていない: ${html2}`);
});

test('siteBannerBlockHtml(): opts.staticPageがbigEventBannerHtml()まで届く', () => {
  const html = SB.siteBannerBlockHtml([hashOnlyEv], 'x', { staticPage: true });
  assert.ok(html.includes('href="/events/fst-2026-fukuoka/"'), `opts.staticPageが届いていない: ${html}`);
});

// ============================================================
// 3. 統合: 実際に生成スクリプトを実行して確認する
//    (このリポジトリ本体・本番の promo-banners.js は一切書き換えない)
// ============================================================

/**
 * リポジトリを一時ディレクトリに複製し、複製側の promo-banners.js の PROMO_BANNERS を
 * 【常設(days無し)のテスト用2件だけ】に差し替えてから、対象の生成スクリプトを実行する。
 * 2件にするのは「複数件あればカルーセルになる」ことを、日付に依存せず決定論的に確認するため。
 * 戻り値: 一時ディレクトリのパス(呼び出し側が使い終わったら削除すること)。
 */
function buildSiteWithTestBanners() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fpn-site-banner-'));
  fs.cpSync(REPO, tmpRoot, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });

  const promoPath = path.join(tmpRoot, 'promo-banners.js');
  const src = fs.readFileSync(promoPath, 'utf8');
  const marker = /const PROMO_BANNERS = \[[\s\S]*?\n\];/;
  if (!marker.test(src)) throw new Error('promo-banners.js の PROMO_BANNERS 配列が見つかりませんでした(目印がズレている可能性)');
  const testEntries = [
    { id: 'test-site-banner-1', label: 'テストバナー1', href: '/events/test-site-banner-1/', banner: 'img/dream/dream-grandopen-banner.jpg', bannerAlt: 'テストバナー1', bannerDesc: 'テスト用', bannerClass: 'ev-dream' },
    { id: 'test-site-banner-2', label: 'テストバナー2', href: '/events/test-site-banner-2/', banner: 'img/dream/dream-grandopen-banner.jpg', bannerAlt: 'テストバナー2', bannerDesc: 'テスト用', bannerClass: 'ev-dream' },
  ];
  const patched = src.replace(marker, `const PROMO_BANNERS = ${JSON.stringify(testEntries)};`);
  fs.writeFileSync(promoPath, patched, 'utf8');

  const generators = ['gen-venue-pages.js', 'gen-area-pages.js', 'gen-event-pages.js', 'gen-guide-pages.js', 'gen-guide-partners.js', 'gen-guide-webcoin-regulation.js'];
  for (const script of generators) {
    execFileSync(process.execPath, [path.join(tmpRoot, 'tools', script), tmpRoot], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return tmpRoot;
}

let tmpRoot;
let setupError = null;
try {
  tmpRoot = buildSiteWithTestBanners();
} catch (e) {
  setupError = e;
}

test.after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('統合: テスト用データの生成に成功する(このテストの前提)', () => {
  assert.equal(setupError, null, `生成に失敗しました: ${setupError && setupError.stack}`);
});

function assertBannerBeforeH1(html, label) {
  const bannerIdx = html.indexOf('id="siteBanner"');
  const h1Idx = html.indexOf('<h1>');
  assert.ok(bannerIdx >= 0, `${label}: siteBannerが出ていません`);
  assert.ok(h1Idx >= 0, `${label}: <h1>が見つかりません(テストの前提が壊れている)`);
  assert.ok(bannerIdx < h1Idx, `${label}: バナーが<h1>より後ろに出ています`);
}

function assertCarousel(html, label) {
  assert.ok(html.includes('class="evtCarousel"'), `${label}: 2件あるのにカルーセル(evtCarousel)になっていません`);
  assert.ok(html.includes('テストバナー1') && html.includes('テストバナー2'), `${label}: テスト用の2件がどちらも出ていません`);
}

test('統合: 店舗ページ(venues/<slug>/)の上部にサイト全体のバナー(カルーセル)が出る', () => {
  assert.equal(setupError, null);
  const dirs = fs.readdirSync(path.join(tmpRoot, 'venues'), { withFileTypes: true }).filter(d => d.isDirectory());
  assert.ok(dirs.length > 0, '店舗ページが1件も生成されていません');
  const html = fs.readFileSync(path.join(tmpRoot, 'venues', dirs[0].name, 'index.html'), 'utf8');
  assertBannerBeforeH1(html, `venues/${dirs[0].name}/`);
  assertCarousel(html, `venues/${dirs[0].name}/`);
});

test('統合: エリアページ(areas/<slug>/)の上部にサイト全体のバナー(カルーセル)が出る', () => {
  assert.equal(setupError, null);
  const dirs = fs.readdirSync(path.join(tmpRoot, 'areas'), { withFileTypes: true }).filter(d => d.isDirectory());
  assert.ok(dirs.length > 0, 'エリアページが1件も生成されていません');
  const html = fs.readFileSync(path.join(tmpRoot, 'areas', dirs[0].name, 'index.html'), 'utf8');
  assertBannerBeforeH1(html, `areas/${dirs[0].name}/`);
  assertCarousel(html, `areas/${dirs[0].name}/`);
});

test('統合: 大会ページ(events/<slug>/、生成対象の5件すべて)の上部にサイト全体のバナー(カルーセル)が出る', () => {
  assert.equal(setupError, null);
  const slugs = ['jopt-2026-fukuoka-01', 'wjpt-2026', 'nippon-series-2026-fukuoka', 'fst-2026-fukuoka', 'spadie-fukuoka-1st'];
  for (const slug of slugs) {
    const html = fs.readFileSync(path.join(tmpRoot, 'events', slug, 'index.html'), 'utf8');
    assertBannerBeforeH1(html, `events/${slug}/`);
    assertCarousel(html, `events/${slug}/`);
  }
});

test('統合: 初心者ガイド(guide/beginner/)の上部にサイト全体のバナー(カルーセル)が出る', () => {
  assert.equal(setupError, null);
  const html = fs.readFileSync(path.join(tmpRoot, 'guide', 'beginner', 'index.html'), 'utf8');
  assertBannerBeforeH1(html, 'guide/beginner/');
  assertCarousel(html, 'guide/beginner/');
});

test('統合: 対象外ページ(guide/partners/・guide/webcoin-regulation/)にはバナーが出ない', () => {
  assert.equal(setupError, null);
  const partnersHtml = fs.readFileSync(path.join(tmpRoot, 'guide', 'partners', 'index.html'), 'utf8');
  const webcoinHtml = fs.readFileSync(path.join(tmpRoot, 'guide', 'webcoin-regulation', 'index.html'), 'utf8');
  assert.ok(!partnersHtml.includes('id="siteBanner"'), 'guide/partners/にバナーが出てしまっています');
  assert.ok(!webcoinHtml.includes('id="siteBanner"'), 'guide/webcoin-regulation/にバナーが出てしまっています');
});
