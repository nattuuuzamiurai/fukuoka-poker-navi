#!/usr/bin/env node
/**
 * big-events.test.js — 大型イベントの掲載期間ルール(big-events.js)のテスト
 *
 * 実行: node tools/big-events.test.js (または node --test tools/*.test.js)
 *
 * 【なぜこのファイルがあるか】
 *   2026-09-01にBANNER_LEAD_DAYSを14→30に変更した際、big-events.js/index.htmlに残っていた
 *   「14日」表記のコメント3箇所を直し忘れ、品質管理部の指摘で差し戻しになった(PR #67)。
 *   コメントの書き換え漏れそのものは自動テストで防げないが、
 *   「BANNER_LEAD_DAYSの値」と「掲載ウィンドウの境界(30日前ちょうどで切り替わること)」を
 *   固定してテストしておけば、次に同じ定数を変えたときに【値そのものの変更漏れ・巻き戻り】は
 *   即座に赤くなる(コメントの整合性は引き続き人のレビューが必要)。
 *
 * 【実データ(BIG_EVENTS)を境界値の検証に使わない理由】
 *   FST 5.0の会期・登録内容は今後変わりうる(recurring-dedupe.test.jsと同じ考え方)。
 *   境界(ちょうど30日前/31日前)の検証は、テスト内で組み立てた固定の会期(days)を使い、
 *   本番のBIG_EVENTSレジストリが変わっても壊れないようにする。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const BE = require('../big-events.js');

test('BANNER_LEAD_DAYSは30である(2026-09-01に14→30へ変更。巻き戻り検知用)', () => {
  assert.strictEqual(BE.BANNER_LEAD_DAYS, 30);
});

test('eventShowFrom()は初日のちょうど30日前を返す', () => {
  assert.strictEqual(BE.eventShowFrom(['2026-09-19', '2026-09-23']), '2026-08-20');
});

test('eventShowUntil()は最終日の翌日を返す(BANNER_LEAD_DAYSの変更と無関係な既存仕様)', () => {
  assert.strictEqual(BE.eventShowUntil(['2026-09-19', '2026-09-23']), '2026-09-24');
});

test('visibleBigEvents(): 掲載開始日ちょうど(初日−30日)は含まれる', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  const ids = BE.visibleBigEvents('2026-08-20', events).map(e => e.id);
  assert.deepStrictEqual(ids, ['fx']);
});

test('visibleBigEvents(): 掲載開始日の前日(初日−31日)はまだ含まれない', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  const ids = BE.visibleBigEvents('2026-08-19', events).map(e => e.id);
  assert.deepStrictEqual(ids, []);
});

test('visibleBigEvents(): 掲載終了日(最終日+1)は含まれ、その翌日は含まれない', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  assert.deepStrictEqual(BE.visibleBigEvents('2026-09-24', events).map(e => e.id), ['fx']);
  assert.deepStrictEqual(BE.visibleBigEvents('2026-09-25', events).map(e => e.id), []);
});

test('本番のBIG_EVENTS: 2026-09-01時点でFST 5.0が掲載ウィンドウに入る(社長指示・30日化の意図どおり)', () => {
  const ids = BE.visibleBigEvents('2026-09-01').map(e => e.id);
  assert.ok(ids.includes('fst'), `2026-09-01の表示対象に'fst'が含まれていない(実際: ${JSON.stringify(ids)})`);
});
