#!/usr/bin/env node
/**
 * recurring-dedupe.test.js — 「自動取込と重なった定期開催は出さない」判定のテスト
 *
 * 実行: node tools/recurring-dedupe.test.js
 *
 * 【なぜこのファイルがあるか】
 *   この間引きは【出力に何も現れないこと】で成功する。効いていても効いていなくても
 *   例外は出ないので、壊れても画面を見て気づけない。しかも壊れ方が2方向ある:
 *     - 効かない  … 同じ大会が2行に見える(差し戻しの原因そのもの)
 *     - 効きすぎる … 別の大会・別の曜日まで消える(こちらのほうが害が大きい)
 *   両方向を機械で押さえる。
 *
 * 【何を守っているか】
 *   1. 一致した行だけが消えること(曜日ごと全滅させない = レビュー部が名指しで禁じた実装)
 *   2. source:'auto' 以外は消さないこと(v33 の同時刻・別大会)
 *   3. 開始時刻が確定していない行は消さないこと(v35 の空文字どうし)
 *   4. 展開行が venueId を持たないと判定が空振りするので、その場合は落ちること
 *   5. 静的側(vpRows)とSPA側(index.html)が同じ1本のファイルを読んでいること
 *   6. 現在の data.js では1行も抑止しないこと(= このPRで公開中の内容が変わらないこと)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RD = require('../recurring-dedupe.js');
const { SCHED, venueRange } = require('./venue-schedule.js');

const REPO = path.join(__dirname, '..');

// 自動取込の1件
const A = (venueId, date, start, name, extra) =>
  Object.assign({ id: 'wl-' + venueId + date + start, venueId, date, start, name, source: 'auto' }, extra || {});
// 手入力/Instagram由来の1件
const S = (venueId, date, start, name) =>
  ({ id: 'sk-' + venueId + date + start, venueId, date, start, name, source: 'semi' });
// RECURRING を展開した1行(index.html / vpExpandRecurring と同じ形)
const R = (venueId, date, start, name) => ({ venueId, date, start, name, recurring: true });

test.beforeEach(() => RD.reset());

// ---- 1. 本題: 一致した行だけが消える ----

test('(date, start) が一致する source:auto があれば、その定期開催の行だけ消える', () => {
  const T = [A('v19', '2026-08-02', '16:10', '2000 Turbo')];
  const rows = [R('v19', '2026-08-02', '16:10', 'Turbo')];
  assert.deepStrictEqual(RD.filterExpanded(T, rows), []);
  assert.strictEqual(RD.summary().count, 1);
});

test('曜日ごと全滅させない: 取込が無い曜日の定期開催は残る（レビュー部が名指しで禁じた実装の再発防止）', () => {
  // v19 の実例。日曜Turbo・木曜FreezeOut にだけ取込があり、土曜DeepStack・月曜FreeRoll には無い。
  const T = [
    A('v19', '2026-08-02', '16:10', '2000 Turbo'),      // 日
    A('v19', '2026-08-06', '18:30', '3000 Freeze Out'), // 木
    A('v19', '2026-08-04', '18:30', 'FST Satellite')    // 火(定期なし)
  ];
  const rows = [
    R('v19', '2026-08-01', '16:10', 'Deep Stack'),  // 土 … 残る
    R('v19', '2026-08-02', '16:10', 'Turbo'),       // 日 … 消える
    R('v19', '2026-08-03', '18:10', 'Free Roll'),   // 月 … 残る
    R('v19', '2026-08-06', '18:30', 'Freeze Out'),  // 木 … 消える
    R('v19', '2026-08-08', '16:10', 'Deep Stack'),  // 土 … 残る
    R('v19', '2026-08-09', '16:10', 'Turbo')        // 日 … 取込が無い週なので残る
  ];
  const got = RD.filterExpanded(T, rows).map(r => r.date + ' ' + r.name);
  assert.deepStrictEqual(got, [
    '2026-08-01 Deep Stack', '2026-08-03 Free Roll', '2026-08-08 Deep Stack', '2026-08-09 Turbo'
  ]);
});

test('日付・時刻・店のどれか1つでも違えば消さない', () => {
  const T = [A('v19', '2026-08-02', '16:10', '2000 Turbo')];
  const cases = [
    ['別の日',   R('v19', '2026-08-09', '16:10', 'Turbo')],
    ['別の時刻', R('v19', '2026-08-02', '18:10', 'Turbo')],
    ['別の店',   R('v41', '2026-08-02', '16:10', 'Turbo')]
  ];
  for (const [name, row] of cases) {
    RD.reset();
    assert.strictEqual(RD.filterExpanded(T, [row]).length, 1, name);
    assert.strictEqual(RD.summary().count, 0, name);
  }
});

test('開始時刻のゼロ埋めの差は同じ時刻として扱う（"9:30" と "09:30"）', () => {
  assert.strictEqual(RD.normStart('9:30'), '09:30');
  assert.strictEqual(RD.normStart(' 09:30 '), '09:30');
  const T = [A('v19', '2026-08-02', '9:30', '朝トナメ')];
  assert.deepStrictEqual(RD.filterExpanded(T, [R('v19', '2026-08-02', '09:30', '朝')]), []);
});

// ---- 2. 誤爆しないこと ----

test('source:auto でない衝突は消さない（v33 2026-07-10 19:00 の実例）', () => {
  // 「FPC AJPC DAY1」(¥0, source:'semi') と 毎週金曜の「JOPT福岡サテライト」(¥4,000)。
  // 同じ時刻だが参加費が違う【別の大会】。ここを消すのは誤りなので、規則を広げないこと。
  const T = [S('v33', '2026-07-10', '19:00', 'FPC AJPC DAY1')];
  const rows = [R('v33', '2026-07-10', '19:00', 'JOPT福岡サテライト')];
  assert.deepStrictEqual(RD.filterExpanded(T, rows), rows);
  assert.strictEqual(RD.summary().count, 0);
});

test('開始時刻が空・不正なものは、たとえ auto でも消さない（v35 の空文字どうしの再発防止）', () => {
  for (const bad of ['', null, undefined, '未定', '19時', '1900']) {
    RD.reset();
    const T = [A('v35', '2026-07-04', bad, 'Super FREE ROLL')];
    const rows = [R('v35', '2026-07-04', bad, 'FSLCS DAY1 店舗代表決定戦')];
    assert.strictEqual(RD.filterExpanded(T, rows).length, 1, '開始時刻: ' + JSON.stringify(bad));
    assert.strictEqual(RD.normStart(bad), '');
  }
});

// ---- 3. 記録 ----

test('名前が食い違う場合はAPI版を残し、食い違いを記録に残す', () => {
  const T = [A('v19', '2026-08-02', '16:10', '2000 Turbo')];
  RD.filterExpanded(T, [R('v19', '2026-08-02', '16:10', 'Turbo')]);
  const s = RD.summary();
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.nameMismatch, 1);
  assert.deepStrictEqual(s.byVenue, { v19: 1 });
  assert.strictEqual(s.rows[0].autoName, '2000 Turbo');      // 残るのはAPI版
  assert.strictEqual(s.rows[0].recurringName, 'Turbo');      // 消したほうも残す
  assert.match(RD.detailLines()[0], /名前が違う/);
});

test('同じ行を何度描き直しても記録は増えない（SPAは月の切り替えごとに展開し直す）', () => {
  const T = [A('v19', '2026-08-02', '16:10', '2000 Turbo')];
  for (let i = 0; i < 5; i++) RD.filterExpanded(T, [R('v19', '2026-08-02', '16:10', 'Turbo')]);
  assert.strictEqual(RD.summary().count, 1);
});

// ---- 4. 空振りを黙って許さない ----

test('展開行に venueId が無いときは落ちる（判定が黙って空振りするのを防ぐ）', () => {
  const T = [A('v19', '2026-08-02', '16:10', '2000 Turbo')];
  assert.throws(() => RD.filterExpanded(T, [{ date: '2026-08-02', start: '16:10', name: 'Turbo' }]),
    /venueId/);
});

test('vpExpandRecurring の展開行は venueId を持つ（上の空振りを実際に踏まないこと）', () => {
  const RECURRING = [{ id: 'r1', venueId: 'vA', weekday: 0, name: '毎週日曜', start: '16:10', buyin: 2000 }];
  const rows = SCHED.vpRows([], RECURRING, 'vA', '2026-08-01', '2026-08-31');
  assert.ok(rows.length > 0);
  rows.forEach(r => assert.strictEqual(r.venueId, 'vA'));
});

// ---- 5. 判定が1本であること(2箇所に書き写されていないこと) ----

test('静的側もSPA側も recurring-dedupe.js を読んでいる', () => {
  const index = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.match(index, /<script src="recurring-dedupe\.js"><\/script>/,
    'index.html が recurring-dedupe.js を読み込んでいない');
  // 読み込みは data.js より後(判定が TOURNAMENTS を参照するため、順序自体は問わないが同じ<head>外に置く)
  assert.ok(index.indexOf('recurring-dedupe.js') < index.indexOf('function expandRecurring'),
    'recurring-dedupe.js の読み込みが expandRecurring より後ろにある');

  const gen = fs.readFileSync(path.join(REPO, 'tools', 'gen-venue-pages.js'), 'utf8');
  assert.match(gen, /<script src="\/recurring-dedupe\.js"><\/script>/,
    '店舗ページの生成物が recurring-dedupe.js を読み込んでいない');
});

test('判定の本体が2箇所に書き写されていない（index.html / venue-schedule.js は呼ぶだけ）', () => {
  for (const rel of ['index.html', 'tools/venue-schedule.js']) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    // 「source === 'auto'」の判定を持っているのは recurring-dedupe.js だけ。
    // 消費側がこれを書き始めたら、それは判定の写しが増え始めた合図。
    const hits = src.match(/source\s*===?\s*['"]auto['"]/g) || [];
    assert.strictEqual(hits.length, 0, rel + ' が source:auto の判定を自前で持っている');
  }
});

// ---- 6. 現在のデータでは何も変わらないこと ----

test('現在の data.js では1行も抑止しない（このPRで公開中の内容が変わらないことの担保）', () => {
  const D = require(path.join(REPO, 'data.js'));
  for (const v of D.VENUES) {
    const r = venueRange(D.TOURNAMENTS, D.RECURRING, v.id);
    if (r) SCHED.vpRows(D.TOURNAMENTS, D.RECURRING, v.id, r.from, r.to);
  }
  const s = RD.summary();
  assert.strictEqual(s.count, 0,
    '抑止が発生している(自動取込を有効にした店が増えたなら、この期待値ごと見直すこと): ' + RD.detailLines().join(' / '));
});

test('抑止しても掲載行が0になることはない（sitemap の掲載判定が壊れない）', () => {
  // 抑止する相手(source:'auto' の行)は必ず同じ日付なので、必ず同じ期間の中に残る。
  const T = [A('v19', '2026-08-02', '16:10', '2000 Turbo')];
  const RECURRING = [{ id: 'r1', venueId: 'v19', weekday: 0, name: 'Turbo', start: '16:10', buyin: 2000 }];
  const rows = SCHED.vpRows(T, RECURRING, 'v19', '2026-08-02', '2026-08-02');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, '2000 Turbo');
});

// ---- 7. auto-import-stores.json との照合(監査のみ。振る舞いは変えない) ----

test('auditAutoStores: 取込店リストに無い店の auto エントリを警告する', () => {
  const stores = { stores: [{ venueId: 'v3', label: "m HOLD'EM 中洲" }] };
  assert.deepStrictEqual(RD.auditAutoStores([A('v3', '2026-08-02', '16:10', 'x')], stores), []);
  const warn = RD.auditAutoStores([A('v3', '2026-08-02', '16:10', 'x'), A('v19', '2026-08-02', '16:10', 'y')], stores);
  assert.strictEqual(warn.length, 1);
  assert.match(warn[0], /^v19: /);
});

test('現在の data.js と auto-import-stores.json は食い違っていない', () => {
  const D = require(path.join(REPO, 'data.js'));
  const stores = JSON.parse(fs.readFileSync(path.join(REPO, 'auto-import-stores.json'), 'utf8'));
  assert.deepStrictEqual(RD.auditAutoStores(D.TOURNAMENTS, stores), []);
});
