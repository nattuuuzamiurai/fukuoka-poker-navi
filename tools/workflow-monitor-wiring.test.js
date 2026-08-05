'use strict';
/**
 * .github/workflows/monitor-instagram-apify.yml の【配線】を機械的に確かめる。
 *
 * ============================================================
 * 【なぜ実行ではなく構造(データフロー)で見るのか】
 * ============================================================
 * このワークフローで最も危険な失敗は【本番実行のコマンドに `--probe` が付くこと】である。
 * `--probe` は `--dry-run` を含むので、混ざった回は「本番のつもりで何も書かない」実行になり、
 * `::error::` も出ないまま毎日グリーンで data.js が更新されなくなる
 * (リスク台帳 #22 と同じ「静かな永久停止」で、しかも毎日緑)。
 *
 * ★【1回実行して「今回は本番だった」を見ても、結合していないことの反証にはならない】★
 *   結合していても、その回の入力ではたまたま正しく動く。だから確かめるのは
 *   「その回の結果」ではなく【判定が互いの変数に依存していないこと】= データフローである。
 *
 * ============================================================
 * 【この検査が守っている3点】
 * ============================================================
 *   1. `probe` の判定区間が `dry_run` / `INPUT_DRY_RUN` を参照しない(逆も同じ)
 *   2. `probe=true` かつ `dry_run=false` の組み合わせは実行前に停止する
 *   3. `--probe` は実行コマンドとしては1箇所にしか現れず、その行は本番の行ではない
 *
 * 【区間の目印は load-bearing】ワークフロー側の
 *   `# ---- dry_run の判定(ここから) ----` … `(ここまで) ----`
 *   `# ---- probe の判定(ここから) ----`   … `(ここまで) ----`
 * はこの検査が使っている。消すとここが落ちる(黙って通ることはない)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'monitor-instagram-apify.yml');
const src = fs.readFileSync(WORKFLOW, 'utf8');

/** `# ---- <名前>(ここから) ----` 〜 `# ---- <名前>(ここまで) ----` を切り出す。 */
function section(name) {
  const from = src.indexOf(`# ---- ${name}(ここから) ----`);
  const to = src.indexOf(`# ---- ${name}(ここまで) ----`);
  assert.ok(from >= 0, `区間の始まりが見つからない: ${name}(目印を消さないこと)`);
  assert.ok(to > from, `区間の終わりが見つからない: ${name}`);
  return src.slice(from, to);
}

/** コメント行を除いた実コード行だけにする(コメントで相手の名前に触れるのは許す)。 */
function codeOnly(block) {
  return block
    .split('\n')
    .map((l) => l.replace(/^\s+/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .join('\n');
}

test('★配線: probe の判定は dry_run を参照しない(同じ変数から導かれていないこと)', () => {
  const probeCode = codeOnly(section('probe の判定'));
  assert.ok(probeCode.includes('probe='), 'probe を決めている区間であること(テストの前提)');
  for (const forbidden of ['dry_run', 'DRY_RUN', 'INPUT_DRY_RUN']) {
    assert.equal(
      probeCode.includes(forbidden),
      false,
      `probe の判定が ${forbidden} に依存している。` +
        '結合すると「本番のつもりで --probe が付く」= 静かな永久停止(毎日緑)が起きる。\n' +
        `--- 実際の区間 ---\n${probeCode}`
    );
  }
});

test('★配線: dry_run の判定は probe を参照しない(逆向きの結合も無いこと)', () => {
  const dryCode = codeOnly(section('dry_run の判定'));
  assert.ok(dryCode.includes('dry_run='), 'dry_run を決めている区間であること(テストの前提)');
  for (const forbidden of ['probe', 'PROBE', 'INPUT_PROBE']) {
    assert.equal(
      dryCode.includes(forbidden),
      false,
      `dry_run の判定が ${forbidden} に依存している。\n--- 実際の区間 ---\n${dryCode}`
    );
  }
});

test('★配線: probe は「明示的に true」のときだけ、かつ手動実行のときだけ立つ', () => {
  const probeCode = codeOnly(section('probe の判定'));
  // 既定は「探索しない」。空文字・想定外の値・schedule はすべて false に倒れること。
  assert.match(probeCode, /INPUT_PROBE"?\s*=\s*"true"/, '明示的に true のときだけ探索にすること');
  assert.match(probeCode, /EVENT_NAME"?\s*=\s*"workflow_dispatch"/, '定期実行が探索になる経路を作らないこと');
  assert.match(probeCode, /probe=false/, '既定(else)で false に倒すこと');
});

test('★配線: probe と本番(dry_run=false)の組み合わせは実行前に停止する', () => {
  // どちらかに倒して続行しないこと。「本番のつもりが探索」も「探索のつもりが本番」も起こさない。
  const guard = src.match(/if \[ "\$probe" = "true" \] && \[ "\$dry_run" = "false" \]; then[\s\S]{0,600}?fi/);
  assert.ok(guard, 'probe と本番の同時指定を止めるガードが見つからない');
  assert.match(guard[0], /::error title=/, '止めた理由を注記で出すこと');
  assert.match(guard[0], /exit 1/, '続行せずに終了すること');
});

test('★配線: --probe は実行コマンドとして1箇所にしかなく、本番の行には引数が付かない', () => {
  const runLines = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('node tools/monitor-instagram-apify.js'));
  // 探索 / dry-run / 本番 の3本だけであること
  assert.equal(runLines.length, 3, `実行行が3本でない: ${JSON.stringify(runLines)}`);
  const probeRuns = runLines.filter((l) => l.includes('--probe'));
  assert.equal(probeRuns.length, 1, '--probe を付ける実行行は1本だけであること');
  assert.equal(probeRuns[0].includes('--dry-run'), false, '同じ行に --dry-run を混ぜないこと');

  // 本番の行 = 引数が1つも付かない行。ここに --probe が現れたら静かな永久停止になる。
  const prodRuns = runLines.filter((l) => !l.includes('--'));
  assert.equal(prodRuns.length, 1, `引数なし(本番)の実行行が1本だけであること: ${JSON.stringify(runLines)}`);
  assert.equal(prodRuns[0].includes('probe'), false, '本番の行に probe の文字が現れてはいけない');

  // 分岐の条件そのものも確認する: 探索は PROBE、それ以外は DRY_RUN で分かれる
  assert.match(src, /if \[ "\$PROBE" = "true" \]; then\s*\n\s*node tools\/monitor-instagram-apify\.js --probe/);
  assert.match(src, /elif \[ "\$DRY_RUN" = "true" \]; then\s*\n\s*node tools\/monitor-instagram-apify\.js --dry-run/);
});

test('★配線: 探索の完走確認ステップが always() で走り、不完全ならジョブを赤くする', () => {
  // 直前のステップがタイムアウトで失敗しても、この確認は必ず走る必要がある
  // (走らないと「部分的な分布」が緑のまま残り、全投稿を見たと誤読される)。
  assert.match(src, /if: always\(\) && steps\.mode\.outputs\.probe == 'true'/, 'always() で走る条件になっていない');
  assert.match(src, /grep -q '探索の完了状態:'/, '完走マーカーの有無を見ていない');
  assert.match(src, /★不完全/, '不完全の場合を見ていない');
  // マーカーが無い場合・不完全の場合の両方で exit 1 すること
  const step = src.slice(src.indexOf('- name: 探索が最後まで走ったかを確認'), src.indexOf('# 壊れた data.js をコミット'));
  assert.equal((step.match(/exit 1/g) || []).length >= 3, true, `不完全な場合に必ず落とすこと: ${step}`);
});

test('★配線: 探索のときだけタイムアウトを延ばし、ステップ側をジョブ側より短くする', () => {
  // ステップ側が先に切れることで、打ち切りが【ステップの失敗】になり
  // always() の完走確認が確実に走る(ジョブごとキャンセルより確実)。
  const job = src.match(/timeout-minutes: \$\{\{ github\.event\.inputs\.probe == 'true' && (\d+) \|\| (\d+) \}\}/g);
  assert.ok(job && job.length === 2, `ジョブとステップの両方に条件付きの上限を置くこと: ${JSON.stringify(job)}`);
  const nums = job.map((m) => m.match(/(\d+) \|\| (\d+)/).slice(1, 3).map(Number));
  const [jobProbe, jobNormal] = nums[0];
  const [stepProbe, stepNormal] = nums[1];
  assert.ok(stepProbe < jobProbe, `探索: ステップ(${stepProbe})はジョブ(${jobProbe})より短いこと`);
  assert.ok(stepNormal < jobNormal, `通常: ステップ(${stepNormal})はジョブ(${jobNormal})より短いこと`);
  assert.ok(jobProbe > jobNormal, '探索の上限は通常より長いこと(全投稿を Vision に渡すため)');
});

test('★配線: 手動実行の入力に probe があり、既定は「探索しない」', () => {
  const inputs = src.slice(src.indexOf('  workflow_dispatch:'), src.indexOf('permissions:'));
  assert.match(inputs, /^\s{6}probe:$/m, 'workflow_dispatch の入力に probe が無い');
  // dry_run(既定 true)と probe(既定 false)がそれぞれ安全側に倒れていること
  const probeBlock = inputs.slice(inputs.indexOf('      probe:'));
  assert.match(probeBlock, /default: false/, '既定で探索してはいけない(うっかりは安全側に倒す)');
});

test('★スクリプト側: --probe は受け付ける引数として登録されている', () => {
  // ワークフローが渡すフラグが KNOWN_FLAGS に無いと、その日から毎朝 exit 1 で止まる。
  const monitor = require('./monitor-instagram-apify');
  assert.ok(Array.isArray(monitor.STORES), 'モジュールとして読めること');
  const toolSrc = fs.readFileSync(path.join(__dirname, 'monitor-instagram-apify.js'), 'utf8');
  const known = toolSrc.match(/const KNOWN_FLAGS = \[([^\]]*)\]/);
  assert.ok(known, 'KNOWN_FLAGS が見つからない');
  assert.match(known[1], /'--probe'/, 'KNOWN_FLAGS に --probe が無い(渡した日から毎朝止まる)');
  assert.match(known[1], /'--dry-run'/);
});
