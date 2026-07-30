'use strict';

/**
 * validate-data.js のテスト。
 *   実行: node tools/validate-data.test.js
 *
 * CLI をそのまま子プロセスで動かして、終了コードと【当番が読むメッセージ】の中身を見る。
 * 「落ちること」だけでなく「不正値と該当トーナメント(venueId/id/name)が出ること」まで検査するのは、
 * 落ちた当番が data.js のどこを直せばいいかを即座に特定できることが要件だから。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'validate-data.js');

/** 正常な data.js を作る(件数の下限 500 を超えるよう埋める) */
function fixture(extraTournaments = [], count = 520) {
  const tournaments = [];
  for (let i = 0; i < count; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String((i % 12) + 1).padStart(2, '0');
    tournaments.push({
      id: `t${i}`,
      venueId: 'v3',
      name: `テスト大会${i}`,
      date: `2026-${month}-${day}`,
      start: '19:00',
      buyin: 1000,
      tags: [],
      source: 'auto',
      verified: false,
    });
  }
  return tournaments.concat(extraTournaments);
}

function writeRepo(tournaments, { raw } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-data-'));
  const body = raw !== undefined
    ? raw
    : `const VENUES = [{ "id": "v3", "slug": "m-holdem-nakasu", "name": "m HOLD'EM 中洲" }];\n` +
      `const TOURNAMENTS = ${JSON.stringify(tournaments, null, 2)};\n` +
      `const AREAS = [];\nconst RECURRING = [];\n` +
      `if (typeof module !== 'undefined') { module.exports = { VENUES, TOURNAMENTS, AREAS, RECURRING }; }\n`;
  fs.writeFileSync(path.join(dir, 'data.js'), body);
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [CLI, dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('正常な data.js は通る', () => {
  const r = run(writeRepo(fixture()));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /OK: TOURNAMENTS 520件/);
});

test('ゼロ埋めされていない日付(2026-9-5)で落ち、値と該当トーナメントが出る', () => {
  const bad = { id: 'ig-v40-1', venueId: 'v40', name: 'マンデートナメ', date: '2026-9-5', source: 'semi' };
  const r = run(writeRepo(fixture([bad])));
  assert.equal(r.code, 1);
  assert.match(r.err, /2026-9-5/);
  assert.match(r.err, /venueId=v40/);
  assert.match(r.err, /id=ig-v40-1/);
  assert.match(r.err, /name=マンデートナメ/);
});

test('年の無い日付(9\\/5)で落ちる', () => {
  const bad = { id: 'ig-v20-2', venueId: 'v20', name: '9月スケジュール', date: '9/5', source: 'semi' };
  const r = run(writeRepo(fixture([bad])));
  assert.equal(r.code, 1);
  assert.match(r.err, /"9\/5"/);
  assert.match(r.err, /venueId=v20/);
});

test('ISO日時形式(2026-07-01T00:00:00Z)で落ちる', () => {
  const bad = { id: 'ig-v18-3', venueId: 'v18', name: 'ナイトトナメ', date: '2026-07-01T00:00:00Z', source: 'semi' };
  const r = run(writeRepo(fixture([bad])));
  assert.equal(r.code, 1);
  assert.match(r.err, /2026-07-01T00:00:00Z/);
  assert.match(r.err, /id=ig-v18-3/);
});

test('date が無い/空でも落ちる(undefined がそのまま通らない)', () => {
  const r1 = run(writeRepo(fixture([{ id: 'x1', venueId: 'v21', name: '日付なし' }])));
  assert.equal(r1.code, 1);
  assert.match(r1.err, /id=x1/);
  const r2 = run(writeRepo(fixture([{ id: 'x2', venueId: 'v21', name: '空文字', date: '' }])));
  assert.equal(r2.code, 1);
  assert.match(r2.err, /id=x2/);
});

// ISO_DATE の ^ $ アンカーが効いていることの直接確認。
// アンカーを外しても他のテスト(9/5・ISO日時など)は isRealDate 側の NaN で偶然通ってしまい、
// 全緑のままアンカーだけ壊せてしまう。前後に空白が混じった値だけがそれを検出できる
// (' 2026-07-01'.split('-') は Number(' 2026') === 2026 となり、isRealDate は通してしまう)。
test('前後に空白が混じった日付( 2026-07-01 )で落ちる(ISO_DATEのアンカーが効いていること)', () => {
  const head = { id: 'sp1', venueId: 'v40', name: '先頭に空白', date: ' 2026-07-01', source: 'semi' };
  const r1 = run(writeRepo(fixture([head])));
  assert.equal(r1.code, 1);
  assert.match(r1.err, /id=sp1/);

  const tail = { id: 'sp2', venueId: 'v40', name: '末尾に空白', date: '2026-07-01 ', source: 'semi' };
  const r2 = run(writeRepo(fixture([tail])));
  assert.equal(r2.code, 1);
  assert.match(r2.err, /id=sp2/);
});

test('書式は合っているが存在しない日付(2026-02-31)で落ちる', () => {
  const bad = { id: 'x3', venueId: 'v34', name: '2月31日の大会', date: '2026-02-31', source: 'semi' };
  const r = run(writeRepo(fixture([bad])));
  assert.equal(r.code, 1);
  assert.match(r.err, /存在しない日付: "2026-02-31"/);
  assert.match(r.err, /id=x3/);
});

test('日付が1件でも不正なら、他が全部正しくても落ちる(部分的な通過をしない)', () => {
  const r = run(writeRepo(fixture([{ id: 'x4', venueId: 'v35', name: '1件だけ不正', date: '2026-9-5' }], 1000)));
  assert.equal(r.code, 1);
});

test('id重複で落ち、重複したidが出る', () => {
  const dup = { id: 't0', venueId: 'v40', name: '重複コピー', date: '2026-08-01' };
  const r = run(writeRepo(fixture([dup])));
  assert.equal(r.code, 1);
  assert.match(r.err, /id が重複/);
  assert.match(r.err, /"t0"/);
});

test('件数が下限(500)を割ると落ちる', () => {
  const r = run(writeRepo(fixture([], 499)));
  assert.equal(r.code, 1);
  assert.match(r.err, /TOURNAMENTS件数が異常: 499件/);
});

test('構文が壊れた data.js で落ちる(require より前に検出する)', () => {
  const r = run(writeRepo(null, { raw: 'const TOURNAMENTS = [ { id: "a", ;\n' }));
  assert.equal(r.code, 1);
  assert.match(r.err, /構文が壊れています/);
});

test('module.exports が無い data.js で落ちる', () => {
  const r = run(writeRepo(null, { raw: 'const TOURNAMENTS = [];\n' }));
  assert.equal(r.code, 1);
  assert.match(r.err, /TOURNAMENTS が配列として取り出せません/);
});

test('リポジトリのパスを渡さないと落ちる', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /リポジトリのパスを指定してください/);
});

test('不正が多数あっても一覧は MAX_LIST(20) 件で打ち切られ、残りは件数で分かる', () => {
  const many = [];
  for (let i = 0; i < 25; i++) many.push({ id: `bad${i}`, venueId: 'v40', name: `不正${i}`, date: '2026-9-5' });
  const r = run(writeRepo(fixture(many)));
  assert.equal(r.code, 1);
  assert.match(r.err, /: 25件/);
  assert.match(r.err, /ほか 5 件/);
  // 要約行だけを見ると打ち切り自体を外しても通ってしまうので、実際に並んだ行数を数える。
  assert.equal((r.err.match(/想定外の値/g) || []).length, 20, '一覧は20件で打ち切られること');
});

// 当番が最初に読む文面。Instagram監視で落ちた行はリポジトリの data.js に無い(ランナー上の
// 作業コピーにしか存在せず破棄される)ため、「data.js を検索して直す」だけの案内だと詰む。
test('修正案内に「Instagram監視経路では data.js に無い」旨と、直す対象が書かれている', () => {
  const bad = { id: 'ig-v40-9', venueId: 'v40', name: '案内文の確認', date: '2026-9-5', source: 'semi' };
  const r = run(writeRepo(fixture([bad])));
  assert.equal(r.code, 1);
  assert.match(r.err, /Instagram監視のジョブ/);
  assert.match(r.err, /リポジトリの data\.js を検索しても見つかりません/);
  assert.match(r.err, /tools\/monitor-instagram-apify\.js/);
  assert.match(r.err, /apify-monitor-state\.json/);
});

// ---------- 共有する判定関数(抽出側 = 層2 が require して使うもの) ----------

const { dateProblem, extractedRowProblem } = require('./validate-data');

test('require しても検査は走らない(CLI起動時だけ main が動く)', () => {
  // ここまで require できている時点で exit(1) していない = 副作用が無いことの確認
  assert.equal(typeof dateProblem, 'function');
  assert.equal(typeof extractedRowProblem, 'function');
});

test('dateProblem: 書式違反と存在しない日付を区別する', () => {
  assert.equal(dateProblem('2026-07-01'), null);
  assert.equal(dateProblem('2026-9-5'), 'format');
  assert.equal(dateProblem('9/5'), 'format');
  assert.equal(dateProblem('2026-07-01T00:00:00Z'), 'format');
  assert.equal(dateProblem(' 2026-07-01'), 'format');
  assert.equal(dateProblem(undefined), 'format');
  assert.equal(dateProblem('2026-02-31'), 'calendar');
  assert.equal(dateProblem('2026-13-01'), 'calendar');
});

test('extractedRowProblem: 取り込んでよい行は null、駄目な行は理由を返す', () => {
  assert.equal(extractedRowProblem({ date: '2026-09-05', name: 'マンデー' }), null);
  assert.match(extractedRowProblem({ date: '2026-9-5', name: 'マンデー' }), /YYYY-MM-DD/);
  assert.match(extractedRowProblem({ date: '2026-02-31', name: 'マンデー' }), /存在しない日付/);
  assert.match(extractedRowProblem({ date: '2026-09-05', name: '  ' }), /name が空/);
  assert.match(extractedRowProblem({ name: 'マンデー' }), /date が空/);
  assert.match(extractedRowProblem(null), /オブジェクトではない/);
  assert.match(extractedRowProblem('2026-09-05'), /オブジェクトではない/);
});
