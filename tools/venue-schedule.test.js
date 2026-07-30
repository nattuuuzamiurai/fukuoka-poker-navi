#!/usr/bin/env node
/**
 * venue-schedule.test.js — 焼き込む期間の決め方(monthRange / venueRange / hasSchedule)のテスト
 *
 * 実行: node tools/venue-schedule.test.js
 *
 * 【なぜこのファイルがあるか】
 *   静的ページに焼き込む期間は、間違えても画面を見て気づけない
 *   (閲覧時にブラウザ側が描き直すので、閲覧者にはいつも最新が出る。壊れるのは
 *    JSを実行しないクローラが見る静的HTMLだけ)。目視で守れない性質なので機械で押さえる。
 *
 * 【何を守っているか】
 *   1. 月末の丸め(うるう年・30日/31日の月・年跨ぎ)
 *   2. 期間が【店舗別】であること = 他店にデータを足しても他店の期間が動かないこと
 *   3. 定期開催しか無い店・日程が1件も無い店の扱い
 *   4. 実行日に依存しないこと(同じ入力なら何度呼んでも同じ結果)
 *
 * 境界ケースの一覧は品質管理部が PR #15 の検証で使ったものを取り込んでいる。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { monthRange, venueRange, hasSchedule, SCHED } = require('./venue-schedule.js');

// ---- 1. monthRange の境界 ----
// [名前, 入力, 期待値] 。期待値 null は「期間を決められない」。
const MONTH_CASES = [
  ['空配列',                     [],                                 null],
  ['1件だけ',                    ['2026-07-15'],                     ['2026-07-01', '2026-07-31', '2026年7月']],
  ['1件・月初',                  ['2026-07-01'],                     ['2026-07-01', '2026-07-31', '2026年7月']],
  ['1件・月末',                  ['2026-07-31'],                     ['2026-07-01', '2026-07-31', '2026年7月']],
  ['2月(平年)',                  ['2027-02-10'],                     ['2027-02-01', '2027-02-28', '2027年2月']],
  ['2月(うるう年)',              ['2028-02-10'],                     ['2028-02-01', '2028-02-29', '2028年2月']],
  ['年跨ぎ',                     ['2026-11-20', '2027-01-05'],       ['2026-11-01', '2027-01-31', '2026年11月〜2027年1月']],
  ['年跨ぎ(12月→1月)',           ['2026-12-31', '2027-01-01'],       ['2026-12-01', '2027-01-31', '2026年12月〜2027年1月']],
  ['同じ月に2件',                ['2026-08-02', '2026-08-30'],       ['2026-08-01', '2026-08-31', '2026年8月']],
  ['30日の月',                   ['2026-09-05'],                     ['2026-09-01', '2026-09-30', '2026年9月']],
  ['未ソートの入力',             ['2026-09-05', '2026-07-20', '2026-08-01'], ['2026-07-01', '2026-09-30', '2026年7月〜9月']],
  ['複数年にまたがる',           ['2025-03-04', '2027-11-30'],       ['2025-03-01', '2027-11-30', '2025年3月〜2027年11月']],
  ['同じ日付が重複',             ['2026-07-07', '2026-07-07'],       ['2026-07-01', '2026-07-31', '2026年7月']],
  ['null/空文字が混ざる',        [null, '2026-07-07', undefined, ''], ['2026-07-01', '2026-07-31', '2026年7月']],
  ['全部 null',                  [null, undefined, ''],              null],
  ['12月だけ',                   ['2026-12-05'],                     ['2026-12-01', '2026-12-31', '2026年12月']],
  ['1月だけ',                    ['2026-01-05'],                     ['2026-01-01', '2026-01-31', '2026年1月']],
  ['同一年の12月→12月',          ['2026-12-01', '2026-12-31'],       ['2026-12-01', '2026-12-31', '2026年12月']],
];

test('monthRange: 月末の丸め・ラベル・null の扱い', () => {
  for (const [name, input, want] of MONTH_CASES) {
    const got = monthRange(input);
    if (want === null) {
      assert.strictEqual(got, null, `${name}: null を期待`);
      continue;
    }
    assert.deepStrictEqual([got.from, got.to, got.label], want, name);
  }
});

test('monthRange: ゼロ埋めされていない日付は黙って通さない', () => {
  // '2026-9-5' は辞書順で '2026-10-01' より後ろに来るため、素通しすると
  // from > to の逆転した期間と「2026年10月〜9月」という見出しが静かに出来上がる。
  assert.throws(() => monthRange(['2026-9-5', '2026-10-01']), /ゼロ埋め/);
  assert.throws(() => monthRange(['2026/07/01']), /ゼロ埋め/);
  assert.throws(() => monthRange(['2026-07-01T00:00:00Z']), /ゼロ埋め/);
});

// ---- 2〜4. venueRange / hasSchedule ----
// 実データではなく、このテスト専用の最小データで確かめる(data.js の中身が変わっても落ちないように)。
const T = (venueId, date, start = '19:00') => ({ venueId, date, start, name: `${venueId} ${date}`, tags: [] });
const R = (venueId, weekday) => ({ venueId, weekday, name: `${venueId} 毎週${weekday}`, start: '20:00', buyin: 3000 });

const TOURNAMENTS = [
  T('vA', '2026-07-10'), T('vA', '2026-08-20'),   // 日付つきのみ
  T('vC', '2026-09-01'),                          // 日付つき + 定期
];
const RECURRING = [
  R('vB', 3),                                     // 定期のみ
  R('vC', 5),
];
// vD … 日付つきも定期も無い店

test('venueRange: 日付つきトーナメントがある店は自店の範囲', () => {
  const r = venueRange(TOURNAMENTS, RECURRING, 'vA');
  assert.deepStrictEqual([r.from, r.to, r.label, r.recurringOnly],
    ['2026-07-01', '2026-08-31', '2026年7月〜8月', false]);
});

test('venueRange: 他店にデータを足しても自店の範囲は動かない（店舗別であることの本体）', () => {
  const before = venueRange(TOURNAMENTS, RECURRING, 'vA');
  // 別の店に、ずっと未来とずっと過去の日程を足す
  const more = [...TOURNAMENTS, T('vC', '2029-12-31'), T('vC', '2020-01-01')];
  const after = venueRange(more, RECURRING, 'vA');
  assert.deepStrictEqual(before, after);
});

test('venueRange: 定期開催しか無い店は代表期間（サイト全体の最古月の1ヶ月）', () => {
  const r = venueRange(TOURNAMENTS, RECURRING, 'vB');
  assert.deepStrictEqual([r.from, r.to, r.label, r.recurringOnly],
    ['2026-07-01', '2026-07-31', '2026年7月', true]);
  // 1ヶ月あれば毎週の定期開催が1回以上出る = ページが空にならない
  assert.ok(SCHED.vpRows(TOURNAMENTS, RECURRING, 'vB', r.from, r.to).length >= 4);
});

test('venueRange: 定期のみの店の期間は、他店に未来の日程が増えても動かない', () => {
  const before = venueRange(TOURNAMENTS, RECURRING, 'vB');
  const more = [...TOURNAMENTS, T('vA', '2027-03-14')];   // 来年の大会が1件載った
  const after = venueRange(more, RECURRING, 'vB');
  assert.deepStrictEqual(before, after);
});

test('venueRange: 定期のみの店の期間は、サイト全体の最古月が変わると動く（依存の明示）', () => {
  // 「他店の変更が波及しない」は定期のみの店では構造的な保証ではない。
  // 日次の自動取込が過去日を作らない/消さないので【実際には動かない】だけで、
  // 人が最古月より前の日程を入れれば動く。この依存関係を忘れないための1件。
  const older = [...TOURNAMENTS, T('vA', '2026-05-03')];
  const r = venueRange(older, RECURRING, 'vB');
  assert.deepStrictEqual([r.from, r.to, r.label], ['2026-05-01', '2026-05-31', '2026年5月']);
});

test('venueRange: 日付つきと定期の両方を持つ店は、自店の日付の範囲を使う', () => {
  const r = venueRange(TOURNAMENTS, RECURRING, 'vC');
  assert.deepStrictEqual([r.from, r.to, r.label, r.recurringOnly],
    ['2026-09-01', '2026-09-30', '2026年9月', false]);
});

test('venueRange: 日付つきも定期も無い店は null（期間の見出しを出さない）', () => {
  assert.strictEqual(venueRange(TOURNAMENTS, RECURRING, 'vD'), null);
});

test('venueRange: TOURNAMENTS が空のとき、定期のみの店は明示的に落ちる', () => {
  assert.throws(() => venueRange([], RECURRING, 'vB'), /TOURNAMENTS が空です/);
  // 定期も無い店は落ちずに null(焼き込むものが無いだけなので)
  assert.strictEqual(venueRange([], RECURRING, 'vD'), null);
});

test('hasSchedule: sitemap 掲載判定は「その店に行があるか」と一致する', () => {
  assert.strictEqual(hasSchedule(TOURNAMENTS, RECURRING, 'vA'), true);
  assert.strictEqual(hasSchedule(TOURNAMENTS, RECURRING, 'vB'), true);  // 定期のみでも掲載対象
  assert.strictEqual(hasSchedule(TOURNAMENTS, RECURRING, 'vC'), true);
  assert.strictEqual(hasSchedule(TOURNAMENTS, RECURRING, 'vD'), false); // 0行の店は外す
});

test('実行日に依存しない（同じ入力なら何度呼んでも同じ結果）', () => {
  for (const id of ['vA', 'vB', 'vC', 'vD']) {
    assert.deepStrictEqual(venueRange(TOURNAMENTS, RECURRING, id), venueRange(TOURNAMENTS, RECURRING, id));
  }
});

// ---- 実データでの現状確認(件数の思い込みを固定しないよう、性質だけを見る) ----
test('data.js の全店で、期間が決まる店にはかならず掲載行がある', () => {
  const D = require(path.join(__dirname, '..', 'data.js'));
  for (const v of D.VENUES) {
    const r = venueRange(D.TOURNAMENTS, D.RECURRING, v.id);
    if (!r) {
      assert.strictEqual(hasSchedule(D.TOURNAMENTS, D.RECURRING, v.id), false, `${v.id} ${v.name}`);
      continue;
    }
    assert.ok(r.from <= r.to, `${v.id}: from > to になっている (${r.from} > ${r.to})`);
    assert.ok(SCHED.vpRows(D.TOURNAMENTS, D.RECURRING, v.id, r.from, r.to).length > 0,
      `${v.id} ${v.name}: 期間が決まっているのに掲載行が0`);
  }
});
