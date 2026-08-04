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
    // 【実APIが返す自由文。data.js にも控えにも載せないと決めた場所】
    // 本物の notes は店が書いた長文の告知そのもので、第三者の氏名・連絡先が入りうる。
    // 全シナリオに載せてあるので、どのテストの実行経路でも漏洩走査の材料になる。
    notes: 'ZQXJVWKZ 本日は龗麤鑫様のご来店ありがとうございました 連絡先 090-1234-5678 QJXZVWQK',
    description: 'ZQXJVWKZ 龗麤鑫 QJXZVWQK',
    memo: '龗麤鑫',
    comment: 'QJXZVWQK',
    caption: 'ZQXJVWKZ',
    remark: '龗麤鑫',
    // 【★これは仮定ではなく実在する】実APIは参加者(=第三者)の氏名とアカウントIDを返す。
    // 実測(2026-08-04・2店129レコード): players[].name='りょう' / 'T'、
    // waitinglistId='Q5783853' / 'P3038232'、avatarUrl=アバター画像のURL。
    // v3 の100件中1件で players が実際に埋まっており、いま現在ライブの応答に入っている。
    // ★notes と同居させるだけでは足りない。レコード丸ごとを出す変異は notes が同乗するので
    //   撃墜されるが、【players[].name だけを控えに載せる】変異は素通りする(実測)。
    //   第三者の個人データが public リポジトリの git 履歴に載ると取り消せないので、
    //   このフィールドは独立した走査対象として必ず持っておくこと。
    players: [{ waitinglistId: 'ZQXJVWKZ', name: '龗麤鑫', avatarUrl: 'QJXZVWQK', isFriend: false }],
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

/**
 * 一時リポジトリを作り、スクリプトを1回動かして結果を返す。
 *
 * @param {object} [opts]
 *   opts.dataJs      … data.js の中身(省略時は上の既定fixture)
 *   opts.writeState  … waitinglist-write-state.json の entries(省略時はファイル自体を置かない)
 */
function run(scenario, args = [], injectBeforeSelfCheck = null, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-import-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'import-waitinglist.js'), scriptWithFixtureStores(injectBeforeSelfCheck));
  // 「機械が最後に書いた値」の控えと所有判定。スクリプトが require するので一緒に置く。
  fs.copyFileSync(path.join(__dirname, 'machine-write-state.js'), path.join(dir, 'tools', 'machine-write-state.js'));
  const src = opts.dataJs || dataJsSource();
  fs.writeFileSync(path.join(dir, 'data.js'), src);
  if (opts.writeState) {
    fs.writeFileSync(
      path.join(dir, 'waitinglist-write-state.json'),
      JSON.stringify({ version: 1, writtenBy: 'test', entries: opts.writeState }, null, 2) + '\n'
    );
  }
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, stubSource());

  const res = spawnSync(process.execPath, ['-r', stub, path.join(dir, 'tools', 'import-waitinglist.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SCENARIO: scenario },
  });

  const after = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
  const m = after.match(/const TOURNAMENTS = ([\s\S]*?);\n$/);
  let stateAfter = null;
  try {
    stateAfter = JSON.parse(fs.readFileSync(path.join(dir, 'waitinglist-write-state.json'), 'utf8'));
  } catch (e) {
    /* 未生成 */
  }
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    tournaments: m ? JSON.parse(m[1]) : null,
    before: JSON.parse(src.match(/const TOURNAMENTS = ([\s\S]*?);\n$/)[1]),
    state: stateAfter,
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

// ============================================================
// 6. 人が入力した値を機械が壊さないこと
// ============================================================
//
// 【この機能は平常時なにもしないので、片方向だけ固定すると壊れていても気づけない】
// 「守る」テストだけを置くと、**何もかも守る実装(= 自動取込が完全に死ぬ)が全部通る**。
// そこで守る/守らないの両方向を CLI レベルで固定する。
//   守る側 : 6-1(人の行)/ 6-3(人が直した項目)/ 6-5(翌日も守られる)/ 6-6(検査が止める)
//   守らない側: 6-2(seed で auto 行は更新される)/ 6-3後半(触っていない項目は更新される)

/** スタブが返す i 番目の枠。スタブと同じ式で出す(ズレると枠が一致せず検査が空振りする)。 */
function apiSlot(i) {
  const day = new Date(Date.now() + (i + 2) * 86400e3).toISOString().slice(0, 10);
  return { date: day, start: '19:00' }; // startAt は 10:00Z = JST 19:00(同日)
}

/** スタブの応答をそのまま data.js の形にしたもの(= 機械が書くはずの値)。 */
function apiRow(i, over = {}) {
  const { date, start } = apiSlot(i);
  return {
    id: `wl-4018492-${i}`,
    venueId: 'v3',
    name: 'テスト大会',
    date,
    start,
    buyin: 3000,
    addon: null,
    stack: 20000,
    guarantee: null,
    reentry: false,
    prize: null,
    tags: [],
    source: 'auto',
    verified: false,
    ...over,
  };
}

function dataJsWith(rows) {
  return `const TOURNAMENTS = ${JSON.stringify(rows, null, 2)};\n`;
}

const v3Rows = (list) => list.filter((t) => t.venueId === 'v3');

test('6-1: 手入力の行は、同じ枠にAPIの行が来ても置き換えられない', () => {
  // 人が admin.html で入れた行(手書きid・source:semi・⚠ 要確認つき)を、APIの1件目と同じ枠に置く。
  const hand = {
    id: 'cc0804n',
    venueId: 'v3',
    name: '深夜トナメ',
    ...apiSlot(0),
    buyin: 5000,
    addon: null,
    stack: 0,
    guarantee: 30000,
    reentry: false,
    prize: null,
    tags: [],
    source: 'semi',
    verified: false,
    lowConfidence: true,
  };
  const r = run('none', [], null, { dataJs: dataJsWith([hand]) });
  assert.equal(r.code, 0);

  const after = r.tournaments.find((t) => t.id === 'cc0804n');
  assert.deepEqual(after, hand, '手入力の行が1バイトも変わっていないこと(⚠ 要確認も残ること)');
  assert.ok(!r.tournaments.some((t) => t.id === 'wl-4018492-0'), '同じ枠のAPIの行は書かれないこと');
  assert.equal(v3Rows(r.tournaments).length, 3, '枠が空いている2件は普通に入ること(自動化は止まらない)');
  assert.match(r.stdout, /人の行を守り、APIの行を書きませんでした 1件/);
  assert.match(r.stdout, /APIの読み値: テスト大会/, '機械の読み値も並べて出すこと(ずれ自体が確認対象)');
});

test('6-2: 控えが無くても wl- + source:auto の行は更新される(seed。自動取込が凍結しない)', () => {
  // 控え(waitinglist-write-state.json)を置かない = 状態ファイル導入前の状態。
  const stale = apiRow(0, { name: '古い名前', buyin: 9999 });
  const r = run('none', [], null, { dataJs: dataJsWith([stale]) });
  assert.equal(r.code, 0);

  const after = r.tournaments.find((t) => t.id === 'wl-4018492-0');
  assert.equal(after.name, 'テスト大会', '★機械の行はAPIの値で更新されること');
  assert.equal(after.buyin, 3000);
  assert.ok(r.state.entries['wl-4018492-0'], '控えが取り直されること');
});

test('6-3: 人が直した項目だけが残り、触っていない項目はAPIで更新される', () => {
  // 控え = 昨日 機械が書いた値(参加費 2500)。data.js は大会名だけが人の手で変わっている。
  // 今日のAPIは参加費 3000 を返す。
  const record = apiRow(0, { buyin: 2500 });
  const current = apiRow(0, { buyin: 2500, name: '人が直した名前' });
  const r = run('none', [], null, {
    dataJs: dataJsWith([current]),
    writeState: { 'wl-4018492-0': record },
  });
  assert.equal(r.code, 0);

  const after = r.tournaments.find((t) => t.id === 'wl-4018492-0');
  assert.equal(after.name, '人が直した名前', '人が直した大会名は守られること');
  assert.equal(after.buyin, 3000, '★触っていない参加費はAPIの値で更新されること(自動化が止まらない)');
  assert.match(r.stdout, /人が直した項目を残しました 1項目 \/ 1行/);
  assert.match(r.stdout, /wl-4018492-0\): name/);
});

test('6-4: 控えるのは【人の値を戻す前】の機械の値(戻した後を控えると保護が1日で切れる)', () => {
  const record = apiRow(0, { buyin: 2500 });
  const current = apiRow(0, { buyin: 2500, name: '人が直した名前' });
  const r = run('none', [], null, {
    dataJs: dataJsWith([current]),
    writeState: { 'wl-4018492-0': record },
  });
  assert.equal(
    r.state.entries['wl-4018492-0'].name,
    'テスト大会',
    '控えには機械の値(テスト大会)が入ること。人の値を控えると翌日「食い違いなし」になって上書きされる'
  );
});

test('6-5: 翌日の実行でも人の修正は残る(2日ぶんを実際に回す)', () => {
  const record = apiRow(0, { buyin: 2500 });
  const day1 = run('none', [], null, {
    dataJs: dataJsWith([apiRow(0, { buyin: 2500, name: '人が直した名前' })]),
    writeState: { 'wl-4018492-0': record },
  });
  assert.equal(day1.code, 0);

  // 1日目の出力(data.js と控え)をそのまま2日目の入力にする。
  const day2 = run('none', [], null, {
    dataJs: dataJsWith(day1.tournaments),
    writeState: day1.state.entries,
  });
  assert.equal(day2.code, 0);
  const after = day2.tournaments.find((t) => t.id === 'wl-4018492-0');
  assert.equal(after.name, '人が直した名前', '★2日目でも人が直した大会名が残っていること');
});

test('6-6: 人の行を壊すバグが入ったら、突き合わせが書き込みを止める', () => {
  const hand = {
    id: 'cc0804n',
    venueId: 'v3',
    name: '深夜トナメ',
    ...apiSlot(0),
    buyin: 5000,
    addon: null,
    stack: 0,
    guarantee: null,
    reentry: false,
    prize: null,
    tags: [],
    source: 'semi',
    verified: false,
  };
  // 自己チェックの直前で人の行を書き換える(= マージがどう数えていようと関係なく壊す)。
  const r = run(
    'none',
    [],
    "arr = arr.map((t) => (t.id === 'cc0804n' ? { ...t, name: '機械が上書きした' } : t));",
    { dataJs: dataJsWith([hand]) }
  );
  assert.equal(r.code, 1, '書き込みを止めること');
  assert.match(r.stderr, /機械のものでない行が書き換えられています/);
  assert.deepEqual(r.tournaments, r.before, 'data.js は1バイトも書き換えないこと');
});

test('6-6: 人が直した項目を戻すバグが入ったら、突き合わせが書き込みを止める', () => {
  const record = apiRow(0, { buyin: 2500 });
  const current = apiRow(0, { buyin: 2500, name: '人が直した名前' });
  const r = run(
    'none',
    [],
    "arr = arr.map((t) => (t.id === 'wl-4018492-0' ? { ...t, name: 'テスト大会' } : t));",
    { dataJs: dataJsWith([current]), writeState: { 'wl-4018492-0': record } }
  );
  assert.equal(r.code, 1);
  assert.match(r.stderr, /人が直した項目が書き換えられています/);
  assert.match(r.stderr, /項目=name/);
});

test('6-7: --dry-run は控えも書かない', () => {
  const r = run('none', ['--dry-run'], null, { dataJs: dataJsWith([apiRow(0, { name: '古い名前' })]) });
  assert.equal(r.code, 0);
  assert.equal(r.state, null, 'waitinglist-write-state.json を作らないこと');
  assert.deepEqual(r.tournaments, r.before);
});

// ============================================================
// 7. carryOver の #5 修正が、この経路の出力を1バイトも変えないこと
// ============================================================
// 【なぜ固定するか】#5 の修正(人の値 > 今回読み取った値 > null)は Vision経路のための
// もので、こちらは toTournament が guarantee/prize を【定数 null で返す】ため出力が
// 変わらない。それを主張ではなく検査で担保しておく。将来 toTournament に
// guarantee/prize を足すと、この経路にも #5 の挙動が入ることになるので、
// そのときこのテストが落ちて「意図した変更か」を必ず1度考えることになる。

test('7: APIから作るエントリの guarantee / prize は常に null(推測で埋めない)', () => {
  const r = run('none');
  assert.equal(r.code, 0);
  const fromApi = r.tournaments.filter((t) => t.id.startsWith('wl-4018492-'));
  assert.ok(fromApi.length > 0, 'API由来の行が入っていること(空だと検査が空振りする)');
  for (const t of fromApi) {
    assert.equal(t.guarantee, null, 'APIに該当フィールドが無いので推測で埋めないこと');
    assert.equal(t.prize, null);
  }
});

test('7: 人が入れた GTD / 賞品は、機械が行を作り直しても残る', () => {
  // 控えは GTD なし = 人が後から付けた、という状態。
  const record = apiRow(0);
  const current = apiRow(0, { guarantee: 300000, prize: 'Tシャツ' });
  const r = run('none', [], null, {
    dataJs: dataJsWith([current]),
    writeState: { 'wl-4018492-0': record },
  });
  assert.equal(r.code, 0);
  const after = r.tournaments.find((t) => t.id === 'wl-4018492-0');
  assert.equal(after.guarantee, 300000, '人が付けたGTDが残ること');
  assert.equal(after.prize, 'Tシャツ');
});

test('6-8: 同じidの既存でも、控えが無く seed の条件も満たさなければ上書きしない', () => {
  // 【seed は wl- 【かつ】source:'auto' の両方を要求する】ことを行き先で確かめる。
  // 片方だけで判定する実装に変えると、手入力572件(手書きid + semi)や、
  // 人が source を変えた行が機械のものに化ける。
  const notAuto = apiRow(0, { source: 'semi', name: '人のものとして扱うべき行' });
  const r = run('none', [], null, { dataJs: dataJsWith([notAuto]) });
  assert.equal(r.code, 0);
  assert.deepEqual(
    r.tournaments.find((t) => t.id === 'wl-4018492-0'),
    notAuto,
    "source が 'auto' でなければ、id が wl- でも上書きしないこと"
  );
  assert.match(r.stdout, /人の行を守り、APIの行を書きませんでした 1件/);
});

// ============================================================
// 8. 漏洩走査: このスクリプトが書く公開ファイルに、APIの自由文が1文字も出ないこと
// ============================================================
//
// 【なぜ必要か】このPRは `waitinglist-write-state.json` という【新しい公開出力面】を作る。
// 実APIの `notes` は店が書いた長文の告知そのもので、第三者の氏名・連絡先が入りうる。
// リポジトリは public で、状態ファイルはワークフローの `git add -A` で毎朝コミットされる。
// **一度 git 履歴に載ると取り消せない**(履歴・フォーク・キャッシュ)。
//
// **マージと初回実行の間にゲートが無い** — cron で回るので、マージすれば翌朝06:23に
// この状態ファイルが public に生成・コミットされる。「マージしてから走査を足す」猶予は
// 構造的に存在しない。
//
// 【現時点の漏洩は0件。それでも置くのは将来の変更を捕まえるため】
// `notes` / `description` / `memo` / `comment` / `caption` / `remark` の参照は実装に0件。
// 他の2経路(Instagram監視・画像取込み)には同じ形の走査があり、
// **3つのうち1つだけ無いと、そこが変更されたとき静かに素通りする。**
//
// 【走査に `store.name` を含めない理由】これは【当社サイトが公開している店名】であって
// 第三者の自由文ではない。しかも「別店舗の混入」を検出したときの ::error:: が
// 正当にこれを出す(どの店のデータが混ざったかを人に伝えるため)。
// 走査対象にすると、その正当な報告を漏洩として誤検知する。

// ログにも data.js にもコードにも現れない文字だけで構成すること。
// 【先頭・中間・末尾の3箇所に置く】1箇所だけだと「冒頭N字だけ出す」「末尾だけ出す」
// といった部分的な漏洩を取り逃がす。
const WL_FRAGMENT_MARKERS = ['ZQXJVWKZ', '龗麤鑫', 'QJXZVWQK'];
// 【2文字断片では走査しない印】電話番号は "09" "12" のような断片が
// data.js の日付・時刻(2026-09-12 / 09:00)と当たり前に一致するので偽陽性になる。
// 個人情報として現実味のある形なので文面には残し、走査は「丸ごと一致」だけにする。
const WL_WHOLE_MARKERS = ['090-1234-5678'];

function assertNoApiFreeTextLeak(haystacks) {
  let checked = 0;
  for (const marker of WL_FRAGMENT_MARKERS) {
    const chars = [...marker];
    for (let i = 0; i + 2 <= chars.length; i++) {
      const frag = chars.slice(i, i + 2).join('');
      checked += 1;
      for (const [name, text] of Object.entries(haystacks)) {
        assert.ok(!text.includes(frag), `${name} にAPIの自由文の断片が漏れている: ${JSON.stringify(frag)}`);
      }
    }
  }
  for (const marker of [...WL_FRAGMENT_MARKERS, ...WL_WHOLE_MARKERS]) {
    checked += 1;
    for (const [name, text] of Object.entries(haystacks)) {
      assert.ok(!text.includes(marker), `${name} にAPIの自由文が漏れている: ${JSON.stringify(marker)}`);
    }
  }
  assert.ok(checked >= 20, `走査した断片が少なすぎる(${checked}通り)`);
}

test('★漏洩走査: 全出力(stdout/stderr/data.js/控えのJSON)にAPIの自由文が1文字も出ない', () => {
  // 【fixtureが痩せていると走査は空振りする】ログの経路を1本ずつ通してから走査する。
  // ここで通すのは: 追加 / 人の行を守って見送り(明細つき) / 人が直した項目を残した /
  // API未掲載の手入力 の4本。いずれもAPI由来の値を文字列にして出す = 最も混入しやすい場所。
  const blocked = {
    id: 'cc0804n',
    venueId: 'v3',
    name: '人が入れた行(枠を守る)',
    ...apiSlot(0),
    buyin: 5000,
    addon: null,
    stack: 0,
    guarantee: 30000,
    reentry: false,
    prize: null,
    tags: [],
    source: 'semi',
    verified: false,
    lowConfidence: true,
  };
  const record = apiRow(1, { buyin: 2500 }); // 昨日 機械が書いた値
  const edited = apiRow(1, { buyin: 2500, name: '人が直した名前' }); // 名前だけ人が直した
  const kept = {
    id: 'kq9999',
    venueId: 'v3',
    name: 'API未掲載の手入力',
    date: new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10),
    start: '21:00',
    buyin: 1000,
    addon: null,
    stack: 0,
    guarantee: null,
    reentry: false,
    prize: null,
    tags: [],
    source: 'semi',
    verified: false,
  };

  const r = run('none', [], null, {
    dataJs: dataJsWith([blocked, edited, kept]),
    writeState: { [record.id]: record },
  });

  // 【走査の前に、狙った経路を実際に通ったことを確かめる】通っていなければ走査は空振りになる。
  assert.equal(r.code, 0, `正常終了すること: ${r.stderr}`);
  const all = r.stdout + r.stderr;
  for (const [label, re] of [
    ['店ごとの取得ログ', /API 3件 取得/],
    ['人の行を守って見送り(明細)', /人の行を守り、APIの行を書きませんでした 1件/],
    ['APIの読み値の明細', /APIの読み値: テスト大会/],
    ['人が直した項目を残した', /人が直した項目を残しました 1項目/],
    ['API未掲載の手入力', /API未掲載のため残した手入力/],
    ['控えの書き出し', /waitinglist-write-state\.json: 更新しました/],
  ]) {
    assert.match(all, re, `${label}の経路を通っていない(走査が空振りになる)`);
  }
  assert.ok(r.state, '控えが生成されていること');
  const stateJson = JSON.stringify(r.state);
  assert.ok(stateJson.includes('テスト大会'), '控えに中身が入っていること(空だと走査が空振りになる)');
  const dataJson = JSON.stringify(r.tournaments);
  assert.ok(dataJson.includes('テスト大会'), 'data.js にAPI由来の行が入っていること');

  assertNoApiFreeTextLeak({
    stdout: r.stdout,
    // 【stderr を必ず含める】破棄ログ・正規化ログ・失敗店の報告は console.warn / console.error =
    // stderr に出る。stdout だけを見ると、最も混入しやすい経路を丸ごと見逃す。
    stderr: r.stderr,
    'waitinglist-write-state.json': stateJson,
    'data.js': dataJson,
  });
});

test('★漏洩走査: 取得に失敗した店の報告(::error::)にもAPIの自由文が出ない', () => {
  // 失敗経路は stderr にしか出ないので、上のテストとは別に1回通す。
  const r = run('v19-wrong-store');
  assert.equal(r.code, 2, '一部失敗の終了コード');
  assert.match(r.stderr, /別店舗\(displayId=9999999/, '混入検出の経路を通っていること');
  assertNoApiFreeTextLeak({ stdout: r.stdout, stderr: r.stderr });
});
