'use strict';

/**
 * readme-consistency.test.js — README の「数えた主張」が実物と合っているかを固定する。
 *
 * 【なぜ文書にテストを掛けるか】
 *   この案件は「文書が事実と違うことを書いた」を理由にPRを3回差し戻している。
 *   cron を有効化すると人の目視が消え、判断材料は README だけになる。そこで
 *   【README が数えている物の実体が同じ数であること】を機械で固定する。
 *
 * 【何を見ないか】文章の正しさは見ない。見るのは次の2つだけ:
 *   1. リスク台帳の「状態の内訳」表の件数が、一覧表に実際に並んでいる状態記号の数と一致すること
 *      → ★欠番4件(#3/#6/#8/#9)が「未評価」として数に残り続けることを固定する。
 *        要約から静かに消えて「問題なし」に数え込まれるのを防ぐ。
 *   2. ワークフロー層監査の表が数えている exit 文の数が、実際のワークフローの数と一致すること
 *      → 停止点が増えたのに監査表が「全数」と名乗り続けるのを防ぐ。
 *
 * 【落ちたときの直し方】★★ここが一番大事★★
 *   数が合わないのは、たいてい「実物を変えたが README を直していない」。
 *   **README の該当表を実物に合わせて直すこと。** 逆(実物を数に合わせる)は絶対にしない。
 *   **このテストを緩めて通さないこと。** 緩めた瞬間、README の監査表は「全数」を名乗ったまま
 *   実態とずれ、cron 後に唯一の判断材料が嘘になる。
 *
 *   ▼ 落ちる場面は【近日中に確実に発生する】
 *     - ワークフローにステップ・exit・外部コマンドを足したとき
 *       （例: Instagram監視に探索専用モード --probe をワークフローから渡す作業が控えている）
 *       → `node tools/workflow-audit.js inventory` を実行し、出た数で README の表を直す。
 *         停止点が増えたなら「ワークフロー層の停止点の全数監査」の【表の行】も足すこと
 *         （数だけ合わせて行を足さないと、全数と名乗る根拠が消える）
 *     - リスク台帳に番号を足したとき（並行PRとのマージを含む）
 *       → 「状態の内訳」表の件数・番号・合計を、一覧表の実際の行に合わせて直す。
 *         ★このテストは合計をハードコードしていない。README の【2つの表を突き合わせている】ので、
 *           番号がいくつ増えても「両方を直せば」通る。片方だけ直すと落ちる、が仕様
 *
 * 【意図的にハードコードしている唯一の値】
 *   欠番 #3 / #6 / #8 / #9 が「❓ 未評価」であること。これは【守りたい主張そのもの】なので、
 *   実物から導出せずに書いてある。内容が判明して実際に評価したときだけ、
 *   このテストを【意図して】書き換えること（うっかりでは変えられない形にしてある）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// ============================================================
// 1. リスク台帳: 「状態の内訳」の件数 ↔ 一覧表の実際の状態記号
// ============================================================

/** 一覧表の各行 `| **#12** | … | 🔴 未了・cron阻害 | … |` から番号と状態記号を拾う。 */
function ledgerRows() {
  const rows = [];
  // 【README全体を走査してはいけない】`| **#35** | …` の形は台帳以外の表にも現れる
  // (例: 定型「検知器を試したら配線にも変異を当てる」の PR 一覧)。全体を走査すると
  // 台帳の行数が水増しされ、内訳表を正しく直しても落ち続ける。実際に PR #39 と #40 を
  // マージした時点で 25行 → 28行 と誤認して落ちた。台帳の「### 一覧」節に限定する。
  const start = README.indexOf('### 一覧');
  assert.ok(start >= 0, '台帳の「### 一覧」節が見つかりません(見出しを変えたらこのテストも直すこと)');
  const after = README.slice(start + 1);
  const endRel = after.indexOf('\n## ');
  const section = endRel >= 0 ? after.slice(0, endRel) : after;
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*\*\*#(\d+)\*\*\s*\|(.*)$/);
    if (!m) continue;
    const cells = m[2].split('|');
    // cells[0]=項目 / cells[1]=状態 / cells[2]=理由
    const state = (cells[1] || '').trim();
    const sym = ['✅', '🟡', '🔴', '⚪', '❓'].find((s) => state.startsWith(s));
    rows.push({ n: Number(m[1]), state, sym });
  }
  return rows;
}

/** 「状態の内訳」表 `| ✅ 解消済み | **6** | #5 #7 … |` を読む。 */
function breakdown() {
  const out = [];
  const sect = README.split('### 状態の内訳')[1];
  assert.ok(sect, 'README に「### 状態の内訳」の節がありません');
  for (const line of sect.split('\n### ')[0].split('\n')) {
    const m = line.match(/^\|\s*\*{0,2}(✅|🟡|🔴|⚪|❓)([^|]*)\|\s*\*{0,2}(\d+)\*{0,2}\s*\|([^|]*)\|/);
    if (m) out.push({ sym: m[1], count: Number(m[3]), numbers: (m[4].match(/#(\d+)/g) || []).map((s) => Number(s.slice(1))) });
    const tot = line.match(/^\|\s*\*\*合計\*\*\s*\|\s*\*\*(\d+)\*\*/);
    if (tot) out.push({ sym: '合計', count: Number(tot[1]), numbers: [] });
  }
  return out;
}

test('リスク台帳: 「状態の内訳」の件数が、一覧表に実在する状態記号の数と一致する', () => {
  const rows = ledgerRows();
  assert.ok(rows.length >= 21, `一覧表の行を読み取れていません(${rows.length}行)`);
  const bd = breakdown();
  assert.ok(bd.length >= 5, `内訳表を読み取れていません(${bd.length}行)`);

  // 【合計は3方向で一致させる】一覧表の行数 ＝ 内訳の各状態の和 ＝ 内訳の「合計」。
  //   行数としか比べないと、状態別の件数が入れ替わっても合計だけ合ってしまう。
  const total = bd.find((b) => b.sym === '合計');
  assert.ok(total, '内訳表に「合計」の行がありません');
  const sum = bd.filter((b) => b.sym !== '合計').reduce((a, b) => a + b.count, 0);
  assert.equal(sum, total.count,
    `内訳の各状態の和(${sum}) と 内訳の「合計」(${total.count}) が違います。表の中で足し算が合っていません`);

  for (const b of bd) {
    if (b.sym === '合計') {
      assert.equal(b.count, rows.length,
        `内訳の「合計」(${b.count}) と 一覧表の行数(${rows.length}) が違います。番号を足したら内訳表も直すこと`);
      continue;
    }
    const actual = rows.filter((r) => r.sym === b.sym);
    assert.equal(actual.length, b.count,
      `内訳の ${b.sym} が ${b.count}件 と書かれていますが、一覧表には ${actual.length}件 あります` +
      `（実際: ${actual.map((r) => '#' + r.n).join(' ') || 'なし'}）`);
    // 番号まで書いてある行は、番号の集合も一致させる(件数だけ合わせて中身が入れ替わるのを防ぐ)
    if (b.numbers.length) {
      assert.deepEqual(b.numbers.slice().sort((x, y) => x - y), actual.map((r) => r.n).sort((x, y) => x - y),
        `内訳の ${b.sym} に並んでいる番号と、一覧表で実際にその状態になっている番号が違います`);
    }
  }
});

test('リスク台帳: 欠番4件(#3/#6/#8/#9)が「❓ 未評価」として件数に残っている', () => {
  // 【この案件で実際に指摘された読み違い】「🔴 は2件」という要約が、
  // 内容の分からない4件を暗黙に「問題なし」の側へ数え込む形になっていた。
  // 埋めない判断は正しいが、【埋まっていないと分かること】は別に要る。
  const rows = ledgerRows();
  for (const n of [3, 6, 8, 9]) {
    const r = rows.find((x) => x.n === n);
    assert.ok(r, `リスク台帳に #${n} の行がありません`);
    assert.equal(r.sym, '❓', `#${n} が「❓ 未評価」以外になっています（現在: ${r.state}）。` +
      '内容が判明して実際に評価したのでなければ、状態を変えないこと');
  }
  const bd = breakdown().find((b) => b.sym === '❓');
  assert.ok(bd, '内訳表に「❓ 未評価」の行がありません（欠番が要約から消えています）');
  assert.equal(bd.count, 4, `内訳の「❓ 未評価」が ${bd.count}件 になっています（期待: 4件）`);
});

// ============================================================
// 2. ワークフロー層監査: exit 文の数
// ============================================================

/** ワークフローYAMLから run: ブロックを逐語で取り出す（audit と同じ読み方）。 */
function runBlocks(ymlPath) {
  const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const one = lines[i].match(/^(\s*)run:\s*(?!\|)(\S.*?)\s*$/);
    if (one) { blocks.push(one[2] + '\n'); continue; }
    const rm = lines[i].match(/^(\s*)run:\s*\|\s*$/);
    if (!rm) continue;
    const runIndent = rm[1].length;
    const body = [];
    let j = i + 1;
    let bodyIndent = null;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(''); continue; }
      const ind = l.match(/^\s*/)[0].length;
      if (bodyIndent === null) bodyIndent = ind;
      if (ind <= runIndent) break;
      body.push(l.slice(bodyIndent));
    }
    blocks.push(body.join('\n') + '\n');
    i = j - 1;
  }
  return blocks;
}

function countExits(ymlPath) {
  let total = 0;
  let nonZero = 0;
  for (const body of runBlocks(ymlPath)) {
    for (const raw of body.split('\n')) {
      const t = raw.trim();
      if (t.startsWith('#')) continue;                 // コメント行の exit は数えない
      const m = t.match(/^exit\s+("?\$?[A-Za-z_{}0-9"]+"?)/);
      if (!m) continue;
      total += 1;
      if (m[1] !== '0') nonZero += 1;                  // `exit "$rc"` は非0になりうるので非0に数える
    }
  }
  return { total, nonZero };
}

/** README のワークフロー監査表 `| \`.github/workflows/x.yml\` | 6 | 2 | 4 | **4** | 2（…） |` を読む。 */
function auditTable() {
  const out = {};
  for (const line of README.split('\n')) {
    const m = line.match(/^\|\s*`(\.github\/workflows\/[\w-]+\.yml)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\*\*(\d+)\*\*\s*\|\s*(\d+)/);
    if (m) out[m[1]] = { steps: +m[2], uses: +m[3], runs: +m[4], exits: +m[5], nonZero: +m[6] };
  }
  return out;
}

test('ワークフロー層監査: README の表の exit 文の数が、実際のワークフローと一致する', () => {
  const table = auditTable();
  const files = Object.keys(table);
  assert.equal(files.length, 2, `README のワークフロー監査表を2本ぶん読み取れていません(${files.length}本)`);

  for (const rel of files) {
    const p = path.join(ROOT, rel);
    assert.ok(fs.existsSync(p), `${rel} がありません`);
    const actual = countExits(p);
    const said = table[rel];
    assert.equal(actual.total, said.exits,
      `${rel} の exit 文は実際には ${actual.total}個ですが、README の表は ${said.exits}個 と書いています。` +
      '停止点を足したら「ワークフロー層の停止点の全数監査」の表も直すこと（全数と名乗っているため）。' +
      '★テストを緩めて通さないこと。緩めると監査表は「全数」を名乗ったまま実態とずれる');
    assert.equal(actual.nonZero, said.nonZero,
      `${rel} の非0の exit 文は実際には ${actual.nonZero}個ですが、README の表は ${said.nonZero}個 と書いています`);
  }
});

/**
 * README の外部コマンド数の表
 *   | `import-waitinglist.yml` | 5 | 12 | 0 | 0 | 0 | 0 | 2 |
 * を読む。数え方は README に書いてある規則（コメント行を除いた run: 本文の「コマンド名＋空白」）。
 */
const CMD_ORDER = ['node', 'git', 'grep', 'sed', 'tee', 'cat', 'date'];

function commandTable() {
  const out = {};
  for (const line of README.split('\n')) {
    const m = line.match(/^\|\s*`([\w-]+\.yml)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
    if (!m) continue;
    const counts = {};
    CMD_ORDER.forEach((c, i) => { counts[c] = Number(m[i + 2]); });
    out[m[1]] = counts;
  }
  return out;
}

function countCommands(ymlPath) {
  const counts = Object.fromEntries(CMD_ORDER.map((c) => [c, 0]));
  for (const body of runBlocks(ymlPath)) {
    for (const raw of body.split('\n')) {
      const t = raw.trim();
      if (t.startsWith('#')) continue;
      for (const c of CMD_ORDER) counts[c] += (t.match(new RegExp(`\\b${c}\\s`, 'g')) || []).length;
    }
  }
  return counts;
}

test('ワークフロー層監査: README の外部コマンド数の表が実際と一致する', () => {
  const table = commandTable();
  assert.equal(Object.keys(table).length, 2,
    `README の外部コマンド数の表を2本ぶん読み取れていません(${Object.keys(table).length}本)`);
  for (const [base, said] of Object.entries(table)) {
    const p = path.join(ROOT, '.github', 'workflows', base);
    assert.ok(fs.existsSync(p), `${base} がありません`);
    const actual = countCommands(p);
    assert.deepEqual(actual, said,
      `${base} の外部コマンド数が README の表と違います。\n` +
      `  実際  : ${JSON.stringify(actual)}\n` +
      `  README: ${JSON.stringify(said)}\n` +
      '  → `node tools/workflow-audit.js inventory` を実行して表を実際の値に直すこと');
  }
});

test('ワークフロー層監査: README の表のステップ数・uses/run の数が実際と一致する', () => {
  const table = auditTable();
  for (const [rel, said] of Object.entries(table)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const steps = (src.match(/^\s+- name:/gm) || []).length;
    const uses = (src.match(/^\s+uses:/gm) || []).length;
    const runs = (src.match(/^\s+run:/gm) || []).length;
    assert.equal(steps, said.steps, `${rel} のステップ数が違います（実際 ${steps} / README ${said.steps}）`);
    assert.equal(uses, said.uses, `${rel} の uses: の数が違います（実際 ${uses} / README ${said.uses}）`);
    assert.equal(runs, said.runs, `${rel} の run: の数が違います（実際 ${runs} / README ${said.runs}）`);
  }
});
