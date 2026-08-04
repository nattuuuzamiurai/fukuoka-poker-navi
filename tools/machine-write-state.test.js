'use strict';
/**
 * machine-write-state.test.js — 「機械が最後に書いた値」の控えと所有判定のテスト。
 *
 * 【この機能は平常時なにもしないので、片方向だけ固定すると壊れていても気づけない】
 * 「守る」側だけを固定すると、**何もかも守る実装(=自動化が完全に死ぬ)がテストを全部通る**。
 * そこで守る/守らないの【両方向】を固定し、判定を潰す変異でどちらかが必ず落ちるようにする。
 *
 *   判定を「常に人のもの」に潰す → 「触っていない項目は更新される」系が落ちる
 *   判定を「常に機械のもの」に潰す → 「人が直した項目は守られる」系が落ちる
 *
 * ★テスト5と6は対で置いてある(seed 規則)。6が無いと、seed の条件を緩める変更が
 *   手入力572件を静かに機械のものに化けさせる。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('./machine-write-state');

const WL_SEED = { source: 'auto', idPrefix: 'wl-' };

/** Waitinglist取込みが書く形の行。 */
const autoRow = (over = {}) => ({
  id: 'wl-01ABC',
  venueId: 'v3',
  name: 'm WTB Turbo',
  date: '2099-09-12',
  start: '19:00',
  buyin: 3000,
  addon: null,
  stack: 20000,
  guarantee: null,
  reentry: true,
  prize: null,
  tags: ['ターボ'],
  source: 'auto',
  verified: false,
  ...over,
});

/** 人が admin.html で入れた行。id は手書き、source は 'semi'。 */
const handRow = (over = {}) => ({
  id: 'kq0804',
  venueId: 'v20',
  name: 'マンデートナメ',
  date: '2099-09-12',
  start: '19:00',
  buyin: 2000,
  addon: null,
  stack: 0,
  guarantee: null,
  reentry: false,
  prize: null,
  tags: [],
  source: 'semi',
  verified: false,
  lowConfidence: true,
  ...over,
});

// ---------- 1. 人が直した項目は守られる ----------

test('1: 控えと食い違う項目は「人が直した項目」として挙がる', () => {
  const record = autoRow();
  const current = autoRow({ name: 'm WTB ターボ' });
  assert.deepEqual(S.humanEditedFields(current, record), ['name']);
});

test('1: 人が直した項目だけが候補行に戻り、他の項目は機械の値のまま', () => {
  const record = autoRow();
  const current = autoRow({ name: 'm WTB ターボ' });
  // 機械の新しい読み取り: 名前は元のまま、開始時刻が20:00に変わった
  const candidate = autoRow({ start: '20:00' });
  const fields = S.humanEditedFields(current, record);
  const out = S.preserveHumanFields(candidate, current, fields);

  assert.equal(out.name, 'm WTB ターボ', '人が直した大会名は守られること');
  assert.equal(out.start, '20:00', '★人が触っていない開始時刻は機械の新しい値で更新されること');
});

// ---------- 2. 人が触っていない項目は更新される(逆方向) ----------
// これが無いと「何もかも守る」実装がテストを通る。

test('2: 誰も触っていない行は、守るべき項目が1つも挙がらない', () => {
  const record = autoRow();
  const current = autoRow(); // 控えと完全一致
  assert.deepEqual(S.humanEditedFields(current, record), []);
});

test('2: 守るべき項目が無ければ候補行がそのまま通る(自動化が止まらない)', () => {
  const record = autoRow();
  const current = autoRow();
  const candidate = autoRow({ start: '20:00', buyin: 4000, name: '新しい名前' });
  const out = S.preserveHumanFields(candidate, current, S.humanEditedFields(current, record));
  assert.deepEqual(out, candidate, '1項目も戻さず、機械の新しい値がそのまま入ること');
});

// ---------- 3. 任意フィールドの付け外しも「人が直した」に数える ----------

test('3: 人が ⚠(lowConfidence) を外したことも食い違いとして拾う', () => {
  const record = handRow(); // lowConfidence: true が控えにある
  const current = handRow();
  delete current.lowConfidence; // 人が外した
  assert.deepEqual(S.humanEditedFields(current, record), ['lowConfidence']);

  const candidate = handRow(); // 機械はまた lowConfidence: true を付けようとする
  const out = S.preserveHumanFields(candidate, current, ['lowConfidence']);
  assert.ok(!('lowConfidence' in out), '人が外したキーは、機械が付け直さないこと');
});

test('3: 人が pinnedTags を足したことも食い違いとして拾う', () => {
  const record = autoRow();
  const current = autoRow({ pinnedTags: ['ディープ'] });
  assert.deepEqual(S.humanEditedFields(current, record), ['pinnedTags']);
});

// ---------- 4. 報告の並び順に社長の優先順位が出る ----------

test('4: 守った項目は 名前 → 参加費 → 開始時刻 の順に並ぶ(賞金は後ろ)', () => {
  const sorted = S.sortFieldsForReport(['prize', 'guarantee', 'start', 'buyin', 'name']);
  assert.deepEqual(sorted, ['name', 'buyin', 'start', 'guarantee', 'prize']);
});

test('4: 未知の項目は末尾に回る(名前順)', () => {
  assert.deepEqual(S.sortFieldsForReport(['zzz', 'name', 'aaa']), ['name', 'aaa', 'zzz']);
});

// ---------- 5. seed: 状態ファイル導入前の機械の行は引き継ぐ ----------

test('5: 記録が無くても wl- + source:auto なら機械のものとして扱う(1回だけ)', () => {
  const o = S.ownership(autoRow(), null, WL_SEED);
  assert.equal(o.owned, true, '稼働中の取込みが凍結しないこと');
  assert.equal(o.seeded, true);
  assert.deepEqual(o.humanFields, [], '引き継いだ行は「人が直した項目」を持たない');
});

test('5: 記録があれば seed は関係なく、記録との突き合わせが優先される', () => {
  const record = autoRow();
  const o = S.ownership(autoRow({ name: '人が直した' }), record, WL_SEED);
  assert.equal(o.owned, true);
  assert.equal(o.seeded, false);
  assert.deepEqual(o.humanFields, ['name']);
});

// ---------- 6. seed を広げると手入力が壊れる。それを構造的に止める ----------
// ★5とは必ず対で維持すること。6が無いと「seed の条件を緩める」変更が
//   手書きid + semi の572件を機械のものに化けさせ、静かに上書きする。

test('6: 手書きid + source:semi は、記録が無ければ絶対に機械のものにならない', () => {
  const o = S.ownership(handRow(), null, WL_SEED);
  assert.equal(o.owned, false, '人の行として扱われること');
});

test('6: ig-(Instagram監視)の行も、記録が無ければ人のものとして扱う', () => {
  const row = handRow({ id: 'ig-v18-2099-09-12-1900-deep', venueId: 'v18' });
  assert.equal(S.ownership(row, null, WL_SEED).owned, false);
  assert.equal(S.ownership(row, null, null).owned, false, 'seed 指定が無い取込みでも同じ');
});

test("6: seed に source:'semi' を渡したら例外にする(手入力と同じ source のため)", () => {
  assert.throws(() => S.assertSeedSpec({ source: 'semi', idPrefix: 'ig-' }), /source は 'auto'/);
  assert.throws(() => S.assertSeedSpec({ source: 'auto' }), /idPrefix/);
  assert.equal(S.assertSeedSpec(null), null);
  assert.deepEqual(S.assertSeedSpec(WL_SEED), WL_SEED);
});

test('6: id の名前空間が違えば、source:auto でも機械のものにならない', () => {
  const o = S.ownership(autoRow({ id: 'cc0804n' }), null, WL_SEED);
  assert.equal(o.owned, false, 'wl- で始まらない auto 行は引き継がない');
});

// ---------- 7. 状態ファイルが壊れても人の行は守られる ----------

test('7: 状態ファイルが無い/壊れていても例外を投げず、空として返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mws-'));
  try {
    const missing = S.readState(path.join(dir, 'nope.json'));
    assert.deepEqual(missing.entries, {});
    assert.equal(missing.missing, true);

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ これはJSONではない');
    const r = S.readState(broken);
    assert.deepEqual(r.entries, {});
    assert.equal(r.broken, true, '壊れていることが呼び出し側に伝わること(ログに出せる)');

    const noEntries = path.join(dir, 'noentries.json');
    fs.writeFileSync(noEntries, '{"version":1}');
    assert.equal(S.readState(noEntries).broken, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7: 記録が空でも、人の行は守られる側に倒れる(縮退の向き)', () => {
  assert.equal(S.ownership(handRow(), undefined, WL_SEED).owned, false);
  assert.equal(S.ownership(handRow(), null, null).owned, false);
});

// ---------- 8. 状態ファイルの書き出し ----------

test('8: 未来日ぶんだけ残し、過去日と data.js から消えた行は刈る', () => {
  const prev = {
    'wl-past': autoRow({ id: 'wl-past', date: '2020-01-01' }),
    'wl-gone': autoRow({ id: 'wl-gone', date: '2099-09-13' }),
    'wl-other-store': autoRow({ id: 'wl-other-store', venueId: 'v19', date: '2099-09-14' }),
  };
  const written = { 'wl-new': autoRow({ id: 'wl-new', date: '2099-09-15' }) };
  const next = S.buildNextEntries(prev, written, {
    today: '2099-09-01',
    replacedVenueIds: ['v3'],
    liveIds: new Set(['wl-new', 'wl-other-store']),
  });
  assert.ok(!next['wl-past'], '過去日は刈る');
  assert.ok(!next['wl-gone'], 'data.js から消えた行は刈る');
  assert.ok(next['wl-new'], '今回書いた行は残る');
  assert.ok(next['wl-other-store'], '★取得に失敗してスキップした店の記録は消さない');
});

test('8: 内容が同じなら書き込まない(無意味な日次コミットを増やさない)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mws-'));
  const p = path.join(dir, 'state.json');
  try {
    assert.equal(S.writeState(p, { a: autoRow() }, { writtenBy: 'x' }), true, '初回は書く');
    assert.equal(S.writeState(p, { a: autoRow() }, { writtenBy: 'x' }), false, '同じ内容なら書かない');
    assert.equal(S.writeState(p, { a: autoRow({ start: '20:00' }) }, { writtenBy: 'x' }), true);

    // dry-run は書かないが「ズレている」ことは返す
    const before = fs.readFileSync(p, 'utf8');
    assert.equal(S.writeState(p, { a: autoRow() }, { writtenBy: 'x', dryRun: true }), true);
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'dry-run では1バイトも書かない');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('8: キー順は id 昇順に固定する(並びの揺れで毎日全体が差分にならない)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mws-'));
  const p1 = path.join(dir, 'a.json');
  const p2 = path.join(dir, 'b.json');
  try {
    S.writeState(p1, { b: autoRow({ id: 'b' }), a: autoRow({ id: 'a' }) }, {});
    S.writeState(p2, { a: autoRow({ id: 'a' }), b: autoRow({ id: 'b' }) }, {});
    assert.equal(fs.readFileSync(p1, 'utf8'), fs.readFileSync(p2, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 9. 書き込み直前の突き合わせ(カウンタを参照しない検査) ----------

test('9: 機械のものでない行が書き換えられたら、突き合わせが検出する', () => {
  const before = [handRow(), autoRow()];
  const isOwned = (t) => t.source === 'auto';

  assert.equal(S.findUnownedRowChange(before, [handRow(), autoRow({ start: '20:00' })], isOwned), null,
    '機械の行が変わるのは正常');

  const changed = S.findUnownedRowChange(before, [handRow({ name: '機械が上書きした' }), autoRow()], isOwned);
  assert.match(String(changed), /書き換えられています/);

  const removed = S.findUnownedRowChange(before, [autoRow()], isOwned);
  assert.match(String(removed), /消えています/);
});

test('9: 人が直した項目が上書きされたら、突き合わせが検出する', () => {
  const record = autoRow();
  const current = autoRow({ name: '人が直した' });
  const recordOf = (t) => (t.id === record.id ? record : null);

  // 人の値が残っている → 問題なし
  assert.equal(S.findHumanFieldChange([current], [autoRow({ name: '人が直した', start: '20:00' })], recordOf), null);

  // 人の値が機械の値に戻された → 検出
  const bad = S.findHumanFieldChange([current], [autoRow()], recordOf);
  assert.match(String(bad), /人が直した項目が書き換えられています/);
  assert.match(String(bad), /項目=name/);

  // 行ごと消えた場合はここでは見ない(供給元から消えた = stats.removed の担当)
  assert.equal(S.findHumanFieldChange([current], [], recordOf), null);
});

test('9: 突き合わせはカウンタを一切参照しない(引数が before/after/控えだけ)', () => {
  // 引数の数と名前で構造的に固定する。stats を渡す形に変えたら、この検査は
  // 「マージ側の集計が正しい」という前提に依存し始め、集計を潰す変異で共倒れになる。
  assert.equal(S.findUnownedRowChange.length, 3);
  assert.equal(S.findHumanFieldChange.length, 3);
});
