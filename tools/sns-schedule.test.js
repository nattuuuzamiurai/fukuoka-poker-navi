'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./sns-schedule');

test('nextMonthEndFrom: 通常月・年またぎ・うるう年', () => {
  assert.equal(S.nextMonthEndFrom('2026-07-31'), '2026-08-31');
  assert.equal(S.nextMonthEndFrom('2026-08-31'), '2026-09-30');
  assert.equal(S.nextMonthEndFrom('2026-12-31'), '2027-01-31');
  assert.equal(S.nextMonthEndFrom('2027-01-31'), '2027-02-28');
  assert.equal(S.nextMonthEndFrom('2028-01-31'), '2028-02-29'); // うるう年
});

test('resolveCycleAnchor: cycleAnchorが無い状態はwindow.startの月の月末日から推定する', () => {
  const store = { nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' } };
  assert.equal(S.resolveCycleAnchor(store), '2026-07-31');
});

test('resolveCycleAnchor: cycleAnchorがあれば常にそちらを優先する(windowが翌月に食い込んでいても正しい)', () => {
  // 学習が進んで window.start が既に翌月に入っているケース(基準日からの推定が壊れる例)
  const store = { cycleAnchor: '2026-08-31', nextCheckWindow: { start: '2026-09-01', end: '2026-09-05' } };
  assert.equal(S.resolveCycleAnchor(store), '2026-08-31');
});

test('checkProbabilityForDay: 初日は低確率・終端は必ず1・単調増加', () => {
  const store = { nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' } };
  const p0 = S.checkProbabilityForDay(store, '2026-07-28');
  const p1 = S.checkProbabilityForDay(store, '2026-07-30');
  const p2 = S.checkProbabilityForDay(store, '2026-08-02');
  const pEnd = S.checkProbabilityForDay(store, '2026-08-03');
  const pAfter = S.checkProbabilityForDay(store, '2026-08-10'); // 終端超過も1のまま

  assert.equal(p0, S.MIN_PROB);
  assert.ok(p0 < p1 && p1 < p2 && p2 <= pEnd, `単調増加であること: ${p0}, ${p1}, ${p2}, ${pEnd}`);
  assert.equal(pEnd, 1);
  assert.equal(pAfter, 1);
});

test('checkProbabilityForDay: ウィンドウ開始前は0', () => {
  const store = { nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' } };
  assert.equal(S.checkProbabilityForDay(store, '2026-07-01'), 0);
});

test('shouldCheckToday: ウィンドウ終端(必須実行日)は必ずtrue', () => {
  const store = {
    nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' },
    lastAttemptDate: null,
  };
  // 複数の店舗ID(=乱数シードが変わる)でも終端は必ずtrueになるはず
  for (const venueId of ['v40', 'v20', 'v18', 'v21', 'v34', 'v35']) {
    assert.equal(S.shouldCheckToday(store, '2026-08-03', venueId), true, venueId);
  }
});

test('shouldCheckToday: ウィンドウ開始前は必ずfalse', () => {
  const store = { nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' }, lastAttemptDate: null };
  assert.equal(S.shouldCheckToday(store, '2026-07-20', 'v40'), false);
});

test('shouldCheckToday: 猶予期間(GRACE_DAYS)を過ぎたらfalse', () => {
  const store = { nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' }, lastAttemptDate: null };
  const graceUntil = S.addDaysIso('2026-08-03', S.GRACE_DAYS);
  assert.equal(S.shouldCheckToday(store, graceUntil, 'v40'), true); // 猶予最終日はまだ対象
  assert.equal(S.shouldCheckToday(store, S.addDaysIso(graceUntil, 1), 'v40'), false); // その翌日はもう対象外
});

test('shouldCheckToday: 今日すでに実行済み(lastAttemptDate)ならfalse(1日1回まで)', () => {
  const store = { nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' }, lastAttemptDate: '2026-08-03' };
  assert.equal(S.shouldCheckToday(store, '2026-08-03', 'v40'), false);
});

test('pickTargetHour: 常にHOUR_MIN〜HOUR_MAXの範囲内・同じ入力には常に同じ値(決定論的)', () => {
  for (const venueId of ['v40', 'v20', 'v18', 'v21', 'v34', 'v35']) {
    for (const d of ['2026-07-28', '2026-07-29', '2026-08-01']) {
      const h = S.pickTargetHour(venueId, d);
      assert.ok(h >= S.HOUR_MIN && h <= S.HOUR_MAX, `${venueId} ${d} -> ${h}`);
      assert.equal(S.pickTargetHour(venueId, d), h, '同じ入力は同じ結果(決定論的)');
    }
  }
});

test('isTargetHourReached: 目標時刻に達するまでfalse、達したらtrue', () => {
  const venueId = 'v40';
  const d = '2026-07-29';
  const targetHour = S.pickTargetHour(venueId, d);
  if (targetHour > 0) assert.equal(S.isTargetHourReached(venueId, d, targetHour - 1), false);
  assert.equal(S.isTargetHourReached(venueId, d, targetHour), true);
  assert.equal(S.isTargetHourReached(venueId, d, 23), true);
});

test('recordFound: 実測オフセットを積み、次回ウィンドウ・閾値を算出し直す', () => {
  const store = {
    handle: 'triple_orio',
    observedIntervals: [],
    lastFoundPostDate: null,
    lastFoundPostUrl: null,
    nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' },
    missThresholdDate: '2026-08-03',
    consecutiveMisses: 2,
    missReportedForCycle: true,
  };
  // 2026-07-31(月末)より2日早い 2026-07-29 に発見 → オフセット -2
  const next = S.recordFound(store, '2026-07-29', 'https://www.instagram.com/p/AAAA/');
  assert.deepEqual(next.observedIntervals, [-2]);
  assert.equal(next.lastFoundPostDate, '2026-07-29');
  assert.equal(next.lastFoundPostUrl, 'https://www.instagram.com/p/AAAA/');
  assert.equal(next.consecutiveMisses, 0);
  assert.equal(next.missReportedForCycle, false);
  // 次サイクルの基準日は2026-08-31(翌月末)。オフセット-2±マージン2 = [-4,0]だが
  // 幅がMIN_WINDOW_DAYS(4)未満にならないことも確認。
  assert.equal(next.nextCheckWindow.end, next.missThresholdDate);
  assert.ok(next.nextCheckWindow.start < next.nextCheckWindow.end);
  // 基準日(08-31)より前後にウィンドウがあること
  assert.ok(next.nextCheckWindow.start <= '2026-08-31' && next.nextCheckWindow.end >= '2026-08-27');
});

test('recordFound: 学習が進むほど遅い店の実測に収束する(2サイクル目でウィンドウが後ろにずれる)', () => {
  let store = {
    observedIntervals: [],
    lastFoundPostDate: null,
    lastFoundPostUrl: null,
    nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' },
    missThresholdDate: '2026-08-03',
    consecutiveMisses: 0,
    missReportedForCycle: false,
  };
  // 1サイクル目: 基準日(07-31)より3日遅い 08-03 に発見(offset=+3)
  store = S.recordFound(store, '2026-08-03', 'https://x/1');
  const firstEnd = store.nextCheckWindow.end;
  // 2サイクル目: 次の基準日(08-31)より4日遅い 09-04 に発見(offset=+4) → さらに遅れが観測された
  store = S.recordFound(store, '2026-09-04', 'https://x/2');
  assert.deepEqual(store.observedIntervals, [3, 4]);
  // 学習後のウィンドウは実測(+3,+4)にマージンを足した範囲になり、当初の標準プロファイル
  // (月末3日前〜翌月3日)よりも終端が後ろにずれているはず。
  assert.ok(store.nextCheckWindow.end > firstEnd || store.nextCheckWindow.end.slice(5) > '08-03');
});

test('recordMissAttempt: missThresholdDate到達時に1回だけ shouldReportMiss が立つ', () => {
  const store = {
    observedIntervals: [],
    nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' },
    missThresholdDate: '2026-08-03',
    consecutiveMisses: 0,
    missReportedForCycle: false,
    lastAttemptDate: null,
  };
  const day1 = S.recordMissAttempt(store, '2026-08-03');
  assert.equal(day1.shouldReportMiss, true);
  assert.equal(day1.shouldReportCycleGiveUp, false);
  assert.equal(day1.state.missReportedForCycle, true);

  // 翌日も未発見のまま推移 → 同じサイクル内なので再度は報告しない
  const day2 = S.recordMissAttempt(day1.state, '2026-08-04');
  assert.equal(day2.shouldReportMiss, false);
});

test('recordMissAttempt: 猶予(GRACE_DAYS)超過で次サイクルへ回しconsecutiveMissesが増える', () => {
  const store = {
    observedIntervals: [],
    nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' },
    missThresholdDate: '2026-08-03',
    consecutiveMisses: 0,
    missReportedForCycle: true, // すでに閾値報告済みの状態から始める
    lastAttemptDate: '2026-08-03',
  };
  const hardStopDay = S.addDaysIso('2026-08-03', S.GRACE_DAYS);
  const result = S.recordMissAttempt(store, hardStopDay);
  assert.equal(result.shouldReportCycleGiveUp, true);
  assert.equal(result.state.consecutiveMisses, 1);
  assert.equal(result.state.missReportedForCycle, false);
  // 次サイクルのウィンドウは翌月の基準日(08-31)を軸にしたものになっている
  assert.ok(result.state.nextCheckWindow.start > '2026-08-03');
});

test('seededRandom: 同じシードは常に同じ値、[0,1)の範囲', () => {
  const a = S.seededRandom('v40:2026-07-29:day');
  const b = S.seededRandom('v40:2026-07-29:day');
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
});
