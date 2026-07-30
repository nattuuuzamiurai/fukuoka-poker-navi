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

const { dateProblem, normalizeExtractedRow, extractedRowProblem, duplicateIdProblem } = require('./validate-data');

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

// start は id の構成要素(`ig-v18-2026-09-12-1900-nlh`)であり、同じ日の並び順も start の
// 文字列比較で決まる。`7pm` や改行混入をそのまま通すと id と表示の両方が壊れる。
// この検査は【正規化(normalizeExtractedRow)を通した後の値】に対する最後の関門なので、
// `9:00` をここで通すようにしてはいけない(正規化を呼び忘れた経路の逸脱がそのまま入る)。
test('extractedRowProblem: start は HH:MM(ゼロ埋め)か空のみ許す', () => {
  const base = { date: '2026-09-05', name: 'マンデー' };
  assert.equal(extractedRowProblem({ ...base, start: '19:00' }), null);
  assert.equal(extractedRowProblem({ ...base, start: '00:00' }), null);
  assert.equal(extractedRowProblem({ ...base, start: null }), null, 'start省略は許す(00:00が既定)');
  assert.equal(extractedRowProblem({ ...base, start: '' }), null);
  assert.match(extractedRowProblem({ ...base, start: '7pm' }), /開始時刻が HH:MM/);
  assert.match(extractedRowProblem({ ...base, start: '9:00' }), /開始時刻が HH:MM/, '正規化前の値はここでは通さない');
  assert.match(extractedRowProblem({ ...base, start: '19:00\n<b>' }), /開始時刻が HH:MM/);
  assert.match(extractedRowProblem({ ...base, start: '25:00' }), /開始時刻が HH:MM/);
});

// ---------- 正規化(検査の前段。2026-07-31追加 / PR #19のフォローアップ) ----------
// 破棄は「遅れる」ではなく「自動経路から永久に失われる」を意味する(Instagram監視は
// 捨てた行を再試行しない)。曖昧さゼロで直せる逸脱にまで破棄を使うのは過剰なので、
// 検査の前に直せるものだけを直す。

test('normalizeExtractedRow: ゼロ埋め漏れ・全角コロンの start を直し、正規化前の値を notes に残す', () => {
  const base = { date: '2026-09-05', name: 'マンデー' };

  const a = normalizeExtractedRow({ ...base, start: '9:00' });
  assert.equal(a.row.start, '09:00');
  assert.equal(extractedRowProblem(a.row), null, '正規化後は検査を通ること');
  assert.deepEqual(
    a.notes.map((n) => [n.field, n.from, n.to]),
    [['start', '9:00', '09:00']],
    '正規化前の値が残ること(Visionの出力形式を人が測るため)'
  );

  assert.equal(normalizeExtractedRow({ ...base, start: '7:30' }).row.start, '07:30');
  assert.equal(normalizeExtractedRow({ ...base, start: '19：00' }).row.start, '19:00', '全角コロン');
  assert.equal(normalizeExtractedRow({ ...base, start: '9：00' }).row.start, '09:00', '全角コロン+ゼロ埋め漏れ');
  assert.equal(normalizeExtractedRow({ ...base, start: ' 19:00 ' }).row.start, '19:00', '前後の空白');
  // 全角数字は日本語の告知画像では全角コロンと同じ頻度で出る「同種の揺れ」。NFKCで一緒に吸収する
  assert.equal(normalizeExtractedRow({ ...base, start: '１９：００' }).row.start, '19:00', '全角数字+全角コロン');
  assert.equal(normalizeExtractedRow({ ...base, start: '９:００' }).row.start, '09:00', '全角数字+半角コロン');
  assert.equal(normalizeExtractedRow({ ...base, start: '１９:00' }).row.start, '19:00', '全角と半角の混在');
  assert.equal(normalizeExtractedRow({ ...base, start: '　19:00　' }).row.start, '19:00', '全角スペース');

  // 既に正しい値は触らない(= notes が出ない。無意味なログを増やさない)
  const ok = normalizeExtractedRow({ ...base, start: '19:00' });
  assert.equal(ok.row.start, '19:00');
  assert.deepEqual(ok.notes, []);
});

// 直すのは【書式の揺れ】だけで、【記法の翻訳】はしない。`7pm`→`19:00` も一意に決まるが、
// 翻訳ルールを1つ足すごとに「誤った開始時刻を公開する」経路が増える(開始時刻の誤りは
// プレイヤーが違う時間に店へ行く実害で、「大会が1件載らない」より重い)。
// 実測(破棄ログ・lastExtraction.normalized)で頻度が分かってから足す、が正しい手順。
test('normalizeExtractedRow: 記法が違う/範囲外の start は直さない(=検査で破棄される)', () => {
  const base = { date: '2026-09-05', name: 'マンデー' };
  for (const start of ['25:00', '19:70', '7pm', '７pm', '19時', '１９時', '午後7時', '19:00\n<b>', '1900']) {
    const { row, notes } = normalizeExtractedRow({ ...base, start });
    assert.equal(row.start, start, `${start} は直さない(記法の翻訳はしない / 範囲外は決められない)`);
    assert.deepEqual(notes, []);
    assert.ok(extractedRowProblem(row), `${start} は検査で破棄されること`);
  }
});

// NFKC は start にだけかける。name/prize/tags にかけると大会名の全角英字まで半角化してしまい、
// それは「店の表記を書き換える」行為(書式の揺れの補正ではない)。
test('normalizeExtractedRow: NFKCは start 以外のフィールドに波及しない', () => {
  const input = {
    date: '2026-09-05',
    name: 'ＷＳＯＰ ＭＡＩＮ①',       // 全角英字・囲み数字を含む大会名
    start: '１９：００',
    prize: '１位 ￥１０，０００',
    tags: ['ＮＬＨ', 'ターボ'],
  };
  const { row } = normalizeExtractedRow(input);
  assert.equal(row.start, '19:00', 'start は正規化される');
  assert.equal(row.name, 'ＷＳＯＰ ＭＡＩＮ①', '大会名は1文字も変えない');
  assert.equal(row.prize, '１位 ￥１０，０００', 'prize も変えない');
  assert.deepEqual(row.tags, ['ＮＬＨ', 'ターボ'], 'tags も変えない');
});

// 採用する値は「NFKC後の文字列そのもの」ではなく「正規表現が捕まえた数字から組み立て直した値」。
// そのため NFKC が想定外の変換をしても、data.js に入るのは常に `\d{2}:\d{2}` の形に限られる。
test('normalizeExtractedRow: 採用されるstartは常に半角数字とコロンだけで組み立てられる', () => {
  const base = { date: '2026-09-05', name: 'マンデー' };
  for (const start of ['9:00', '１９：００', '　7:30　', '⑤:00']) {
    const { row } = normalizeExtractedRow({ ...base, start });
    if (row.start !== start) assert.match(row.start, /^\d{2}:\d{2}$/, `${start} → ${row.start}`);
  }
});

test('normalizeExtractedRow: 数値として読めない金額はその項目だけ null にし、行は残す', () => {
  const base = { date: '2026-09-05', name: 'マンデー', start: '19:00' };

  const a = normalizeExtractedRow({ ...base, buyin: '3,500' });
  assert.equal(a.row.buyin, null);
  assert.equal(a.row.name, 'マンデー', '行の他の項目は残ること');
  assert.equal(extractedRowProblem(a.row), null, '金額1項目のために行を捨てないこと');
  assert.deepEqual(a.notes.map((n) => [n.field, n.from, n.to]), [['buyin', '3,500', null]]);

  assert.equal(normalizeExtractedRow({ ...base, buyin: '5000円' }).row.buyin, null);
  assert.equal(normalizeExtractedRow({ ...base, stack: '20k' }).row.stack, null);
  assert.equal(normalizeExtractedRow({ ...base, addon: '無料' }).row.addon, null);
  assert.equal(normalizeExtractedRow({ ...base, guarantee: '10万' }).row.guarantee, null);
  // 空文字は Number('') が 0 になり「不明」が「無料」に化ける。null に倒すこと
  assert.equal(normalizeExtractedRow({ ...base, buyin: '' }).row.buyin, null);

  // 読める値・null は触らない
  const keep = normalizeExtractedRow({ ...base, buyin: 3000, addon: '2000', guarantee: null });
  assert.equal(keep.row.buyin, 3000);
  assert.equal(keep.row.addon, '2000');
  assert.deepEqual(keep.notes, []);
});

test('normalizeExtractedRow: 入力を書き換えない / オブジェクトでない入力はそのまま返す', () => {
  const input = { date: '2026-09-05', name: 'マンデー', start: '9:00', buyin: '3,500' };
  const { row } = normalizeExtractedRow(input);
  assert.equal(input.start, '9:00', '呼び出し側の元データを壊さないこと');
  assert.equal(input.buyin, '3,500');
  assert.notEqual(row, input);

  assert.deepEqual(normalizeExtractedRow(null), { row: null, notes: [] });
  assert.deepEqual(normalizeExtractedRow('ただの文字列'), { row: 'ただの文字列', notes: [] });
});

// 数値にならない値は Number() で NaN になり、JSON化で null に化けて【価格情報が無言で消える】。
test('extractedRowProblem: 数値フィールドが数値として読めない行を弾く', () => {
  const base = { date: '2026-09-05', name: 'マンデー' };
  assert.equal(extractedRowProblem({ ...base, buyin: 3000 }), null);
  assert.equal(extractedRowProblem({ ...base, buyin: '3000' }), null, '数字だけの文字列は Number() で通る');
  assert.equal(extractedRowProblem({ ...base, buyin: null, guarantee: null }), null, 'null は「読み取れなかった」の正しい表現');
  assert.match(extractedRowProblem({ ...base, buyin: '3,500' }), /buyin が数値として読めない/);
  assert.match(extractedRowProblem({ ...base, stack: '20k' }), /stack が数値として読めない/);
  assert.match(extractedRowProblem({ ...base, addon: '無料' }), /addon が数値として読めない/);
  assert.match(extractedRowProblem({ ...base, guarantee: '10万' }), /guarantee が数値として読めない/);
  assert.match(extractedRowProblem({ ...base, buyin: '' }), /buyin が数値として読めない/, '空文字は Number() で 0 になるので弾く');
});

// 行を跨ぐ検査。コミット前ゲートは id重複も見るが、それは1行だけでは判定できないので
// extractedRowProblem には入っていない(呼び出し側が集合を持ってこちらを呼ぶ)。
test('duplicateIdProblem: 同じidの2件目と、既存の別スロットとの衝突を検出する', () => {
  const entry = { id: 'ig-v18-2026-09-12-1900-nlh', date: '2026-09-12', start: '19:00' };
  const used = new Set();
  assert.equal(duplicateIdProblem(entry, used, null), null);
  used.add(entry.id);
  assert.match(duplicateIdProblem(entry, used, null).reason, /同じidの行が重複/);

  // 既存 data.js 側に同じidで別の(date,start)がある場合(mergeStoreはスロット一致でしか置き換えない)
  const slots = new Map([[entry.id, '2026-09-13 20:00']]);
  assert.match(duplicateIdProblem(entry, new Set(), slots).reason, /既存エントリと id が衝突/);
  // 同じスロットなら既存が置き換わるので衝突しない
  assert.equal(duplicateIdProblem(entry, new Set(), new Map([[entry.id, '2026-09-12 19:00']])), null);
});

// 呼び出し側は「内容が失われた重複」と「既に取り込めている重複(店の再投稿)」を区別して
// 扱う(前者だけを ::error:: の異常にする)。理由の文面で見分けると文言修正で静かに壊れるため、
// 機械可読な kind を返すことをここで固定する。
test('duplicateIdProblem: 重複の種類(kind)を返す', () => {
  const entry = { id: 'ig-v18-2026-09-12-1900-nlh', date: '2026-09-12', start: '19:00' };
  assert.equal(duplicateIdProblem(entry, new Set([entry.id]), null).kind, 'duplicate-in-run');
  assert.equal(
    duplicateIdProblem(entry, new Set(), new Map([[entry.id, '2026-09-13 20:00']])).kind,
    'existing-slot-conflict'
  );
});
