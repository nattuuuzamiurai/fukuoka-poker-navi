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
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
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
