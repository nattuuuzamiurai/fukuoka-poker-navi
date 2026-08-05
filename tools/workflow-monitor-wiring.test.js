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

// ============================================================
// 【終了コードの配線】検知器ではなく、そこに値を渡す配線を試す(2026-08-05)
// ============================================================
// 【なぜこのブロックが要るか — この案件で5回目の同じ形】
//   検知(`lossAccounting`)は tools/monitor-instagram-apify.test.js で両方向を固定してある。
//   だが 2026-08-05 の run 30983688525 で実際に壊れていたのは【配線】だった —
//   `::error::` の注記は正しく出ていたのに、ジョブの結論は success だった
//   (`gh run view 30983688525 --json conclusion` → `"conclusion":"success"`)。
//   注記は終了コードを変えないので、**検知器がいくら正しくても緑のまま**になる。
//
// 【やり方】ステップの `run:` 本文を YAML から取り出し、**そのままシェルで実行する**。
//   本文を写したコピーではなく実物を動かすので、YAML 側を書き換えれば必ずここが動く。
const { spawnSync } = require('node:child_process');
const os = require('node:os');

/** `- name: <名前>` のステップの `run: |` 本文を、インデントを外して取り出す。 */
function stepRunScript(name) {
  const at = src.indexOf(`- name: ${name}`);
  assert.ok(at >= 0, `ステップが見つからない: ${name}(名前を変えたらこの検査も直すこと)`);
  const after = src.slice(at);
  const runAt = after.indexOf('run: |');
  assert.ok(runAt >= 0, `${name} に run: | が無い`);
  const body = after.slice(runAt + 'run: |'.length).split('\n').slice(1);
  const out = [];
  for (const line of body) {
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    if (indent < 10) break; // ステップ本文のインデントより浅くなったら終わり
    out.push(line.slice(10));
  }
  const script = out.join('\n');
  assert.ok(script.trim().length > 0, `${name} の run: 本文が空`);
  return script;
}

/** 取り出した本文を、rc ファイルの中身を差し替えて実行する。 */
function runExitWiring(rcContent) {
  const script = stepRunScript('取込みの終了コードをジョブに反映する(取得失敗 / 内容の消失)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-exit-wiring-'));
  try {
    // 実物は /tmp/monitor-rc.txt を読む。テストでは同じパスを使わずに済むよう、
    // 一時ディレクトリのファイルを指すように【パスだけ】置換する(判定ロジックは触らない)。
    const rcPath = path.join(dir, 'monitor-rc.txt');
    if (rcContent !== null) fs.writeFileSync(rcPath, rcContent);
    const patched = script.split('/tmp/monitor-rc.txt').join(rcPath);
    assert.ok(patched.includes(rcPath), 'ステップ本文が /tmp/monitor-rc.txt を読んでいない(配線が変わった)');
    return spawnSync('bash', ['-c', patched], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('★配線(実行): rc=3(内容が失われた)でステップが exit 3 し、注記も出す', () => {
  const r = runExitWiring('3\n');
  assert.equal(r.status, 3, `rc=3 は exit 3 になること(実際: ${r.status} / ${r.stdout}${r.stderr})`);
  assert.match(r.stdout, /::error title=Instagram監視 - 取得できたのに内容が失われました/);
});

test('★配線(実行): rc=2(取得失敗)は従来どおり exit 2 のまま', () => {
  const r = runExitWiring('2\n');
  assert.equal(r.status, 2, `rc=2 は exit 2 のままであること(実際: ${r.status})`);
  assert.match(r.stdout, /一部の店を取得できませんでした/);
});

test('★配線(実行): rc=0 と rc ファイル無しでは緑のまま(赤くなるべきでない回が赤くならない)', () => {
  const zero = runExitWiring('0\n');
  assert.equal(zero.status, 0, `rc=0 は緑であること(実際: ${zero.status} / ${zero.stdout})`);
  assert.doesNotMatch(zero.stdout, /::error/);
  const missing = runExitWiring(null); // 取込みステップが落ちてファイルが無い場合
  assert.equal(missing.status, 0, 'rc ファイルが無い場合は 0 として扱う(前段の失敗はそのまま見せる)');
});

test('★配線: 取込みステップは rc=1 だけ即座に落とし、2/3 は控えて後段に渡す', () => {
  // ここが `if [ "$rc" != "0" ]` などに変わると、rc=2/3 の回で
  // 【取り込めたぶんがコミットされない】(赤いが、データが残らない)。
  const step = src.slice(
    src.indexOf('- name: Instagram新着投稿をApifyで取得し'),
    src.indexOf('- name: 探索が最後まで走ったかを確認')
  );
  assert.match(step, /if \[ "\$rc" = "1" \]; then/, 'rc=1 だけを即座に落とす形であること');
  assert.match(step, /echo "\$rc" > \/tmp\/monitor-rc\.txt/, 'rc を後段に渡していること');
});

test('★配線: スクリプトが出す終了コードの定義と、ワークフローが分岐している値が一致する', () => {
  // 【片方だけ動くのを防ぐ】スクリプトが 3 を返すのに YAML が 3 を見ていない、
  // あるいはその逆になっていたら、検知器は正しいのにジョブは緑のまま。
  const monitor = require('./monitor-instagram-apify');
  const wiring = stepRunScript('取込みの終了コードをジョブに反映する(取得失敗 / 内容の消失)');
  assert.match(wiring, new RegExp(`if \\[ "\\$rc" = "${monitor.LOSS_FAILURE}" \\]`), 'LOSS_FAILURE を見ていない');
  assert.match(wiring, new RegExp(`if \\[ "\\$rc" = "${monitor.PARTIAL_FAILURE}" \\]`), 'PARTIAL_FAILURE を見ていない');
  assert.match(wiring, new RegExp(`exit ${monitor.LOSS_FAILURE}`));
  assert.match(wiring, new RegExp(`exit ${monitor.PARTIAL_FAILURE}`));
});

// ============================================================
// 【実行スケジュール】月末・月初に寄せた cron(2026-08-05・社長指示)
// ============================================================
test('★スケジュール: JST 25日〜翌10日は毎日、期間外は週1回の cron が入っている', () => {
  const crons = [...src.matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1]);
  assert.equal(crons.length, 3, `cron は3本(月末+月初+週1)であること: ${JSON.stringify(crons)}`);
  // UTC 22:10 = JST 翌日07:10。したがって day-of-month は JST より1つ手前になる。
  assert.ok(crons.includes('10 22 24-31 * *'), `JST 25日〜翌1日ぶんが無い: ${JSON.stringify(crons)}`);
  assert.ok(crons.includes('10 22 1-9 * *'), `JST 2日〜10日ぶんが無い: ${JSON.stringify(crons)}`);
  assert.ok(
    crons.some((c) => /^10 22 \* \* [0-6]$/.test(c)),
    `期間外の保険(週1)が無い: ${JSON.stringify(crons)}`
  );
  for (const c of crons) assert.match(c, /^10 22 /, `実行時刻は07:10 JST に揃えること: ${c}`);
});

test('★スケジュール: 実測した「カレンダーが出る日」を1日も取りこぼさない(境界)', () => {
  // 実測(run 30963380537 の全71投稿): 月Mのカレンダーの初出は 前月25日 が最も早い。
  // cron の day-of-month は UTC なので、JST の日から1を引いた値が含まれていること。
  const crons = [...src.matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1]);
  /** その cron が UTC の day-of-month d にマッチするか(day-of-week は * のもののみ対象)。 */
  const utcDays = new Set();
  for (const c of crons) {
    const [, , dom, , dow] = c.split(' ');
    if (dow !== '*') continue; // 週1の保険は曜日で回るので日付判定の対象外
    for (const part of dom.split(',')) {
      const m = part.match(/^(\d+)-(\d+)$/);
      if (m) for (let d = Number(m[1]); d <= Number(m[2]); d++) utcDays.add(d);
      else if (/^\d+$/.test(part)) utcDays.add(Number(part));
    }
  }
  // JST 25日 → UTC 24日、JST 10日 → UTC 9日
  for (const jstDay of [25, 26, 27, 28, 29, 30, 31]) {
    assert.ok(utcDays.has(jstDay - 1), `JST ${jstDay}日の実行が無い(UTC ${jstDay - 1}日)`);
  }
  for (const jstDay of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const utcDay = jstDay === 1 ? 31 : jstDay - 1;
    assert.ok(utcDays.has(utcDay), `JST ${jstDay}日の実行が無い(UTC ${utcDay}日)`);
  }
  // 【逆向き】期間外(JST 11〜24日)は日付指定では走らないこと(=間引けていること)
  for (const jstDay of [12, 15, 20, 24]) {
    assert.equal(utcDays.has(jstDay - 1), false, `JST ${jstDay}日は日付指定では走らないこと(週1の保険のみ)`);
  }
});

test('★スクリプト側: --recapture は受け付ける引数として登録されている', () => {
  // README が案内する解除手段が、スクリプト側で拒否されないこと。
  const toolSrc = fs.readFileSync(path.join(__dirname, 'monitor-instagram-apify.js'), 'utf8');
  assert.match(toolSrc, /const RECAPTURE_PREFIX = '--recapture='/);
  const monitor = require('./monitor-instagram-apify');
  assert.equal(monitor.parseRecaptureArg([`--recapture=${monitor.STORES[0].venueId}`], monitor.STORES).ids.size, 1);
});
