'use strict';

/**
 * import-texaspoker.test.js
 *
 * 前半: 純粋関数(HTMLパース・リング判定・本文からの項目抽出)の単体テスト。
 *   実測(2026年8-9月の公式ページ・全53件)で見つけた誤判定を再現するケースを固定してある
 *   (詳細は tools/import-texaspoker.js の該当関数のコメント参照)。
 *
 * 後半: 【店舗単位のエラー隔離】と【人の行を壊さないこと】のテスト。
 *   本物のサイトは叩かない。`node -r <stub>` で global fetch を差し替えてから起動する
 *   (tools/import-waitinglist.test.js と同じ方式)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, 'import-texaspoker.js');
const mod = require('./import-texaspoker.js');

// ============================================================
// 純粋関数のテスト
// ============================================================

test('isRingRow: 「ノーレーキリングゲーム」はリングとして除外される', () => {
  assert.equal(mod.isRingRow('ノーレーキリングゲーム'), true);
});

test('isRingRow: 「キャッシュゲーム」を含む名前もリングとして除外される(将来の表記ゆれ対策)', () => {
  assert.equal(mod.isRingRow('週末キャッシュゲームDAY'), true);
});

test('isRingRow: 通常のトーナメント名は除外されない', () => {
  for (const name of ['アリーナトーナメント', 'Deep Stack Freeze out', 'てきさすトーナメント', 'ロイヤルトーナメント【5級】']) {
    assert.equal(mod.isRingRow(name), false, `${name} が誤ってリング扱いになった`);
  }
});

test('addMonths: 年をまたぐ繰り上がりを正しく計算する', () => {
  assert.deepEqual(mod.addMonths(2026, 11, 1), { year: 2026, month: 12 });
  assert.deepEqual(mod.addMonths(2026, 11, 2), { year: 2027, month: 1 });
  assert.deepEqual(mod.addMonths(2026, 12, 2), { year: 2027, month: 2 });
});

test('extractBodyFields: 開始時刻・参加費・アドオン・初期スタックを読み取る(標準書式)', () => {
  const body =
    '本日のお知らせ\n【てきさすトーナメント】\n\n・Entry Fee:1100y\n・Re-Entry/Re-Buy/Add:1100y\n※初期スタック3万点\n\n・Timer Start 18:15\n・Late Resist 21:30';
  const f = mod.extractBodyFields(body);
  assert.equal(f.start, '18:15');
  assert.equal(f.buyin, 1100);
  assert.equal(f.addon, 1100);
  assert.equal(f.stack, 30000);
  assert.equal(f.reentry, true);
});

test('extractBodyFields: 全角の「…」区切り・全角スペースの書式も読み取る', () => {
  const body = '・Timer Start…18:15\n・Entry Fee…2200y\n・Re-Entry/Re-Buy/Add…2200y';
  const f = mod.extractBodyFields(body);
  assert.equal(f.start, '18:15');
  assert.equal(f.buyin, 2200);
  assert.equal(f.addon, 2200);
});

test('extractBodyFields: 「Entry Fee Free」(yが付かない)は0円として読み取る', () => {
  const body = '・Timer Start 18:15\n・Entry Fee Free（初期スタック3万点）\n・Re-Entry/Re-Buy/Add On 550y（3万点）';
  const f = mod.extractBodyFields(body);
  assert.equal(f.buyin, 0);
  assert.equal(f.addon, 550);
});

test('extractBodyFields: 読み取れない項目は null/空文字になる(でっち上げない)', () => {
  const body = '本日のお知らせ\n5級以上の皆様への無料招待制トーナメント\n受付開始　18:00\nタイマースタート　18:30';
  const f = mod.extractBodyFields(body);
  assert.equal(f.start, '18:30');
  assert.equal(f.buyin, null);
  assert.equal(f.addon, null);
  assert.equal(f.stack, null);
});

// 【★実測で見つけた誤判定の再現(2026-08-30 超Deep Stuck Freeze Out)】
// 「Entry Fee 3300y」の直後に「※Add on無し」、本文の別の場所に
// 「リエントリー、アドオン無しのガチンコバトル！」がある。単純に「本文に『リエントリー』が
// あれば true」にすると誤って true になっていた。
test('extractBodyFields: 「リエントリー、アドオン無し」は reentry=false になる', () => {
  const body =
    '・Entry Fee 3300y（初期スタック20万点）\n※Add on無し\n\n［Prize］\n1st 入場料無料券×4\n\n' +
    'リエントリー、アドオンなしのガチンコバトル！\n初期スタック20万点で、いろいろなアクションを試すことができます！';
  const f = mod.extractBodyFields(body);
  assert.equal(f.reentry, false, 'リエントリー無しの行が true と誤判定された');
});

// 【★もう一方の実測ケース(2026-09-09 〜力試し〜)】
// 「・Re-Entry 2,500y」(有料で明確に許可)の直後に「※Re-Buy/Add on 無し」(アドオン側だけ無し)。
// 「無し」という語の存在だけで false にすると、こちらを誤って false にしてしまう。
test('extractBodyFields: 「Re-Entry <価格>」の後に「Re-Buy/Add on 無し」があっても reentry=true のまま', () => {
  const body = '・Entry Fee  Free\n・Re-Entry 2,500y\n※Cash Only\n※Re-Buy/Add on 無し';
  const f = mod.extractBodyFields(body);
  assert.equal(f.reentry, true, '有料で明記されたRe-Entryが false と誤判定された');
});

test('extractBodyFields: 「リエントリー無し」単独の書式も false になる', () => {
  const body = '・Entry Fee:2200y（初期スタック10万点）\n・Add:2200y（5万点）\n\nリエントリー無し';
  const f = mod.extractBodyFields(body);
  assert.equal(f.reentry, false);
});

const SAMPLE_MONTH_HTML = `<html><body><center>
<table width=93%><tr><td width=60><b>2026年</b></td><td align=center><a href="x"><img></a>　　　<font size="+2"><b>9月</b></font>　　　<a href="x"><img></a></td></tr></table>
<table></table>
<a name="1"></a><table><tr><td>　 2026年9月1日<font color="#000000">(火)</font>　　<b>てきさすトーナメント</b></td><td></td></tr>
<tr><td>本日のお知らせ<br>・Entry Fee:1100y<br>・Timer Start 18:15</td></tr></table>
<a name="2"></a><table><tr><td>　 2026年9月2日<font color="#000000">(水)</font>　　<b>ノーレーキリングゲーム</b></td><td></td></tr>
<tr><td>本日のお知らせ<br>リングゲームの説明</td></tr></table>
</center></body></html>`;

test('parseMonthHtml: 通常のトーナメントは拾い、リングの行は除外件数に数える', () => {
  const { rows, ringExcluded } = mod.parseMonthHtml(SAMPLE_MONTH_HTML, 2026, 9);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'てきさすトーナメント');
  assert.equal(rows[0].date, '2026-09-01');
  assert.equal(ringExcluded, 1);
});

test('parseMonthHtml: 見出しを読み取れないアンカーがあると例外を投げる(黙って捨てない)', () => {
  const broken = `<a name="9"></a><table><tr><td>形式が崩れた見出し</td></tr></table>`;
  assert.throws(() => mod.parseMonthHtml(broken, 2026, 9), /見出し.*読み取れませんでした/);
});

// ============================================================
// mergeOwnIntoStoreList / auto-import-stores.json の共同編集
// (tools/import-waitinglist.js と2つの取込みスクリプトで duplicate している
//  ロジック。詳細は tools/import-texaspoker.js の当該コメント参照)
// ============================================================

test('mergeOwnIntoStoreList: 他スクリプトが書いた行(自分の担当外)はそのまま残す', () => {
  const existing = [
    { venueId: 'v3', displayId: '4018492', label: "m HOLD'EM 中洲", source: 'waitinglist' },
    { venueId: 'v19', displayId: '4039056', label: 'CASINO Arrows 小倉店', source: 'waitinglist' },
  ];
  const own = [{ venueId: 'v16', label: 'てきさすほーるでむ。', source: 'texaspoker' }];
  const merged = mod.mergeOwnIntoStoreList(existing, own, new Set(['v16']));
  assert.deepEqual(merged.map((s) => s.venueId), ['v3', 'v16', 'v19'], '数値昇順で並び、他店の行が消えていない');
  assert.deepEqual(merged.find((s) => s.venueId === 'v3'), existing[0], '自分の担当外の行の中身を書き換えてしまった');
});

test('mergeOwnIntoStoreList: 自分の担当店は既存の内容を無視して STORES 側の内容で作り直す', () => {
  const existing = [{ venueId: 'v16', label: '古いラベル', source: 'texaspoker' }];
  const own = [{ venueId: 'v16', label: 'てきさすほーるでむ。', source: 'texaspoker' }];
  const merged = mod.mergeOwnIntoStoreList(existing, own, new Set(['v16']));
  assert.deepEqual(merged, own);
});

test('mergeOwnIntoStoreList: 既存ファイルが無い(null)ときも自分の担当ぶんだけで新規作成できる', () => {
  const own = [{ venueId: 'v16', label: 'てきさすほーるでむ。', source: 'texaspoker' }];
  assert.deepEqual(mod.mergeOwnIntoStoreList(null, own, new Set(['v16'])), own);
});

test('venueSortKey: "v" + 数字の並びを数値として昇順に扱う("v9" < "v16")', () => {
  assert.ok(mod.venueSortKey('v9') < mod.venueSortKey('v16'), '文字列比較(v16 < v9)になっていないか');
});

test('GENERATED_BY: import-waitinglist.js 側の文言と完全に一致している(片方だけ変更すると実行順で差分が揺れるため)', () => {
  const waitinglistSrc = fs.readFileSync(path.join(__dirname, 'import-waitinglist.js'), 'utf8');
  const m = waitinglistSrc.match(/const GENERATED_BY = (.*);/);
  assert.ok(m, 'tools/import-waitinglist.js から GENERATED_BY を読み取れませんでした(書式が変わった?)');
  // eslint-disable-next-line no-eval -- 文字列リテラルの中身をテストの中だけで評価する(信頼できるローカルソース)
  const waitinglistValue = eval(m[1]);
  assert.equal(mod.GENERATED_BY, waitinglistValue);
});

test('auto-import-stores.json: 現物が STORES(v16)を含み、他店の行を消していない', () => {
  const stores = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'auto-import-stores.json'), 'utf8')).stores;
  const v16 = stores.find((s) => s.venueId === 'v16');
  assert.ok(v16, 'auto-import-stores.json に v16 が登録されていません');
  assert.equal(v16.label, 'てきさすほーるでむ。');
  assert.ok(stores.some((s) => s.venueId === 'v3'), 'v3(waitinglist側)の行が消えている');
  assert.ok(stores.some((s) => s.venueId === 'v19'), 'v19(waitinglist側)の行が消えている');
});

// ============================================================
// エンドツーエンド(実プロセスを起動)
// ============================================================

const iso = (offsetDays) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};

function dataJsSource(extra = []) {
  const tournaments = [
    {
      id: 'txp-v16-100', venueId: 'v16', name: '既存(サイトにもある)', date: iso(3), start: '18:15',
      buyin: 1100, addon: 1100, stack: 30000, guarantee: null, reentry: true, prize: null,
      tags: [], source: 'auto', verified: false,
    },
    {
      id: 'tx0101', venueId: 'v16', name: '人が入れた行', date: iso(5), start: '18:15',
      buyin: 9999, addon: null, stack: null, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'semi', verified: false,
    },
    {
      id: 'manual-v99', venueId: 'v99', name: '対象外店の手入力', date: iso(4), start: '20:00',
      buyin: 1000, addon: null, stack: 10000, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'manual', verified: true,
    },
    ...extra,
  ];
  return `const TOURNAMENTS = ${JSON.stringify(tournaments, null, 2)};\n`;
}

/** カレンダーHTMLを組み立てる(パース対象のフォーマットに合わせた最小構成)。 */
function buildCalendarHtml(year, month, days) {
  const head =
    `<html><body><center><table width=93%><tr><td width=60><b>${year}年</b></td>` +
    `<td align=center><a href="x"><img></a>　　　<font size="+2"><b>${month}月</b></font>　　　` +
    `<a href="x"><img></a></td></tr></table><table></table>`;
  const anchors = days
    .map(
      (d) =>
        `<a name="${d.id}"></a><table><tr><td>　 ${year}年${month}月${d.day}日<font color="#000000">(月)</font>　　<b>${d.name}</b></td><td></td></tr>` +
        `<tr><td>本日のお知らせ<br>${d.body || ''}</td></tr></table>`
    )
    .join('\n');
  return `${head}${anchors}</center></body></html>`;
}

/** SCENARIO ごとにカレンダーHTMLを返すスタブ fetch を組み立てる。 */
function stubSource() {
  return `
const { execFileSync } = require('node:child_process');
const SCENARIO = process.env.SCENARIO;
// 本物のサイトは Shift_JIS で返す。取込み側は常に TextDecoder('shift_jis') で読むので、
// テストのHTMLも Shift_JIS のバイト列にして返さないと(UTF-8のまま返すと)見出しの
// 「年」「月」のような多バイト文字が化けて誤判定になる。エンコードはNode標準に無いため、
// システムの iconv コマンドで変換する(このリポジトリの動作確認手順自体が iconv 前提)。
const enc = (s) => {
  const sjis = execFileSync('iconv', ['-f', 'UTF-8', '-t', 'CP932'], { input: s, maxBuffer: 10 * 1024 * 1024 });
  return Uint8Array.from(sjis).buffer;
};
${buildCalendarHtml.toString()}
function monthsFromToday(n) {
  const j = new Date(Date.now() + 9 * 3600e3);
  const total = j.getUTCFullYear() * 12 + j.getUTCMonth() + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const year = Number(u.searchParams.get('year'));
  const mon = Number(u.searchParams.get('mon'));
  if (SCENARIO === 'fetch-error') return { status: 500 };
  if (SCENARIO === 'year-mismatch') {
    // 要求と違う年月を見出しに入れて返す(構造変化・パラメータ無視の検知テスト用)
    const html = buildCalendarHtml(year - 1, mon, [{ id: '1', day: 5, name: 'ダミー' }]);
    return { status: 200, arrayBuffer: async () => enc(html) };
  }
  if (SCENARIO === 'header-broken') {
    const html = '<html><body><center><table width=93%><tr><td width=60><b>' + year + '年</b></td>' +
      '<td align=center><font size="+2"><b>' + mon + '月</b></font></td></tr></table>' +
      '<a name="9"></a><table><tr><td>形式が崩れている</td></tr></table></center></body></html>';
    return { status: 200, arrayBuffer: async () => enc(html) };
  }
  if (SCENARIO === 'all-empty') {
    const html = buildCalendarHtml(year, mon, []);
    return { status: 200, arrayBuffer: async () => enc(html) };
  }
  if (SCENARIO === 'shrink') {
    // 当月だけ1件、他は0件(急減ガードの発火を確認するため既存より大幅に少なくする)
    const cur = monthsFromToday(0);
    if (year === cur.year && mon === cur.month) {
      const html = buildCalendarHtml(year, mon, [{ id: '1', day: 20, name: '縮小後の1件', body: '・Entry Fee:1000y' }]);
      return { status: 200, arrayBuffer: async () => enc(html) };
    }
    return { status: 200, arrayBuffer: async () => enc(buildCalendarHtml(year, mon, [])) };
  }
  // 既定: 当月に「サイトにもある既存」と同じ日程 + 新規1件 + リング1件、他の月は空。
  const cur = monthsFromToday(0);
  if (year === cur.year && mon === cur.month) {
    const html = buildCalendarHtml(year, mon, [
      { id: '100', day: 20, name: '既存(サイトにもある)', body: '・Entry Fee:1100y<br>・Re-Entry/Re-Buy/Add:1100y<br>※初期スタック3万点<br>・Timer Start 18:15' },
      { id: '200', day: 22, name: '新規トーナメント', body: '・Entry Fee:2200y<br>・Timer Start 19:00' },
      { id: '300', day: 24, name: 'ノーレーキリングゲーム', body: 'リングゲームの説明' },
    ]);
    return { status: 200, arrayBuffer: async () => enc(html) };
  }
  return { status: 200, arrayBuffer: async () => enc(buildCalendarHtml(year, mon, [])) };
};
`;
}

function makeRepo(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-import-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(SRC, path.join(dir, 'tools', 'import-texaspoker.js'));
  for (const mod2 of ['machine-write-state.js', 'schedule-write-guard.js', 'tournament-merge.js', 'venue-listing-rules.js']) {
    fs.copyFileSync(path.join(__dirname, mod2), path.join(dir, 'tools', mod2));
  }
  const src = opts.dataJs || dataJsSource();
  fs.writeFileSync(path.join(dir, 'data.js'), src);
  if (opts.writeState) {
    fs.writeFileSync(
      path.join(dir, 'texaspoker-write-state.json'),
      JSON.stringify({ version: 1, writtenBy: 'test', entries: opts.writeState }, null, 2) + '\n'
    );
  }
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, stubSource());
  return { dir, src, stub };
}

function run(scenario, args = [], opts = {}) {
  const { dir, src, stub } = makeRepo(opts);
  const res = spawnSync(process.execPath, ['-r', stub, path.join(dir, 'tools', 'import-texaspoker.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SCENARIO: scenario },
  });
  const after = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
  const m = after.match(/const TOURNAMENTS = ([\s\S]*?);\n$/);
  let stateAfter = null;
  try {
    stateAfter = JSON.parse(fs.readFileSync(path.join(dir, 'texaspoker-write-state.json'), 'utf8'));
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

test('通常実行: 新規1件が追加され、リングの行は取り込まれない、終了コード0', () => {
  const r = run('default');
  assert.equal(r.code, 0, r.stderr);
  const v16 = ofVenue(r.tournaments, 'v16');
  const added = v16.find((t) => t.id === 'txp-v16-200');
  assert.ok(added, '新規トーナメントが追加されていない');
  assert.equal(added.buyin, 2200);
  assert.equal(v16.some((t) => t.name.includes('リングゲーム')), false, 'リングの行が取り込まれた');
});

test('通常実行: 対象外店(v99)のデータは変化しない', () => {
  const r = run('default');
  assert.equal(r.code, 0);
  assert.deepEqual(ofVenue(r.tournaments, 'v99'), ofVenue(r.before, 'v99'));
});

test('人が入れた行(tx0101)は、サイト側に同じ枠のデータが無くてもそのまま残る', () => {
  const r = run('default');
  assert.equal(r.code, 0);
  const kept = r.tournaments.find((t) => t.id === 'tx0101');
  assert.ok(kept, '人が入れた行が消えた');
  assert.equal(kept.buyin, 9999);
});

test('--dry-run は data.js を書き換えない', () => {
  const r = run('default', ['--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.tournaments, r.before);
  assert.equal(r.state, null, '--dry-run なのに状態ファイルが書かれた');
});

test('全月0件なら失敗として扱われ、data.jsを書き換えない(終了コード1)', () => {
  const r = run('all-empty');
  assert.equal(r.code, 1);
  assert.deepEqual(r.tournaments, r.before);
});

test('fetch失敗なら失敗として扱われ、data.jsを書き換えない(終了コード1)', () => {
  const r = run('fetch-error');
  assert.equal(r.code, 1);
  assert.deepEqual(r.tournaments, r.before);
});

test('要求した年月と見出しが食い違うと失敗として扱われる(サイト構造変化の検知)', () => {
  const r = run('year-mismatch');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /反映していません|一致しません/);
  assert.deepEqual(r.tournaments, r.before);
});

test('見出しが読み取れないアンカーがあると失敗として扱われる(パース崩壊の検知)', () => {
  const r = run('header-broken');
  assert.equal(r.code, 1);
  assert.deepEqual(r.tournaments, r.before);
});

test('急減ガード: 今日以降の件数が大きく減ると失敗として扱われる', () => {
  // before に今日以降の v16 の行を多めに仕込んでおく
  const extra = [];
  for (let i = 0; i < 8; i++) {
    extra.push({
      id: `txp-v16-shrink${i}`, venueId: 'v16', name: '既存(縮小前)', date: iso(1 + i), start: '18:15',
      buyin: 1000, addon: null, stack: null, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'auto', verified: false,
    });
  }
  const r = run('shrink', [], { dataJs: dataJsSource(extra) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /急減/);
  assert.deepEqual(r.tournaments, r.before);
});

test('急減ガード: --allow-shrink を付けると通る', () => {
  const extra = [];
  for (let i = 0; i < 8; i++) {
    extra.push({
      id: `txp-v16-shrink${i}`, venueId: 'v16', name: '既存(縮小前)', date: iso(1 + i), start: '18:15',
      buyin: 1000, addon: null, stack: null, guarantee: null, reentry: false, prize: null,
      tags: [], source: 'auto', verified: false,
    });
  }
  const r = run('shrink', ['--allow-shrink'], { dataJs: dataJsSource(extra) });
  assert.equal(r.code, 0, r.stderr);
});

test('状態ファイルが機械の値を控え、翌日以降の人の修正を保護できる状態になる', () => {
  const r = run('default');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.state && r.state.entries, '状態ファイルが書かれていない');
  assert.ok(r.state.entries['txp-v16-200'], '新規に追加した行の控えが無い');
});

// ============================================================
// ★require ガード
// ============================================================

function fetchCounterSource() {
  return `
const fs = require('node:fs');
const path = require('node:path');
let calls = 0;
const orig = globalThis.fetch;
globalThis.fetch = async (...args) => { calls += 1; return orig(...args); };
process.on('exit', () => {
  fs.writeFileSync(path.join(__dirname, 'fetch-calls.txt'), String(calls));
});
`;
}

function requirerSource() {
  return `
const m = require('./tools/import-texaspoker.js');
console.log('REQUIRE_RETURNED');
console.log('EXPORT_KEYS=' + JSON.stringify(Object.keys(m || {})));
`;
}

function observe(entry, scenario = 'default') {
  const { dir, src, stub } = makeRepo({});
  fs.writeFileSync(path.join(dir, 'fetch-counter.js'), fetchCounterSource());
  fs.writeFileSync(path.join(dir, 'requirer.js'), requirerSource());
  const target = entry === 'require' ? path.join(dir, 'requirer.js') : path.join(dir, 'tools', 'import-texaspoker.js');
  const res = spawnSync(process.execPath, ['-r', stub, '-r', path.join(dir, 'fetch-counter.js'), target], {
    encoding: 'utf8',
    env: { ...process.env, SCENARIO: scenario },
  });
  let fetchCalls = null;
  try {
    fetchCalls = Number(fs.readFileSync(path.join(dir, 'fetch-calls.txt'), 'utf8'));
  } catch (e) {
    /* 未生成 */
  }
  return {
    code: res.status,
    stdout: res.stdout || '',
    dataJsBefore: src,
    dataJsAfter: fs.readFileSync(path.join(dir, 'data.js'), 'utf8'),
    fetchCalls,
    wroteWriteState: fs.existsSync(path.join(dir, 'texaspoker-write-state.json')),
  };
}

test('★require ガード: require しても main() が走らない', () => {
  const r = observe('require');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /REQUIRE_RETURNED/);
  assert.equal(r.fetchCalls, 0, 'require しただけで fetch が呼ばれた');
  assert.equal(r.dataJsAfter, r.dataJsBefore, 'require しただけで data.js が書き換わった');
  assert.equal(r.wroteWriteState, false, 'require しただけで状態ファイルが作られた');
});

test('★require ガード: 同じ計測でCLI起動なら反転する(空振りの検査にしない)', () => {
  const r = observe('cli');
  assert.equal(r.code, 0, r.stdout);
  assert.ok(r.fetchCalls > 0, `CLI起動なのに fetch が0回: ${r.fetchCalls}`);
  assert.notEqual(r.dataJsAfter, r.dataJsBefore, 'CLI起動なのに data.js が変わらなかった');
});
