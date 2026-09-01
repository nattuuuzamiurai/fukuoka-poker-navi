#!/usr/bin/env node
/**
 * promo-banners.test.js — 単発の店舗プロモーション(promo-banners.js)の掲載期間ルールのテスト
 *
 * 実行: node tools/promo-banners.test.js (または node --test tools/*.test.js)
 *
 * 【なぜこのファイルがあるか】
 *   big-events.test.js(BANNER_LEAD_DAYS の変更漏れをPR #67で指摘された教訓)と同じ考え方。
 *   promo-banners.js は big-events.js の日付ヘルパーをそのまま使う設計だが、
 *   「PROMO_LEAD_DAYS の値」と「掲載ウィンドウの境界」は promo-banners.js 独自のパラメータなので、
 *   ここで固定しておかないと次に値を変えたときの巻き戻りに気づけない。
 *
 * 【実データ(PROMO_BANNERS)を境界値の検証に使わない理由】big-events.test.js と同じ。
 *   DreaMの登録内容は今後変わりうるため、境界の検証は visiblePromoBanners(today, promos) の
 *   第2引数(テスト用の差し替え口)に組み立てた固定の days を渡す。本番の PROMO_BANNERS は書き換えない。
 *
 * 【2026-09-02の本番障害・再発防止テストについて】
 *   promo-banners.js は当初、Node実行時だけ有効な `if (typeof module !== 'undefined') { var
 *   eventFirstDay = BE.eventFirstDay; … }` という互換ブロックを持っていたが、big-events.js と
 *   【同じ名前】で var 宣言していたため、ブラウザで
 *   `Uncaught SyntaxError: Identifier 'eventFirstDay' has already been declared` が発生し、
 *   本番デプロイ後に初めて発覚した(PR #74マージ後)。
 *   原因は、ブラウザの複数の<script>タグ(非module)が同じページ内でグローバルな字句スコープを
 *   共有すること。var 宣言は if 文の中にあっても【実行されなくても】構文解析の時点で
 *   スクリプト全体にホイスティングされるため、big-events.js側の `const eventFirstDay` と
 *   衝突する。CommonJSの `require()` はファイルごとにモジュールスコープが独立しているため、
 *   `node --test`(＝本ファイルの他のテスト)ではこの種の衝突を検知できない
 *   ―― 実際に検知できず、本番デプロイまで気づけなかった。
 *   そこで Node の `vm` モジュールで「1つの共有コンテキストに複数の<script>を順番に読み込む」を
 *   再現し、この種の名前衝突を `node --test` の範囲内で機械的に検知できるようにした。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PB = require('../promo-banners.js');
const BE = require('../big-events.js');

test('PROMO_LEAD_DAYSは14である(社長了承・2026-09-02。巻き戻り検知用)', () => {
  assert.strictEqual(PB.PROMO_LEAD_DAYS, 14);
});

test('promoShowFrom()は初日のちょうど14日前を返す', () => {
  assert.strictEqual(PB.promoShowFrom(['2026-09-05']), '2026-08-22');
});

test('visiblePromoBanners(): 掲載開始日ちょうど(初日−14日)は含まれる', () => {
  const promos = [{ id: 'fx', days: ['2026-09-05'] }];
  assert.deepStrictEqual(PB.visiblePromoBanners('2026-08-22', promos).map(p => p.id), ['fx']);
});

test('visiblePromoBanners(): 掲載開始日の前日(初日−15日)はまだ含まれない', () => {
  const promos = [{ id: 'fx', days: ['2026-09-05'] }];
  assert.deepStrictEqual(PB.visiblePromoBanners('2026-08-21', promos).map(p => p.id), []);
});

test('visiblePromoBanners(): 掲載終了日(最終日+1)は含まれ、その翌日は含まれない(big-events.jsのeventShowUntilと同じ式)', () => {
  const promos = [{ id: 'fx', days: ['2026-09-05'] }];
  assert.deepStrictEqual(PB.visiblePromoBanners('2026-09-06', promos).map(p => p.id), ['fx']);
  assert.deepStrictEqual(PB.visiblePromoBanners('2026-09-07', promos).map(p => p.id), []);
});

test('本番のPROMO_BANNERS: DreaMグランドオープンの掲載期間は2026-08-22〜2026-09-06(社長指示どおり)', () => {
  const dream = PB.PROMO_BANNERS.find(p => p.id === 'dream-grandopen-2026');
  assert.ok(dream, 'PROMO_BANNERSにdream-grandopen-2026が見つからない');
  assert.strictEqual(PB.promoShowFrom(dream.days), '2026-08-22');
  assert.strictEqual(BE.eventShowUntil(dream.days), '2026-09-06');
});

test('本番のPROMO_BANNERS: 2026-09-02時点でdream-grandopen-2026が掲載ウィンドウに入る', () => {
  const ids = PB.visiblePromoBanners('2026-09-02').map(p => p.id);
  assert.ok(ids.includes('dream-grandopen-2026'), `2026-09-02の表示対象に含まれていない(実際: ${JSON.stringify(ids)})`);
});

test('本番のPROMO_BANNERS: dream-grandopen-2026は9/7には掲載ウィンドウから外れる', () => {
  const ids = PB.visiblePromoBanners('2026-09-07').map(p => p.id);
  assert.ok(!ids.includes('dream-grandopen-2026'), `2026-09-07になっても表示対象に残っている(実際: ${JSON.stringify(ids)})`);
});

test('本番のPROMO_BANNERS: 各エントリが href(実ページへのリンク)と label(カルーセルのaria-labelで使う)を持つ', () => {
  PB.PROMO_BANNERS.forEach(p => {
    assert.ok(p.href && p.href.startsWith('/'), `${p.id}: href が /events/... の形になっていない`);
    assert.ok(p.label, `${p.id}: label が無い(index.htmlのec-dotsのaria-labelで使うため必須)`);
  });
});

// ============================================================
// ブラウザの<script>共有スコープを再現した回帰テスト(2026-09-02の本番障害の再発防止)
// ============================================================
test('★ブラウザでの読み込み順(big-events.js → promo-banners.js)を再現してもSyntaxErrorにならない', () => {
  const bigEventsSrc = fs.readFileSync(path.join(__dirname, '..', 'big-events.js'), 'utf8');
  const promoBannersSrc = fs.readFileSync(path.join(__dirname, '..', 'promo-banners.js'), 'utf8');

  // vm.createContext + 複数の vm.Script.runInContext() は、ブラウザが複数の非module<script>タグを
  // 同じページ内の共有グローバル字句スコープで順に評価するのと同じ状況を再現できる
  // (CommonJSのrequire()と違い、ファイルをまたいでも const/let の再宣言が衝突する)。
  // module/require を渡さないことで、各ファイル冒頭の「Node実行時だけrequireする」分岐を
  // 素通りさせ、ブラウザ相当の経路(素の識別子をそのまま参照する側)を通す。
  const ctx = vm.createContext({ console, module: undefined, require: undefined });

  assert.doesNotThrow(() => {
    new vm.Script(bigEventsSrc, { filename: 'big-events.js' }).runInContext(ctx);
  }, 'big-events.js 自体が読み込めない(このテストの前提が壊れている)');

  assert.doesNotThrow(() => {
    new vm.Script(promoBannersSrc, { filename: 'promo-banners.js' }).runInContext(ctx);
  }, 'promo-banners.js が big-events.js と同じ名前の変数を再宣言し、ブラウザでSyntaxErrorになっている'
    + '(promo-banners.js冒頭の「2026-09-02の本番障害・再発防止」コメントを参照)');

  // 単に例外が出ないだけでなく、visiblePromoBanners が実際にブラウザ相当の経路
  // (bare identifier 経由。_BE は null になっているはず)で正しく動くところまで確認する。
  // ★ vm の別コンテキストで作られた配列は、そのままだと Array.isArray は真でも「別レルムの
  //   Arrayコンストラクタ」から生まれたオブジェクトになり、assert.deepStrictEqual が
  //   「構造は同じだが reference-equal ではない」で落ちる(内容の食い違いではない)。
  //   JSON往復でこのプロセス(現在のレルム)のプレーンな配列に変換してから比較する。
  const result = JSON.parse(JSON.stringify(new vm.Script(
    'typeof visiblePromoBanners === "function" ? visiblePromoBanners("2026-09-02").map(p => p.id) : null'
  ).runInContext(ctx)));
  assert.deepStrictEqual(result, ['dream-grandopen-2026']);
});
