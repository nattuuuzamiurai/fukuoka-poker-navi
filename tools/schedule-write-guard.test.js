/**
 * tools/schedule-write-guard.js のテスト。
 *
 * 【この1本が2つのツールを覆っている】Instagram監視(monitor-instagram-apify.js)と
 * Waitinglist取込み(import-waitinglist.js)は、同じ検査をそれぞれ自前で持っていたため、
 * まったく同じ欠陥が2箇所に同居していた。検査を1つのモジュールに寄せたので、
 * ここを固めれば両方が固まる。
 *
 * 【なぜ実データの形が要るのか】旧テストが全部緑のまま実データで落ちた理由は、
 * フィクスチャが「1店 = 1ブロック」しか持っていなかったこと。
 * 実際の data.js は月末の一括登録で **1店が2ブロックに分かれる**(2026-08-05 時点で11店)。
 * ここのフィクスチャは必ずその形を含めること。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('./schedule-write-guard');
const merge = require('./tournament-merge');

const TODAY = '2026-08-05';
const TARGETS = ['v18', 'v20', 'v35'];

const row = (venueId, date, name, extra) => ({
  id: `${venueId}-${date}-${name}`,
  venueId,
  name,
  date,
  start: '',
  buyin: null,
  source: 'semi',
  ...(extra || {}),
});

/**
 * 実データの配置を縮めたフィクスチャ。
 *
 *   v18(7月ブロック) → v20(7月ブロック) → v99(対象外) → v35(1ブロックのみ)
 *   → v18(8月ブロック) → v20(8月ブロック)
 *
 * v18 と v20 が **2ブロックに分かれ、その間に別の対象店(v35)の過去日行が挟まる**。
 * これが 2026-08-04 の実データ試験で書き込みを止めた配置そのもの。
 */
function fixture() {
  return [
    // v18 の7月ブロック(すべて過去日)
    row('v18', '2026-07-01', 'A'),
    row('v18', '2026-07-20', 'B'),
    // v20 の7月ブロック(すべて過去日)
    row('v20', '2026-07-02', 'C'),
    // 対象外の店
    row('v99', '2026-07-03', 'X'),
    row('v99', '2026-09-01', 'Y'),
    // v35 は1ブロックだけ(過去日を持つ = v18/v20 の2ブロック目に追い越される側)
    row('v35', '2026-07-04', 'D'),
    row('v35', '2026-08-02', 'E'),
    // v18 の8月ブロック(8/01・8/03 が過去日、8/20 は未来日)
    row('v18', '2026-08-01', 'F'),
    row('v18', '2026-08-03', 'G'),
    row('v18', '2026-08-20', 'H'),
    // v20 の8月ブロック(8/04 が過去日)
    row('v20', '2026-08-04', 'I'),
    row('v20', '2026-08-25', 'J'),
  ];
}

const check = (before, after, targets) =>
  guard.checkNothingElseChanged(before, after, { targets: targets || TARGETS, today: TODAY });

// ============================================================
// 本題: 店の行が分かれていても、まとめ直しを「過去日が変化した」と誤検知しない
// ============================================================

test('店が2ブロックに分かれた実データ配置で、mergeStore のまとめ直しを誤検知しない(本件の回帰テスト)', () => {
  const before = fixture();
  let after = before;
  // 【★抽出0行で呼ぶ★】並びの崩れは取込みの中身に一切依存しない構造上の挙動なので、
  //   scraped を空にしておけば「Visionが何を返したか」に左右されないテストになる。
  for (const venueId of TARGETS) {
    after = merge.mergeStore(after, venueId, [], TODAY, {}).next;
  }

  const v = check(before, after);
  assert.equal(v.ok, true, '中身が1件も変わっていないのに中止してはいけない');
  assert.equal(v.reason, null);

  // 過去日の集合と中身は完全に一致している
  const pastIds = (l) => l.filter((t) => TARGETS.includes(t.venueId) && t.date < TODAY).map((t) => t.id).sort();
  assert.deepEqual(pastIds(after), pastIds(before), '過去日の id は1件も増減してはいけない');

  // 【★並びは実際に変わっている★】「誤検知しなくなった」だけでなく
  //   「変わったことを数えて報告している」ことまで固定する。
  assert.equal(v.reordered, 3, 'v18 の 8/01・8/03 と v20 の 8/04 が前に出るので3行');
  assert.deepEqual(v.reorderedByVenue, { v18: 2, v20: 1 });
  assert.deepEqual(v.splitVenues, { v18: 2, v20: 2 }, '分かれていた店を理由として報告すること');
});

test('一度まとめ直したあとは並びが動かない(店ごとに一度きりであることの固定)', () => {
  let arr = fixture();
  for (const venueId of TARGETS) arr = merge.mergeStore(arr, venueId, [], TODAY, {}).next;
  const once = arr;
  for (const venueId of TARGETS) arr = merge.mergeStore(arr, venueId, [], TODAY, {}).next;

  const v = check(once, arr);
  assert.equal(v.ok, true);
  // 【★0であることを厳密に固定する★】「常に非0を返す」変異をここで殺す。
  assert.equal(v.reordered, 0, '2回目は1行も動かない');
  assert.deepEqual(v.reorderedByVenue, {});
});

test('店が最初から連続していれば、まとめ直しても並びは動かない', () => {
  const before = [
    row('v18', '2026-07-01', 'A'),
    row('v18', '2026-08-01', 'F'),
    row('v18', '2026-08-20', 'H'),
    row('v35', '2026-07-04', 'D'),
  ];
  const after = merge.mergeStore(before, 'v18', [], TODAY, {}).next;
  const v = check(before, after);
  assert.equal(v.ok, true);
  assert.equal(v.reordered, 0);
  assert.deepEqual(v.splitVenues, {}, '分かれていないので理由も出ない');
});

// ============================================================
// 緩めていないこと: 増える・消える・中身が変わるは今までどおり中止
// ============================================================

test('過去日のエントリが消えたら中止する', () => {
  const before = fixture();
  const after = before.filter((t) => t.id !== 'v18-2026-08-01-F');
  const v = check(before, after);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'past-removed');
  assert.match(v.message, /消えています/);
  assert.match(v.message, /v18-2026-08-01-F/, 'どの行かを message に出すこと');
});

test('過去日のエントリが増えたら中止する(どの行が増えたかまで出す)', () => {
  const before = fixture();
  const after = [...before, row('v18', '2026-08-02', 'NEW')];
  const v = check(before, after);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'past-added');
  // 【★どの行かまで固定する★】件数の一致検査だけでも「増えた」ことは検出できるので、
  //   reason だけを見ていると「増えた行を名指しする経路」を消す変異が素通りする
  //   (実際 2026-08-05 の変異試験で素通りした)。message に id が出ることまで見る。
  assert.match(v.message, /v18-2026-08-02-NEW/);
});

test('idの集合が同じでも、過去日の行が重複していれば中止する(件数の一致検査)', () => {
  // 「消えた」でも「増えた」でも「中身が変わった」でもない、件数だけが合わない形。
  // 同じ行を2度書いてしまうバグはこれでしか捕まらない。
  const before = fixture();
  const dup = before.find((t) => t.id === 'v18-2026-08-01-F');
  const after = [...before, { ...dup }];
  const v = check(before, after);
  assert.equal(v.ok, false);
  assert.match(v.message, /過去日のエントリ数が 8件 → 9件 に変わっています/);
});

test('過去日のエントリの中身が1項目でも変わったら中止する', () => {
  const before = fixture();
  const after = before.map((t) => (t.id === 'v18-2026-07-01-A' ? { ...t, name: '書き換えられた' } : t));
  const v = check(before, after);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'past-modified');
  assert.match(v.message, /中身が1件変化/);
});

test('過去日のエントリを in-place で書き換えるバグを検知する(左辺がディープコピーであること)', () => {
  // 呼び出し側が before のディープコピーを渡している前提の検査。
  // 同じ要素オブジェクトを共有したまま in-place で書き換えると素通りするので、
  // 各ツールは必ずスナップショットを左辺に渡すこと(monitor / import-waitinglist ともに実施済み)。
  const live = fixture();
  const snapshot = JSON.parse(JSON.stringify(live));
  live.find((t) => t.id === 'v18-2026-07-01-A').name = 'in-place で壊した';
  const v = check(snapshot, live);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'past-modified');
});

test('対象外の店は【順序も含めて】厳密に見る(こちらは緩めていない)', () => {
  const before = fixture();
  // 対象外 v99 の2行を入れ替えるだけ。中身は1件も変わっていない。
  const after = before.slice();
  const i = after.findIndex((t) => t.id === 'v99-2026-07-03-X');
  [after[i], after[i + 1]] = [after[i + 1], after[i]];
  const v = check(before, after);
  assert.equal(v.ok, false, '対象外の店は並びが変わっただけでも中止する');
  assert.equal(v.reason, 'others');
});

test('対象外の店の中身が変わったら中止する / ラベルは呼び出し側が決める', () => {
  const before = fixture();
  const after = before.map((t) => (t.venueId === 'v99' ? { ...t, name: 'z' } : t));
  assert.match(check(before, after).message, /対象外の店舗のデータが変化/);
  const v = guard.checkNothingElseChanged(before, after, {
    targets: TARGETS,
    today: TODAY,
    othersLabel: '取得に成功した店舗以外',
  });
  assert.match(v.message, /取得に成功した店舗以外のデータが変化/);
});

test('未来日は自由に変えてよい(この検査の対象外)', () => {
  const before = fixture();
  const after = before
    .filter((t) => t.id !== 'v18-2026-08-20-H')
    .concat([row('v18', '2026-08-21', 'NEW'), row('v20', '2026-08-26', 'NEW2')]);
  const v = check(before, after);
  assert.equal(v.ok, true);
});

// ============================================================
// 数え方そのもの
// ============================================================

test('countReordered は「ずれた添字」ではなく「動かした行」を数える', () => {
  // 1行を先頭へ動かすと添字は4つずれるが、動いた行は1行。
  const before = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const after = [{ id: 'e' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.equal(guard.countReordered(before, after).moved, 1);
  assert.equal(guard.countReordered(before, before).moved, 0);
  // 完全な逆順は「1行だけ残して全部動かす」
  assert.equal(guard.countReordered(before, [...before].reverse()).moved, 4);
});

test('blockCounts は data.js 内で店が何ブロックに分かれているかを数える', () => {
  const counts = guard.blockCounts(fixture());
  assert.equal(counts.get('v18'), 2);
  assert.equal(counts.get('v20'), 2);
  assert.equal(counts.get('v35'), 1);
  assert.equal(counts.get('v99'), 1);
});

// ============================================================
// 報告の出力(鳴らない警報にしない / 常に鳴る警報にもしない)
// ============================================================

test('並びが変わっていない実行でも必ず1行出す(鳴らない警報にしない)', () => {
  const lines = guard.formatReorderReport(
    { ok: true, reordered: 0, reorderedByVenue: {}, splitVenues: {} },
    '[t]'
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /過去日の並び: 変化なし\(0行\)/);
});

test('並びが変わった実行は、行数・内訳・理由・影響を出す', () => {
  const text = guard
    .formatReorderReport(
      { ok: true, reordered: 3, reorderedByVenue: { v18: 2, v20: 1 }, splitVenues: { v18: 2, v20: 2 } },
      '[t]'
    )
    .join('\n');
  assert.match(text, /3行の位置が変わりました/);
  assert.match(text, /中身・件数は変わっていません/);
  assert.match(text, /v18 2行/);
  assert.match(text, /v20 1行/);
  assert.match(text, /v18\(2ブロック\)/);
  assert.match(text, /一度きり/);
  // ★README と同じ線を引く: 「表示に影響しない」と言い切らない
  assert.match(text, /同じ日・同じ開始時刻の行どうしの上下は入れ替わることがあります/);
});

test('中止する判定では並びの報告を出さない(中止理由と混ざらないように)', () => {
  assert.deepEqual(guard.formatReorderReport({ ok: false, reordered: 0 }, '[t]'), []);
});

// ============================================================
// 実データに対する検査
//   フィクスチャだけを見ていたせいで、この欠陥は実データで初めて表に出た。
//   ここでは data.js そのものを読み、テストの前提が現実とずれていないかを見張る。
// ============================================================

const path = require('node:path');
const REAL_DATA_JS = path.join(__dirname, '..', 'data.js');

test('★実データには「1店が2ブロックに分かれている」配置が実在する(フィクスチャの前提の担保)', () => {
  // この事実が失われたら、上のフィクスチャは「もう起きない形」を試していることになる。
  // そのときは【テストを消す】のではなく、なぜ連続になったのか(全体を並べ直したのか)を
  // 確かめてから判断すること。
  const arr = merge.readDataJs(REAL_DATA_JS).arr;
  const split = [...guard.blockCounts(arr)].filter(([, n]) => n > 1);
  assert.ok(
    split.length > 0,
    'data.js の全店が連続になっている。フィクスチャの前提が実データと合っているか確認すること'
  );
});

test('★Waitinglist取込みの現行対象(v3 / v19)では並びが1行も動かない(稼働中経路の挙動が変わらないこと)', () => {
  // この修正は「検査を緩める」変更なので、本番を止める方向のリスクは無い。
  // それでも【毎朝06:23に動いている経路】なので、現行の対象店では
  // 修正前後で観測できる違いが1つも無いことを固定しておく。
  //
  // 【★このテストが落ちたら、検査を緩める前に理由を確かめること★】
  //   落ちる条件は「v3 か v19 が data.js 内で2ブロックに分かれた」ことだけである
  //   (実測: どちらかを2ブロックに割ると実際に落ちる)。
  //   それは【コードのバグではなく前提が変わった合図】で、多くの場合は月末の一括登録で
  //   翌月分が別の場所に追記された結果である。そのとき起きるのは
  //   「その店の初回実行で data.js の差分が数百行になる(中身は1行も変わらない)」であり、
  //   これは想定内の挙動(リスク台帳 #18)。
  //   ★やるべきことは (a) 実行ログの「過去日の並び: N行」を確認し
  //     (b) 期待値をその数に更新すること。【assert を消して通すことではない】。
  const arr = merge.readDataJs(REAL_DATA_JS).arr;
  const today = '2026-08-05';
  const targets = ['v3', 'v19'];
  let after = arr;
  for (const v of targets) after = merge.mergeStore(after, v, [], today, {}).next;

  const v = guard.checkNothingElseChanged(JSON.parse(JSON.stringify(arr)), after, { targets, today });
  assert.equal(v.ok, true);
  assert.equal(v.reordered, 0, 'v3 / v19 はどちらも1ブロックなので並べ直しは起きない');
  assert.deepEqual(v.splitVenues, {});
});
