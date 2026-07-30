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

test('不正が多数あっても一覧は打ち切られ、件数が分かる', () => {
  const many = [];
  for (let i = 0; i < 25; i++) many.push({ id: `bad${i}`, venueId: 'v40', name: `不正${i}`, date: '2026-9-5' });
  const r = run(writeRepo(fixture(many)));
  assert.equal(r.code, 1);
  assert.match(r.err, /: 25件/);
  assert.match(r.err, /ほか 5 件/);
});
