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
 *
 * 【2026-09-06 追記】掲載打ち切り(上限側)を「翌日いっぱい」→「翌日の朝6:00」に変更した際のテストを追加。
 *   visibleBigEvents(today, events) の第1引数は 'YYYY-MM-DD' 文字列だけでなく Date も受け付けるようになった
 *   (resolveNowAndToday参照)。時刻の境界(5:59/6:00/6:01)を検証するテストは Date を渡す。
 *   下の「掲載終了日(最終日+1)は含まれ…」という旧テストは変更していない
 *   (文字列だけを渡した場合はその日の00:00とみなす設計にしたため、旧テストの期待値は今回も成立する。
 *    big-events.js の resolveNowAndToday のコメント参照)。
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

// ============================================================
// 2026-09-06 仕様変更: 掲載打ち切り(上限側)を「翌日いっぱい」→「翌日 朝6:00」に短縮
// ============================================================
test('SHOW_CUTOFF_HOURは6である(社長指示・2026-09-06。巻き戻り検知用)', () => {
  assert.strictEqual(BE.SHOW_CUTOFF_HOUR, 6);
});

test('showCutoffInstant()は最終日の翌日06:00:00(ローカル時刻)を返す', () => {
  const cutoff = BE.showCutoffInstant(['2026-09-19', '2026-09-23']);
  assert.strictEqual(cutoff.getFullYear(), 2026);
  assert.strictEqual(cutoff.getMonth(), 8); // 0始まりなので9月=8
  assert.strictEqual(cutoff.getDate(), 24);
  assert.strictEqual(cutoff.getHours(), 6);
  assert.strictEqual(cutoff.getMinutes(), 0);
  assert.strictEqual(cutoff.getSeconds(), 0);
});

test('visibleBigEvents(): 会期当日(最終日)は時刻に関わらず終日表示される(変更なし)', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  assert.deepStrictEqual(
    BE.visibleBigEvents(new Date(2026, 8, 23, 0, 0, 0), events).map(e => e.id), ['fx']);
  assert.deepStrictEqual(
    BE.visibleBigEvents(new Date(2026, 8, 23, 23, 59, 59), events).map(e => e.id), ['fx']);
});

test('visibleBigEvents(): 最終日の翌日 05:59 はまだ表示される', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  assert.deepStrictEqual(
    BE.visibleBigEvents(new Date(2026, 8, 24, 5, 59, 59), events).map(e => e.id), ['fx']);
});

test('visibleBigEvents(): 最終日の翌日 06:00 ちょうどで非表示になる', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  assert.deepStrictEqual(
    BE.visibleBigEvents(new Date(2026, 8, 24, 6, 0, 0), events).map(e => e.id), []);
});

test('visibleBigEvents(): 最終日の翌日 06:01 も非表示のまま(日付が変わるまで待たない)', () => {
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  assert.deepStrictEqual(
    BE.visibleBigEvents(new Date(2026, 8, 24, 6, 1, 0), events).map(e => e.id), []);
});

test('visibleBigEvents(): 第1引数に日付文字列だけを渡した場合はその日の00:00とみなす(6:00より前なので表示される)', () => {
  // 最終日+1(掲載終了日)を文字列で渡す旧来の呼び方。00:00は6:00より前なので今回の仕様変更後も表示される
  // (=旧テスト「掲載終了日(最終日+1)は含まれ」との後方互換の根拠。resolveNowAndTodayのコメント参照)。
  const events = [{ id: 'fx', label: 'フィクスチャ', days: ['2026-09-19', '2026-09-23'] }];
  assert.deepStrictEqual(BE.visibleBigEvents('2026-09-24', events).map(e => e.id), ['fx']);
});
