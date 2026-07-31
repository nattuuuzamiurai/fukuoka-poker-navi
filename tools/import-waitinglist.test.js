'use strict';

/**
 * import-waitinglist.test.js — 【店舗単位のエラー隔離】のテスト
 *
 * 検証したいのは「1店の失敗が他店を巻き添えにしないこと」。これはスクリプト全体の
 * 制御フロー(取得ループ → マージ → 自己チェック → 書き込み → 終了コード)の性質なので、
 * 関数単体ではなく【実際にプロセスを起動して】確かめる。
 *
 * 本物のAPIは叩かない。`node -r <stub>` で global fetch を差し替えてから起動する。
 *
 * 【本物の data.js を触らないための仕掛け】スクリプトは書き込み先を
 * `path.join(__dirname, '..', 'data.js')` で決めている。そこで一時ディレクトリに
 *   <tmp>/tools/import-waitinglist.js   (コピー)
 *   <tmp>/data.js                       (テスト用の小さな中身)
 * を用意して、そのコピーを実行する。スクリプト側にテスト用の分岐を足さずに済む。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, 'import-waitinglist.js');

// 今日を基準にした日付(スクリプトは today 以降だけを作り直すため、固定日付だと
// 時間が経つとテストが「過去日」になって意味を失う)。
const iso = (offsetDays) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};

/** テスト用 data.js。v3 は未来分が1件欠けた状態(取込が復活させるべき状態)にしてある。 */
function dataJsSource() {
  const tournaments = [
    {
      id: 'wl-v3-keep', venueId: 'v3', name: 'v3 既存(APIにもある)', date: iso(3), start: '19:00',
      buyin: 3000, addon: null, stack: 20000, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'auto', verified: false,
    },
    {
      id: 'wl-v19-old', venueId: 'v19', name: 'v19 既存', date: iso(3), start: '18:30',
      buyin: 2000, addon: null, stack: 30000, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'auto', verified: false,
    },
    {
      id: 'manual-v99', venueId: 'v99', name: '対象外店の手入力', date: iso(4), start: '20:00',
      buyin: 1000, addon: null, stack: 10000, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'manual', verified: true,
    },
  ];
  return `const TOURNAMENTS = ${JSON.stringify(tournaments, null, 2)};\n`;
}

/**
 * APIを差し替えるプリロードスクリプト。
 * SCENARIO で「どの店をどう壊すか」を切り替える。
 */
function stubSource() {
  return `
const SCENARIO = process.env.SCENARIO;
const mk = (id, storeId, dayOffset, hhmm) => {
  const d = new Date(Date.now() + dayOffset * 86400e3);
  const day = d.toISOString().slice(0, 10);
  return {
    id, name: 'テスト大会', startAt: day + 'T' + hhmm + ':00.000Z',
    registrationFee: 3000, startingStack: 20000, feature: 'ノーマル', gameRule: 'nlh',
    addons: [], entries: [], store: { displayId: storeId, name: 'store-' + storeId },
  };
};
const ok = (storeId, n) => {
  const list = [];
  for (let i = 0; i < n; i++) list.push(mk(storeId + '-' + i, storeId, i + 2, '10:00'));
  return { totalRecords: list.length, tournaments: list };
};
globalThis.fetch = async (url) => {
  const v3 = String(url).includes('4018492');
  const target = v3 ? 'v3' : 'v19';
  const broken = (SCENARIO === 'v19-empty' && target === 'v19')
    || (SCENARIO === 'all-empty');
  if (broken) return { status: 200, json: async () => ({ totalRecords: 0, tournaments: [] }) };
  if (SCENARIO === 'v19-wrong-store' && target === 'v19') {
    return { status: 200, json: async () => ({ totalRecords: 1, tournaments: [mk('x', '9999999', 2, '10:00')] }) };
  }
  return { status: 200, json: async () => ok(v3 ? '4018492' : '4039056', 3) };
};
`;
}

/**
 * 実物のスクリプトの STORES だけをテスト用の2店に差し替えたコピーを作る。
 *
 * 【なぜ差し替えるか】このテストは「1店が失敗しても他店は通る」を見るので、対象店が
 * 2つ以上ある状態が要る。実物の STORES をそのまま使うと、対象店を1店増減しただけで
 * このテストが壊れる(=テストが設定変更の邪魔をする)。検証したいのは制御フローであって
 * 対象店の中身ではないので、ここは固定の2店に置き換える。
 */
function scriptWithFixtureStores(injectBeforeSelfCheck) {
  const src = fs.readFileSync(SRC, 'utf8');
  const fixture = `const STORES = [
  { venueId: 'v3', displayId: '4018492', label: "m HOLD'EM 中洲" },
  { venueId: 'v19', displayId: '4039056', label: 'CASINO Arrows 小倉店' },
];`;
  let replaced = src.replace(/const STORES = \[[\s\S]*?\n\];/, fixture);
  assert.notEqual(replaced, src, 'STORES 配列を差し替えられませんでした(書式が変わった?)');

  // 自己チェックが本当に効いているかを見るため、その直前にわざとバグを注入できるようにする。
  // 「検査が素通りしないこと」は正常系の実行では観測できない(正常系ではそもそも壊れないため)。
  if (injectBeforeSelfCheck) {
    const anchor = '  // 4) 他店に影響が出ていないことの自己チェック';
    assert.ok(replaced.includes(anchor), '自己チェックの目印が見つかりません(コメントを変えた?)');
    replaced = replaced.replace(anchor, `  ${injectBeforeSelfCheck}\n${anchor}`);
  }
  return replaced;
}

/** 一時リポジトリを作り、スクリプトを1回動かして結果を返す。 */
function run(scenario, args = [], injectBeforeSelfCheck = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-import-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'import-waitinglist.js'), scriptWithFixtureStores(injectBeforeSelfCheck));
  fs.writeFileSync(path.join(dir, 'data.js'), dataJsSource());
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, stubSource());

  const res = spawnSync(process.execPath, ['-r', stub, path.join(dir, 'tools', 'import-waitinglist.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SCENARIO: scenario },
  });

  const after = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
  const m = after.match(/const TOURNAMENTS = ([\s\S]*?);\n$/);
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    tournaments: m ? JSON.parse(m[1]) : null,
    before: JSON.parse(dataJsSource().match(/const TOURNAMENTS = ([\s\S]*?);\n$/)[1]),
    dir,
  };
}

const ofVenue = (list, id) => list.filter((t) => t.venueId === id);

// ---- 1. 全店成功 ----

test('全店成功なら終了コード0で、両店とも取り込まれる', () => {
  const r = run('none');
  assert.equal(r.code, 0);
  assert.equal(ofVenue(r.tournaments, 'v3').length, 3);
  assert.equal(ofVenue(r.tournaments, 'v19').length, 3);
});

// ---- 2. 一部失敗(これがこの変更の本体) ----

test('v19だけ失敗しても v3 は取り込まれる（巻き添えにしない）', () => {
  const r = run('v19-empty');
  assert.equal(ofVenue(r.tournaments, 'v3').length, 3, 'v3 は正常に更新されるべき');
  assert.ok(r.tournaments.some((t) => t.id === 'v3-api-0' || t.id.startsWith('wl-4018492')),
    'v3 にAPI由来のエントリが入っているべき');
});

test('一部失敗のときの終了コードは2（0でも1でもない）', () => {
  const r = run('v19-empty');
  assert.equal(r.code, 2);
});

test('失敗した店のデータは1バイトも変わらない', () => {
  const r = run('v19-empty');
  assert.deepEqual(ofVenue(r.tournaments, 'v19'), ofVenue(r.before, 'v19'));
});

test('対象外の店(v99)は一部失敗のときも変わらない', () => {
  const r = run('v19-empty');
  assert.deepEqual(ofVenue(r.tournaments, 'v99'), ofVenue(r.before, 'v99'));
});

test('別店舗の混入で失敗した場合も他店は通る', () => {
  const r = run('v19-wrong-store');
  assert.equal(r.code, 2);
  assert.equal(ofVenue(r.tournaments, 'v3').length, 3);
  assert.deepEqual(ofVenue(r.tournaments, 'v19'), ofVenue(r.before, 'v19'));
});

// ---- 3. 失敗した店が分かること ----

test('失敗した店舗名が ::error:: 注記で出る（Actionsの先頭に出すため）', () => {
  const r = run('v19-empty');
  assert.match(r.stderr, /::error title=Waitinglist取込に失敗 \(CASINO Arrows 小倉店\)::/);
});

test('失敗した店舗の一覧がまとめて出る', () => {
  const r = run('v19-empty');
  assert.match(r.stderr, /取得に失敗した店舗 1\/2件/);
  assert.match(r.stderr, /CASINO Arrows 小倉店/);
});

// ---- 3.5 自己チェックの基準が「取得に成功した店だけ」であること ----
//
// この2本は【自己チェックの基準を STORES 全体に戻す退行】を捕まえるためにある。
// 基準が STORES 全体だと、スキップした店は targets 側に入って others から外れるため、
// その店のデータが壊れても検査を素通りしてしまう。
// 正常系の実行では観測できない性質なので、自己チェックの直前にバグを注入して確かめる。

test('スキップした店のデータが変化したら、自己チェックが書き込みを止める', () => {
  // v19 は取得に失敗してスキップされる。その v19 のエントリを書き換えるバグを注入する。
  const r = run('v19-empty', [], "arr = arr.map((t) => (t.venueId === 'v19' ? { ...t, name: '注入したバグ' } : t));");
  assert.equal(r.code, 1, 'スキップした店の変化を検知して rc=1 で止まるべき');
  assert.match(r.stderr, /取得に成功した店舗以外のデータが変化しています/);
});

test('自己チェックが止めたときは data.js を書き換えない', () => {
  const r = run('v19-empty', [], "arr = arr.map((t) => (t.venueId === 'v19' ? { ...t, name: '注入したバグ' } : t));");
  assert.deepEqual(r.tournaments, r.before);
});

// in-place な書き換え(オブジェクトのフィールドを直接触る)も検知できること。
// before と arr は同じ要素オブジェクトを共有するので、比較の左辺にマージ前の
// ディープコピーを使っていないとこれが素通りする。
test('エントリを in-place で書き換えるバグも自己チェックが捕まえる', () => {
  const r = run('v19-empty', [], "for (const t of arr) { if (t.venueId === 'v19') t.name = 'in-placeで壊した'; }");
  assert.equal(r.code, 1, 'in-place な変更も検知して rc=1 で止まるべき');
  assert.deepEqual(r.tournaments, r.before);
});

// ---- 4. 全店失敗は従来どおり「何も書かない」 ----

test('全店失敗なら終了コード1で data.js を書き換えない', () => {
  const r = run('all-empty');
  assert.equal(r.code, 1);
  assert.deepEqual(r.tournaments, r.before);
});

// ---- 5. --dry-run ----

test('--dry-run は書き込まない（一部失敗でも終了コード2は返す）', () => {
  const r = run('v19-empty', ['--dry-run']);
  assert.equal(r.code, 2);
  assert.deepEqual(r.tournaments, r.before);
});
