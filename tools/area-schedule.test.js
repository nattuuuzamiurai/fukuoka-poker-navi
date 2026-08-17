#!/usr/bin/env node
/**
 * area-schedule.test.js — エリアページの「どのエリアに作るか」と日程表のテスト
 *
 * 実行: node tools/area-schedule.test.js
 *
 * 【なぜこのファイルがあるか】
 *   エリアページの壊れ方は、店舗ページと同じく画面を見ても気づけない。
 *   閲覧時はブラウザ側が data.js から描き直すので、静的HTML(=クローラが見るもの)だけが
 *   古い/空のまま残る。目視で守れないので機械で押さえる。
 *
 * 【何を守っているか】
 *   1. ページを作る条件(2店舗以上)と並び順。1店だけのエリアに作らないこと
 *   2. slug の欠け・重複を生成前に落とすこと(公開後のURL変更=被リンクの喪失を防ぐ)
 *   3. 行の束ね方: 複数店を日付→開始時刻→店名の順に並べ、どの行にも店名が付くこと
 *   4. 定期開催の間引き(自動取込と重複する行を出さない)が【店舗ページと同じ結果になる】こと
 *      … ここを別実装にすると、同じ大会がエリアページにだけ二重に出る
 *   5. 期間がそのエリアの店のデータだけで決まること(他エリアにデータを足しても動かない)
 *   6. 実行日に依存しないこと
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  AREA_SLUGS, MIN_VENUES_FOR_AREA_PAGE, AREA_SCHED,
  areaVenues, areaList, validateAreaSlugs, areaRange, hasAreaSchedule
} = require('./area-schedule.js');
const { SCHED } = require('./venue-schedule.js');

// ---- 共通のダミーデータ ----
const V = [
  { id: 'v1', name: 'アルファ', slug: 'alpha', area: '天神' },
  { id: 'v2', name: 'ブラボー', slug: 'bravo', area: '天神' },
  { id: 'v3', name: 'チャーリー', slug: 'charlie', area: '中洲' },
  { id: 'v4', name: 'デルタ', slug: 'delta', area: '中洲' },
  { id: 'v5', name: 'エコー', slug: 'echo', area: '博多' }   // 1店だけのエリア
];
const AREAS = ['天神', '中洲', '博多'];

// ---- 1. ページを作る条件と並び ----
test('エリアページは2店舗以上のエリアにだけ作る', () => {
  assert.deepStrictEqual(areaList(V, AREAS), ['天神', '中洲']);
  assert.strictEqual(MIN_VENUES_FOR_AREA_PAGE, 2);
});

test('並びは AREAS の順に従う', () => {
  assert.deepStrictEqual(areaList(V, ['中洲', '天神', '博多']), ['中洲', '天神']);
});

test('AREAS に無いエリアの店も落とさず末尾に足す', () => {
  const v = V.concat([
    { id: 'v6', name: 'フォックス', slug: 'fox', area: '久留米' },
    { id: 'v7', name: 'ゴルフ', slug: 'golf', area: '久留米' }
  ]);
  assert.deepStrictEqual(areaList(v, AREAS), ['天神', '中洲', '久留米']);
});

test('2店舗目が入った時点でページの対象になる', () => {
  const v = V.concat([{ id: 'v6', name: 'フォックス', slug: 'fox', area: '博多' }]);
  assert.ok(areaList(v, AREAS).includes('博多'));
});

test('areaVenues は data.js の順を保つ', () => {
  assert.deepStrictEqual(areaVenues(V, '天神').map(x => x.id), ['v1', 'v2']);
});

// ---- 2. slug の検査 ----
test('slug の無いエリアがページ対象になったら生成前に落とす', () => {
  const v = V.concat([
    { id: 'v6', name: 'フォックス', slug: 'fox', area: '未登録エリア' },
    { id: 'v7', name: 'ゴルフ', slug: 'golf', area: '未登録エリア' }
  ]);
  assert.throws(() => validateAreaSlugs(v, AREAS.concat(['未登録エリア'])), /未登録エリア/);
});

test('1店だけのエリアは slug が無くても落とさない（ページを作らないため）', () => {
  const v = V.concat([{ id: 'v6', name: 'フォックス', slug: 'fox', area: '未登録エリア' }]);
  assert.doesNotThrow(() => validateAreaSlugs(v, AREAS.concat(['未登録エリア'])));
});

test('実データのエリアには全て slug がある', () => {
  const DATA = require('../data.js');
  assert.doesNotThrow(() => validateAreaSlugs(DATA.VENUES, DATA.AREAS));
  areaList(DATA.VENUES, DATA.AREAS).forEach(a => {
    assert.ok(AREA_SLUGS[a], `${a} の slug が無い`);
    assert.match(AREA_SLUGS[a], /^[a-z0-9]+(-[a-z0-9]+)*$/, `${a} の slug "${AREA_SLUGS[a]}" が使えない形`);
  });
});

test('slug が重複していたら落とす', () => {
  // AREA_SLUGS は module 内の定数なので、重複検査そのものは実データで担保する。
  // ここでは「同じ slug を2エリアが持つ状態を作れない」ことを、現在の値で確認する。
  const slugs = Object.values(AREA_SLUGS);
  assert.strictEqual(new Set(slugs).size, slugs.length, 'AREA_SLUGS に重複がある');
});

// ---- 3. 行の束ね方 ----
const T = [
  { id: 't1', venueId: 'v1', name: '朝トナメ', date: '2026-08-10', start: '11:00', buyin: 3000, stack: 20000 },
  { id: 't2', venueId: 'v2', name: '夜トナメ', date: '2026-08-10', start: '19:00', buyin: 5000, stack: 30000 },
  { id: 't3', venueId: 'v1', name: '翌日トナメ', date: '2026-08-11', start: '19:00', buyin: 3000, stack: 20000 },
  { id: 't4', venueId: 'v3', name: '別エリア', date: '2026-08-10', start: '12:00', buyin: 3000, stack: 20000 }
];

// apRows の返り値は vm(別レルム)で作られた配列なので、そのまま .map すると
// できる配列も vm 側の Array.prototype を持ち、deepStrictEqual がプロトタイプ違いで落ちる。
// 中身の比較をしたいだけなので、Array.from でこちらのレルムの配列に写してから比べる。
const rowsOf = (rows, f) => Array.from(rows, f);

test('複数店の行を日付→開始時刻の順に束ね、どの行にも店名が付く', () => {
  const rows = AREA_SCHED.apRows(T, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31');
  assert.deepStrictEqual(rowsOf(rows, r => [r.date, r.start, r.venueName]), [
    ['2026-08-10', '11:00', 'アルファ'],
    ['2026-08-10', '19:00', 'ブラボー'],
    ['2026-08-11', '19:00', 'アルファ']
  ]);
  rows.forEach(r => assert.ok(r.venueSlug, '店舗ページへのリンク用 slug が無い'));
});

test('他エリアの店の行は混ざらない', () => {
  const rows = AREA_SCHED.apRows(T, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31');
  assert.ok(!rows.some(r => r.name === '別エリア'));
});

test('同じ日・同じ時刻なら店名で並びが固定される（実行のたびに変わらない）', () => {
  const t = [
    { id: 'a', venueId: 'v2', name: 'B店の大会', date: '2026-08-10', start: '19:00', buyin: 1000, stack: 1 },
    { id: 'b', venueId: 'v1', name: 'A店の大会', date: '2026-08-10', start: '19:00', buyin: 1000, stack: 1 }
  ];
  const once = AREA_SCHED.apRows(t, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31');
  const twice = AREA_SCHED.apRows(t, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31');
  assert.deepStrictEqual(rowsOf(once, r => r.venueName), ['アルファ', 'ブラボー']);
  assert.deepStrictEqual(rowsOf(once, r => r.venueName), rowsOf(twice, r => r.venueName));
});

// ---- 4. 定期開催の間引きが店舗ページと同じ結果になること ----
test('自動取込と重複する定期開催は、店舗ページと同じ基準で出さない', () => {
  // 月曜(2026-08-03)の19:00に、自動取込(source:'auto')と定期開催が同じ枠で存在する状態。
  const t = [{ id: 'auto1', venueId: 'v1', name: 'デイリー', date: '2026-08-03', start: '19:00',
               buyin: 3000, stack: 20000, source: 'auto' }];
  const r = [{ id: 'rec1', venueId: 'v1', weekday: 1, name: 'デイリー', start: '19:00',
               buyin: 3000, buyinStack: 20000, tags: [] }];
  const venueRows = SCHED.vpRows(t, r, 'v1', '2026-08-03', '2026-08-03');
  const areaRows = AREA_SCHED.apRows(t, r, areaVenues(V, '天神'), '2026-08-03', '2026-08-03');
  assert.strictEqual(areaRows.length, venueRows.length, 'エリアページだけ行数が違う（間引きの基準がズレている）');
  assert.strictEqual(areaRows.length, 1);
});

// ---- 5. 期間はそのエリアの店だけで決まる ----
test('期間はそのエリアの店の日付だけから決まる', () => {
  assert.deepStrictEqual(areaRange(T, areaVenues(V, '天神')), {
    from: '2026-08-01', to: '2026-08-31', label: '2026年8月'
  });
});

test('他エリアに遠い未来の大会を足しても、このエリアの期間は動かない', () => {
  const before = areaRange(T, areaVenues(V, '天神'));
  const t = T.concat([{ id: 'x', venueId: 'v3', name: '遠い先', date: '2027-03-01', start: '19:00', buyin: 1, stack: 1 }]);
  assert.deepStrictEqual(areaRange(t, areaVenues(V, '天神')), before);
});

test('日付つきトーナメントが無いエリアは期間なし・日程なし', () => {
  const venues = areaVenues(V, '中洲');
  const t = T.filter(x => x.venueId !== 'v3' && x.venueId !== 'v4');
  assert.strictEqual(areaRange(t, venues), null);
  assert.strictEqual(hasAreaSchedule(t, [], venues), false);
});

test('hasAreaSchedule は行が1件でもあれば true', () => {
  assert.strictEqual(hasAreaSchedule(T, [], areaVenues(V, '天神')), true);
});

// ---- 6. 表のHTML ----
test('表の各行に店舗ページへのリンクが入る', () => {
  const rows = AREA_SCHED.apRows(T, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31');
  const html = AREA_SCHED.apScheduleHtml(rows);
  assert.match(html, /href="\/venues\/alpha\/"/);
  assert.match(html, /href="\/venues\/bravo\/"/);
  assert.match(html, /8月10日（月）/);
});

test('0件なら「掲載している開催予定はありません」と出す（日程があると読める文を出さない）', () => {
  const html = AREA_SCHED.apScheduleHtml([]);
  assert.match(html, /掲載している開催予定はありません/);
  assert.ok(!/<table/.test(html));
});

test('店名・大会名はエスケープされる', () => {
  const v = [{ id: 'v9', name: '<script>x</script>', slug: 'xss', area: '天神' },
             { id: 'v8', name: 'ふつうの店', slug: 'normal', area: '天神' }];
  const t = [{ id: 'e1', venueId: 'v9', name: 'A&B "特別"', date: '2026-08-10', start: '19:00', buyin: 1000, stack: 1 }];
  const html = AREA_SCHED.apScheduleHtml(AREA_SCHED.apRows(t, [], v, '2026-08-01', '2026-08-31'));
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A&amp;B &quot;特別&quot;/);
});

// ---- 7. 実行日に依存しない ----
test('同じ入力なら何度呼んでも同じ結果（実行日に依存しない）', () => {
  const a = AREA_SCHED.apScheduleHtml(AREA_SCHED.apRows(T, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31'));
  const b = AREA_SCHED.apScheduleHtml(AREA_SCHED.apRows(T, [], areaVenues(V, '天神'), '2026-08-01', '2026-08-31'));
  assert.strictEqual(a, b);
});
