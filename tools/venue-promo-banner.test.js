#!/usr/bin/env node
/**
 * venue-promo-banner.test.js — 店舗自身のページ上部に出すPRバナー(promo-banners.js の
 * venueId・tools/site-shell.js の venuePromoBannerHtml・tools/gen-venue-pages.js の統合)のテスト
 *
 * 実行: node tools/venue-promo-banner.test.js (または node --test tools/*.test.js)
 *
 * 【背景・2026-09-26】promo-banners.js の PROMO_BANNERS(店舗のグランドオープン記念など単発の
 * プロモ)に対象店舗(venueId)を持たせられるようにし、店舗静的ページ(tools/gen-venue-pages.js)の
 * 上部にも同じバナー(見た目・画像・リンク先はトップページと共通の bigEventBannerHtml()〔big-events.js〕
 * を使うため常に一致する)を自動で出す仕組みを追加した。
 *
 * 【何を固定するか】
 *   1. venuePromoBanners(venueId, today, promos) 単体: venueId一致・掲載期間内のものだけを返す。
 *   2. 統合: 実際に gen-venue-pages.js を(一時複製に対して)実行し、
 *      - 対象店舗のページにはバナーが出る
 *      - 対象外の店舗のページには出ない
 *      - 掲載期間外なら対象店舗であっても出ない
 *      ことを、生成された実HTMLで確認する(本番の promo-banners.js は一切書き換えない。
 *      一時複製〔.gitを含まない〕の promo-banners.js だけをテスト用エントリで上書きする。
 *      tools/no-internal-leaks.test.js と同じやり方)。
 *   3. 本番データの巻き戻り検知: dream-grandopen-2026 が venueId: 'v42'(DreaM CASINO BAR)を
 *      持っていること。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const PROMO = require('../promo-banners.js');
const DATA = require('../data.js');

// ============================================================
// 1. venuePromoBanners() 単体
// ============================================================

test('venuePromoBanners(): venueIdが一致し掲載期間内のプロモだけを返す(他店のプロモは混ざらない)', () => {
  const promos = [
    { id: 'a', venueId: 'v1', days: ['2026-09-05'] },
    { id: 'b', venueId: 'v2', days: ['2026-09-05'] }
  ];
  assert.deepStrictEqual(PROMO.venuePromoBanners('v1', '2026-09-02', promos).map(p => p.id), ['a']);
  assert.deepStrictEqual(PROMO.venuePromoBanners('v2', '2026-09-02', promos).map(p => p.id), ['b']);
});

test('venuePromoBanners(): venueIdが一致しない店では空配列', () => {
  const promos = [{ id: 'a', venueId: 'v1', days: ['2026-09-05'] }];
  assert.deepStrictEqual(PROMO.venuePromoBanners('v99', '2026-09-02', promos), []);
});

test('venuePromoBanners(): venueId未指定(undefined/null/空文字)の呼び出しは常に空配列', () => {
  const promos = [{ id: 'a', venueId: 'v1', days: ['2026-09-05'] }];
  assert.deepStrictEqual(PROMO.venuePromoBanners(undefined, '2026-09-02', promos), []);
  assert.deepStrictEqual(PROMO.venuePromoBanners(null, '2026-09-02', promos), []);
  assert.deepStrictEqual(PROMO.venuePromoBanners('', '2026-09-02', promos), []);
});

test('venuePromoBanners(): venueIdが一致していても掲載期間外(打ち切り後)なら空配列', () => {
  const promos = [{ id: 'a', venueId: 'v1', days: ['2026-09-05'] }];
  // 最終日翌日6:00より前は表示、以降は非表示(promo-banners.test.jsと同じ境界)
  assert.deepStrictEqual(PROMO.venuePromoBanners('v1', new Date(2026, 8, 6, 5, 59, 59), promos).map(p => p.id), ['a']);
  assert.deepStrictEqual(PROMO.venuePromoBanners('v1', new Date(2026, 8, 6, 6, 0, 0), promos), []);
});

test('venuePromoBanners(): 掲載開始日より前(初日−14日より前)は空配列', () => {
  const promos = [{ id: 'a', venueId: 'v1', days: ['2026-09-05'] }];
  assert.deepStrictEqual(PROMO.venuePromoBanners('v1', '2026-08-21', promos), []);
});

test('本番のPROMO_BANNERS: dream-grandopen-2026 は venueId: v42(DreaM CASINO BAR)を持つ(巻き戻り検知用)', () => {
  const dream = PROMO.PROMO_BANNERS.find(p => p.id === 'dream-grandopen-2026');
  assert.ok(dream, 'PROMO_BANNERSにdream-grandopen-2026が見つからない');
  assert.strictEqual(dream.venueId, 'v42');
  const target = DATA.VENUES.find(v => v.id === 'v42');
  assert.ok(target, 'data.jsのVENUESにv42が見つからない');
  assert.strictEqual(target.name, 'DreaM CASINO BAR', 'v42がDreaM CASINO BARではない(venueIdの取り違えの可能性)');
});

// ============================================================
// 2. 統合: 実際に gen-venue-pages.js を実行して生成したHTMLで確認する
//    (このリポジトリ本体・本番の promo-banners.js は一切書き換えない)
// ============================================================

const TARGET_VENUE = DATA.VENUES[0];  // バナーが出るべき店
const OTHER_VENUE = DATA.VENUES[1];   // バナーが出てはいけない店(対象外)
assert.notStrictEqual(TARGET_VENUE.id, OTHER_VENUE.id, 'テストの前提(異なる2店舗)が壊れています');

function localTodayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/**
 * リポジトリを一時ディレクトリに複製し、複製側の promo-banners.js の PROMO_BANNERS の先頭に
 * テスト用の1エントリだけを追加してから gen-venue-pages.js を実行する。
 * 戻り値: 一時ディレクトリのパス(呼び出し側が使い終わったら削除すること)。
 */
function buildWithTempPromoEntry(entry) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fpn-venue-promo-'));
  fs.cpSync(REPO, tmpRoot, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });

  const promoPath = path.join(tmpRoot, 'promo-banners.js');
  const src = fs.readFileSync(promoPath, 'utf8');
  const marker = 'const PROMO_BANNERS = [';
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error('promo-banners.js の "const PROMO_BANNERS = [" が見つかりませんでした(目印がズレている可能性)');
  // entry はプレーンなJSON互換オブジェクトのみを渡す前提(JSON.stringifyがそのまま正しいJS構文になる)。
  const patched = src.slice(0, idx + marker.length) + '\n' + JSON.stringify(entry) + ',\n' + src.slice(idx + marker.length);
  fs.writeFileSync(promoPath, patched, 'utf8');

  execFileSync(process.execPath, [path.join(tmpRoot, 'tools', 'gen-venue-pages.js'), tmpRoot], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return tmpRoot;
}

function readVenuePage(tmpRoot, slug) {
  return fs.readFileSync(path.join(tmpRoot, 'venues', slug, 'index.html'), 'utf8');
}

test('統合: 掲載期間内のプロモは対象店舗のページ上部(h1より前)にだけ出て、対象外の店舗には出ない', () => {
  const entry = {
    id: 'test-venue-promo-temp-active',
    label: 'テスト用プロモ(統合テスト)',
    days: [localTodayStr()],
    href: '/events/test-venue-promo-temp/',
    venueId: TARGET_VENUE.id,
    banner: 'img/dream/dream-grandopen-banner.jpg',
    bannerAlt: 'テスト用プロモバナー(統合テスト)',
    bannerDesc: 'テスト用プロモ・統合テスト',
    bannerClass: 'ev-dream',
  };
  const tmpRoot = buildWithTempPromoEntry(entry);
  try {
    const targetHtml = readVenuePage(tmpRoot, TARGET_VENUE.slug);
    const bannerIdx = targetHtml.indexOf('vp-promo-banner');
    const h1Idx = targetHtml.indexOf('<h1>');
    assert.ok(bannerIdx >= 0, `対象店舗(${TARGET_VENUE.slug})のページにバナーが出ていません`);
    assert.ok(h1Idx >= 0, '対象店舗のページに<h1>が見つかりません(テストの前提が壊れている)');
    assert.ok(bannerIdx < h1Idx, 'バナーが<h1>より後ろに出ています(パンくず直後・店舗名より前に出す想定)');
    assert.ok(targetHtml.includes('テスト用プロモバナー(統合テスト)'), 'bannerAltが出力されていません');
    assert.ok(targetHtml.includes('href="/events/test-venue-promo-temp/"'), 'hrefが出力されていません');
    assert.ok(targetHtml.includes('class="evtBanner ev-dream"'), 'bannerClassが出力されていません');
    assert.ok(targetHtml.includes('.evtBanner{'), 'バナーのCSS(BANNER_CSS)が出力されていません');

    const otherHtml = readVenuePage(tmpRoot, OTHER_VENUE.slug);
    assert.ok(!otherHtml.includes('vp-promo-banner'), `対象外店舗(${OTHER_VENUE.slug})のページにバナーが出てしまっています`);
    assert.ok(!otherHtml.includes('テスト用プロモバナー(統合テスト)'), '対象外店舗のページにテスト用プロモの文言が混入しています');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('統合: 掲載期間外(とうに終了)のプロモは対象店舗であってもページに出ない', () => {
  const entry = {
    id: 'test-venue-promo-temp-expired',
    label: 'テスト用プロモ(統合テスト・期限切れ)',
    days: ['2000-01-01'],
    href: '/events/test-venue-promo-temp-expired/',
    venueId: TARGET_VENUE.id,
    banner: 'img/dream/dream-grandopen-banner.jpg',
    bannerAlt: 'テスト用プロモバナー(統合テスト・期限切れ)',
    bannerDesc: 'テスト用プロモ・期限切れ',
    bannerClass: 'ev-dream',
  };
  const tmpRoot = buildWithTempPromoEntry(entry);
  try {
    const targetHtml = readVenuePage(tmpRoot, TARGET_VENUE.slug);
    assert.ok(!targetHtml.includes('vp-promo-banner'), '掲載期間外のプロモがページに出てしまっています');
    assert.ok(!targetHtml.includes('テスト用プロモバナー(統合テスト・期限切れ)'), '掲載期間外のプロモの文言が混入しています');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('統合: venueIdの無い(全店共通=トップのみ対象の)プロモは、どの店舗ページにも出ない', () => {
  const entry = {
    id: 'test-venue-promo-temp-no-venueid',
    label: 'テスト用プロモ(統合テスト・venueIdなし)',
    days: [localTodayStr()],
    href: '/events/test-venue-promo-temp-no-venueid/',
    banner: 'img/dream/dream-grandopen-banner.jpg',
    bannerAlt: 'テスト用プロモバナー(統合テスト・venueIdなし)',
    bannerDesc: 'テスト用プロモ・venueIdなし',
    bannerClass: 'ev-dream',
  };
  const tmpRoot = buildWithTempPromoEntry(entry);
  try {
    const targetHtml = readVenuePage(tmpRoot, TARGET_VENUE.slug);
    const otherHtml = readVenuePage(tmpRoot, OTHER_VENUE.slug);
    assert.ok(!targetHtml.includes('vp-promo-banner'), 'venueId無しのプロモが店舗ページに出てしまっています');
    assert.ok(!otherHtml.includes('vp-promo-banner'), 'venueId無しのプロモが店舗ページに出てしまっています');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
