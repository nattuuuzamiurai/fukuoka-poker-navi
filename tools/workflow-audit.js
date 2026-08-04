#!/usr/bin/env node
'use strict';

/**
 * workflow-audit.js — ワークフロー層の停止点・回復可能性・ロールバック手順を【実測】する。
 *
 * README の「ワークフロー層の停止点の全数監査」と「cron を止める・戻す手順（ロールバック）」に
 * 書いてある数字は、このスクリプトの出力である。読み直す人が同じ物を再現できるように置いてある。
 *
 * 【何をするか】
 *   ワークフローYAMLから `run:` ブロックを【逐語で】取り出し、使い捨ての git リポジトリ
 *   （bare の origin 付き・いまの作業ツリーを丸ごと写したもの）の中で、
 *   GitHub Actions と同じシェル `bash -e {0}` で実行する。
 *   （両ワークフローとも `shell:` を書いていないので Linux ランナーの既定はこれ。pipefail は付かない）
 *
 * 【何をしないか — 安全側の約束】
 *   - GitHub Actions を起動しない。`gh workflow enable` / `gh workflow run` を呼ばない
 *   - 本物の Waitinglist API を叩かない（`fetch` を差し替える）
 *   - 本物の `data.js` を書き換えない（すべて os.tmpdir() の使い捨てディレクトリ内）
 *   - Instagram監視の本体は【サンドボックス内のコピーだけ】を終了コードを選べる代替に置き換える。
 *     リポジトリの tools/monitor-instagram-apify.js は読むだけで一切変更しない
 *
 * 使い方:
 *   node tools/workflow-audit.js inventory   … 停止点の全数(ステップ/exit文)を数える
 *   node tools/workflow-audit.js probe       … コマンド単位で「止まるか/マスクされるか」を測る
 *   node tools/workflow-audit.js recovery    … 2回実行して「翌朝どうなるか」を測る
 *   node tools/workflow-audit.js rollback    … README のロールバック手順をそのまま実行して確かめる
 *   node tools/workflow-audit.js all
 *
 * ★ 実行には数分かかる（サンドボックスを何十回も作り直すため）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const WL_YML = path.join(WF_DIR, 'import-waitinglist.yml');
const IG_YML = path.join(WF_DIR, 'monitor-instagram-apify.yml');

// ============================================================
// YAML から run: ブロックを逐語で取り出す
// ============================================================
function extractRunBlocks(ymlPath) {
  const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
  const blocks = [];
  let curName = null;
  for (let i = 0; i < lines.length; i++) {
    const nm = lines[i].match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (nm) curName = nm[1];
    const one = lines[i].match(/^(\s*)run:\s*(?!\|)(\S.*?)\s*$/);
    if (one) { blocks.push({ name: curName, bodyStartLine: i + 1, body: one[2] + '\n' }); continue; }
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
    while (body.length && body[body.length - 1] === '') body.pop();
    blocks.push({ name: curName, bodyStartLine: i + 2, body: body.join('\n') + '\n' });
    i = j - 1;
  }
  return blocks;
}
const block = (yml, frag) => {
  const found = extractRunBlocks(yml).filter((b) => b.name && b.name.includes(frag));
  if (found.length !== 1) throw new Error(`run: ブロックの特定に失敗: ${frag}（${found.length}件）`);
  return found[0];
};

// ============================================================
// サンドボックス
// ============================================================
// Waitinglist API の差し替え。WL_SCENARIO で応答を切り替える。
//   ok/day1/day2/day3 … 各店40件（実 data.js の未来日は v3=35 / v19=11 件。少なく返すと
//                       【急減ガード】が鳴ってツール層を測ってしまうので多めに返す）
//   partial           … v19 だけ0件（rc=2 になる）
//   all-empty         … 両店0件（rc=1 になる）
const STUB_SRC = `
const S = process.env.WL_SCENARIO || 'ok';
const SHIFT = { day1: 0, day2: 1, day3: 2 }[S] || 0;
const mk = (id, storeId, dayOffset, hhmm) => {
  const d = new Date(Date.now() + dayOffset * 86400e3);
  return {
    id, name: 'サンドボックス大会 ' + S, startAt: d.toISOString().slice(0, 10) + 'T' + hhmm + ':00.000Z',
    registrationFee: 3000 + SHIFT * 100, startingStack: 20000, feature: 'ノーマル', gameRule: 'nlh',
    addons: [], entries: [], store: { displayId: storeId, name: 'store-' + storeId },
  };
};
const ok = (storeId, n) => {
  const list = [];
  for (let i = 0; i < n; i++) list.push(mk(storeId + '-' + (i + SHIFT), storeId, i + 2 + SHIFT, '10:00'));
  return { totalRecords: list.length, tournaments: list };
};
globalThis.fetch = async (url) => {
  const isV3 = String(url).includes('4018492');
  if (S === 'all-empty') return { status: 200, json: async () => ({ totalRecords: 0, tournaments: [] }) };
  if (S === 'partial' && !isV3) return { status: 200, json: async () => ({ totalRecords: 0, tournaments: [] }) };
  return { status: 200, json: async () => ok(isV3 ? '4018492' : '4039056', 40) };
};
`;

const REAL = {};
for (const c of ['git', 'grep', 'sed', 'tee', 'cat', 'date']) {
  REAL[c] = execFileSync('which', [c], { encoding: 'utf8' }).trim();
}

function makeSandbox({ shims = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfaudit-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  fs.mkdirSync(origin);
  g(origin, 'init', '--bare', '-q', '-b', 'main');
  fs.mkdirSync(work);
  execFileSync('/bin/sh', ['-c',
    `cd ${JSON.stringify(ROOT)} && tar cf - --exclude .git . | (cd ${JSON.stringify(work)} && tar xf -)`]);
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', 'user.name', 'seed');
  g(work, 'config', 'user.email', 'seed@example.com');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'seed');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', '-u', 'origin', 'main');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'stub.js'), STUB_SRC);
  const counter = path.join(dir, 'shim-count.txt');
  // FAIL_MATCH に当たった呼び出しだけを失敗させるシム。run: の中身は1文字も書き換えない。
  const failGuard = (label) => `
if [ -n "$FAIL_MATCH" ]; then
  case "$*" in
    *"$FAIL_MATCH"*)
      n=$(command cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)
      n=$((n+1)); echo "$n" > ${JSON.stringify(counter)}
      if [ -z "$FAIL_NTH" ] || [ "$n" = "$FAIL_NTH" ]; then
        echo "SHIM_FAIL(${label}): $*" >&2
        exit 1
      fi
      ;;
  esac
fi
`;
  fs.writeFileSync(path.join(bin, 'node'),
    `#!/bin/sh\n${shims ? failGuard('node') : ''}exec ${process.execPath} -r ${JSON.stringify(path.join(dir, 'stub.js'))} "$@"\n`);
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  if (shims) {
    for (const [name, real] of Object.entries(REAL)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${failGuard(name)}exec ${JSON.stringify(real)} "$@"\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  const seed = execFileSync('git', ['--git-dir', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  return { dir, origin, work, bin, seed };
}

/**
 * Actions と同じシェルで run: ブロックを1回実行する。
 *
 * ★opts.resetOutputs で $GITHUB_OUTPUT を空にしてから走らせる。
 *   Actions では【run ごとに新しいファイル】なので、使い回すと前回の `rc=…` が残り、
 *   次の実行の rc を読み違える(実際にこの取り違えで「rc=2 が2日続く」という
 *   誤った回復判定を1度出している)。ジョブの先頭ステップでは必ず true にすること。
 */
function runBlock(sb, body, env = {}, opts = {}) {
  const sp = path.join(sb.dir, 'step.sh');
  fs.writeFileSync(sp, body);
  const ghOut = path.join(sb.dir, 'gh_output.txt');
  const ghSum = path.join(sb.dir, 'gh_summary.md');
  if (opts.resetOutputs) { fs.writeFileSync(ghOut, ''); fs.writeFileSync(ghSum, ''); }
  for (const f of [ghOut, ghSum]) if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  const r = spawnSync('bash', ['-e', sp], {
    cwd: sb.work, encoding: 'utf8',
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, GITHUB_OUTPUT: ghOut, GITHUB_STEP_SUMMARY: ghSum, ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ghOutput: fs.readFileSync(ghOut, 'utf8') };
}
const sh = (sb, cmd) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: sb.work, encoding: 'utf8', env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}` } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const G = (sb) => (...a) => execFileSync('git', a, { cwd: sb.work, encoding: 'utf8' }).trim();
// safe.bareRepository=explicit がグローバルに効いている環境があるので --git-dir で明示する
const OG = (sb) => (...a) => execFileSync('git', ['--git-dir', sb.origin, ...a], { encoding: 'utf8' }).trim();
const fresh = (sb) => { // 翌朝の新しいランナー(origin から clone し直す)
  fs.rmSync(sb.work, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', sb.origin, sb.work], { encoding: 'utf8' });
};
const drop = (sb) => fs.rmSync(sb.dir, { recursive: true, force: true });

const WL_STEPS = () => [
  { id: 'import', b: block(WL_YML, 'Waitinglist から日程を取得') },
  { id: 'validate', b: block(WL_YML, '出力の妥当性を確認') },
  { id: 'commit', b: block(WL_YML, '差分があればコミット') },
  { id: 'red', b: block(WL_YML, '一部店舗の取得に失敗'), ifRc: '2' },
];
function runWlJob(sb, env) {
  const log = [];
  let rc = null;
  for (const s of WL_STEPS()) {
    if (s.ifRc && rc !== s.ifRc) { log.push(`${s.id}: skipped`); continue; }
    // 先頭ステップで $GITHUB_OUTPUT を空にする(前日ぶんの rc= を読まないため)
    const r = runBlock(sb, s.b.body, env, { resetOutputs: s.id === 'import' });
    if (s.id === 'import') { const m = r.ghOutput.match(/rc=(\d+)/); rc = m ? m[1] : null; }
    log.push(`${s.id}: exit=${r.code}${s.id === 'import' ? `(rc=${rc})` : ''}`);
    if (r.code !== 0) return { ok: false, failedAt: s.id, code: r.code, log, out: r.stdout + r.stderr };
  }
  return { ok: true, log };
}
const botCount = (sb) => {
  const out = execFileSync('git', ['--git-dir', sb.origin, 'log', '--author=github-actions', '--oneline'], { encoding: 'utf8' });
  return out.trim() ? out.trim().split('\n').length : 0;
};

// ============================================================
// inventory
// ============================================================
function inventory() {
  console.log('===== 停止点の全数（README のワークフロー監査表の元データ）=====');
  for (const yml of [WL_YML, IG_YML]) {
    const src = fs.readFileSync(yml, 'utf8');
    const exits = [];
    for (const b of extractRunBlocks(yml)) {
      b.body.split('\n').forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith('#')) return;
        const m = t.match(/^exit\s+("?\$?[A-Za-z_{}0-9"]+"?)/);
        if (m) exits.push({ line: b.bodyStartLine + i, text: t, zero: m[1] === '0', step: b.name });
      });
    }
    console.log(`\n--- ${path.relative(ROOT, yml)} ---`);
    console.log(`  ステップ ${(src.match(/^\s+- name:/gm) || []).length} / uses: ${(src.match(/^\s+uses:/gm) || []).length} / run: ${(src.match(/^\s+run:/gm) || []).length}`);
    console.log(`  exit 文 ${exits.length}（非0 ${exits.filter((e) => !e.zero).length}）`);
    for (const e of exits) console.log(`    L${e.line}  ${e.text}   [${e.step}]`);

    // 外部コマンドの呼び出し数。数え方は【コメント行を除いた run: 本文に現れる
    // 「コマンド名＋空白」の出現数】。`$( )` の中や `if`・`|` の後ろも数える
    // （bash -e ではそれらも失敗しうる位置なので、停止点の候補として同じ土俵に載せる）。
    const cmds = {};
    for (const b of extractRunBlocks(yml)) {
      for (const raw of b.body.split('\n')) {
        const t = raw.trim();
        if (t.startsWith('#')) continue;
        for (const c of ['node', 'git', 'grep', 'sed', 'tee', 'cat', 'date']) {
          const n = (t.match(new RegExp(`\\b${c}\\s`, 'g')) || []).length;
          if (n) cmds[c] = (cmds[c] || 0) + n;
        }
      }
    }
    console.log(`  外部コマンドの呼び出し: ${Object.entries(cmds).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  }
}

// ============================================================
// probe（コマンド単位で「止まるか / マスクされるか」）
// ============================================================
const COMMIT_CMDS = [
  { label: 'git config user.name', match: 'config user.name' },
  { label: 'git status --porcelain（1回目・コミット前）', match: 'status --porcelain', nth: 1 },
  { label: 'git add -A（1回目）', match: 'add -A', nth: 1 },
  { label: 'git commit -m chore:…', match: 'commit -m chore', nth: 1 },
  { label: '$(TZ=Asia/Tokyo date +%Y-%m-%d)', match: '+%Y-%m-%d' },
  { label: 'git pull --rebase', match: 'pull --rebase' },
  { label: 'git rev-list --count "@{u}..HEAD"', match: 'rev-list --count' },
  { label: 'node tools/validate-data.js .（rebase後）', match: 'tools/validate-data.js' },
  { label: 'node tools/gen-venue-pages.js .', match: 'gen-venue-pages.js .', nth: 1 },
  { label: 'node tools/gen-venue-pages.js . --check', match: 'gen-venue-pages.js . --check' },
  { label: 'git status --porcelain（2回目・再生成後）', match: 'status --porcelain', nth: 2 },
  { label: 'git add -A（2回目）', match: 'add -A', nth: 2 },
  { label: 'git commit --amend --no-edit', match: 'commit --amend' },
  { label: 'git push', match: 'push' },
];

function probeOne(name, mkSb, body, env, cmds) {
  const sb0 = mkSb();
  const base = runBlock(sb0, body, env);
  drop(sb0);
  console.log(`\n--- ${name}  基準(無変異) exit=${base.code} ---`);
  if (base.code !== 0) { console.log('  ※基準が赤いので判定できない。筋書きを直すこと'); return; }
  for (const c of cmds) {
    const sb = mkSb();
    const r = runBlock(sb, body, { ...env, FAIL_MATCH: c.match, ...(c.nth ? { FAIL_NTH: String(c.nth) } : {}) });
    const fired = r.stderr.includes('SHIM_FAIL');
    drop(sb);
    const verdict = !fired ? '未到達        ' : r.code !== 0 ? `★停止点 exit=${r.code}` : 'マスク        ';
    console.log(`  ${verdict}  ${c.label}`);
  }
}

function probe() {
  console.log('===== コマンド単位の停止点測定（基準あり）=====');
  console.log('※ run: の中身は1文字も書き換えていない。PATH のシムで特定の呼び出しだけを失敗させている');

  // 取得ステップ（rc=0）
  probeOne('WL 取得ステップ（rc=0）', () => makeSandbox({ shims: true }),
    block(WL_YML, 'Waitinglist から日程を取得').body, { WL_SCENARIO: 'ok' },
    [{ label: 'node tools/import-waitinglist.js', match: 'tools/import-waitinglist.js' }]);

  // 妥当性確認
  probeOne('WL 妥当性確認', () => makeSandbox({ shims: true }),
    block(WL_YML, '出力の妥当性を確認').body, {},
    [{ label: 'node tools/validate-data.js .', match: 'tools/validate-data.js' }]);

  // コミット&プッシュ（毎朝の実際の筋書き＝取得ステップを本当に走らせてから）
  probeOne('WL コミット&プッシュ（取込み後の実差分）', () => {
    const sb = makeSandbox({ shims: true });
    const r = runBlock(sb, block(WL_YML, 'Waitinglist から日程を取得').body, { WL_SCENARIO: 'ok' });
    if (r.code !== 0) throw new Error('前処理の取得ステップが失敗: ' + r.code);
    return sb;
  }, block(WL_YML, '差分があればコミット').body, {}, COMMIT_CMDS);

  // Instagram監視のコミットステップ（構造は同じ）
  probeOne('IG コミット&プッシュ（差分あり）', () => {
    const sb = makeSandbox({ shims: true });
    fs.appendFileSync(path.join(sb.work, 'data.js'), '\n// sandbox dirty marker\n');
    return sb;
  }, block(IG_YML, '差分があればコミット').body, { DRY_RUN: 'false' }, COMMIT_CMDS);
}

// ============================================================
// recovery（2回実行）
// ============================================================
function recoveryCase(name, { mutate, env1, env2 }) {
  const sb = makeSandbox({ shims: true });
  if (mutate) mutate(sb);
  const d1 = runWlJob(sb, env1 || {});
  const b1 = botCount(sb);
  fresh(sb);
  const d2 = runWlJob(sb, env2 || env1 || {});
  const b2 = botCount(sb);
  console.log(`\n--- ${name}`);
  console.log(`  1日目: ${d1.ok ? '成功' : `失敗(${d1.failedAt} exit=${d1.code})`}  [${d1.log.join(' / ')}]  bot コミット ${b1}件`);
  console.log(`  2日目: ${d2.ok ? '成功' : `失敗(${d2.failedAt} exit=${d2.code})`}  [${d2.log.join(' / ')}]  bot コミット ${b2}件`);
  console.log(`  判定 : ${!d1.ok && d2.ok ? '★回復する' : !d1.ok && !d2.ok ? '★回復しない（翌朝も同じ理由で落ちる）' : '（1日目から成功）'}`);
  drop(sb);
}

function recovery() {
  console.log('===== 回復可能性（2回実行。2日目は origin から clone し直す＝新しいランナー）=====');

  recoveryCase('A. main の data.js にゼロ埋めされていない日付がある', {
    mutate: (sb) => {
      const p = path.join(sb.work, 'data.js');
      const src = fs.readFileSync(p, 'utf8');
      const m = src.match(/"date": "(\d{4})-(\d{2})-(\d{2})"/);
      fs.writeFileSync(p, src.replace(m[0], `"date": "${m[1]}-${Number(m[2])}-${Number(m[3])}"`));
      sh(sb, 'git add -A && git commit -q -m "不正な日付" && git push -q');
    },
    env1: { WL_SCENARIO: 'ok' },
  });

  recoveryCase('B. 全店の取得に失敗 → 翌朝APIが戻る', { env1: { WL_SCENARIO: 'all-empty' }, env2: { WL_SCENARIO: 'ok' } });
  recoveryCase("B'. 全店の取得に失敗が続く", { env1: { WL_SCENARIO: 'all-empty' } });
  recoveryCase('C. 一部の店だけ失敗（rc=2）→ 翌朝復旧', { env1: { WL_SCENARIO: 'partial' }, env2: { WL_SCENARIO: 'ok' } });

  recoveryCase('D. bot が触る行と同じ行を人が先に push（rebase 衝突）', {
    mutate: (sb) => {
      const tmp = path.join(sb.dir, 'other');
      execFileSync('git', ['clone', '-q', sb.origin, tmp]);
      const p = path.join(tmp, 'data.js');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/"venueId": "v3"/g, '"venueId": "v3", "humanTouch": true'));
      const g = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8' });
      g('config', 'user.name', 'other'); g('config', 'user.email', 'o@e.com');
      g('add', '-A'); g('commit', '-q', '-m', '人が v3 の行を編集'); g('push', '-q');
    },
    env1: { WL_SCENARIO: 'ok' },
  });

  recoveryCase('E. git push が拒否される（1日目だけ）', {
    env1: { WL_SCENARIO: 'ok', FAIL_MATCH: 'push' }, env2: { WL_SCENARIO: 'ok' },
  });

  recoveryCase('F. 「未確認」の印が note と食い違ったまま main に入った', {
    mutate: (sb) => {
      const p = path.join(sb.work, 'data.js');
      const src = fs.readFileSync(p, 'utf8');
      const out = src.replace(/\n\s+"addressUnverified": true,/, '');
      if (out === src) throw new Error('addressUnverified が見つかりません');
      fs.writeFileSync(p, out);
      sh(sb, 'git add -A && git commit -q -m "印の付け忘れ" && git push -q');
    },
    env1: { WL_SCENARIO: 'ok' },
  });
}

// ============================================================
// rollback（README の手順をそのまま実行する）
// ============================================================
function rollback() {
  console.log('===== ロールバック手順の実測 =====');

  console.log('\n--- R1: bot コミット2件をまとめて取り消す');
  {
    const sb = makeSandbox();
    const g = G(sb), og = OG(sb);
    const beforeSha = g('rev-parse', 'HEAD');
    const beforeTree = g('rev-parse', 'HEAD^{tree}');
    console.log(`  基準（bot 実行前）の tree = ${beforeTree}`);
    if (!runWlJob(sb, { WL_SCENARIO: 'day1' }).ok) throw new Error('day1 失敗');
    fresh(sb);
    if (!runWlJob(sb, { WL_SCENARIO: 'day2' }).ok) throw new Error('day2 失敗');
    fresh(sb);
    const bots = g('log', '--author=github-actions', '--pretty=%H', `${beforeSha}..HEAD`).split('\n').filter(Boolean);
    console.log(`  bot コミット ${bots.length}件`);
    const r = sh(sb, `git revert --no-edit ${bots[bots.length - 1]}^..${bots[0]}`);
    console.log(`  $ git revert --no-edit <最古>^..<最新> → exit=${r.code}`);
    console.log(`  revert 後の tree = ${g('rev-parse', 'HEAD^{tree}')}`);
    console.log(`  【保存則】bot 実行前の tree と一致: ${g('rev-parse', 'HEAD^{tree}') === beforeTree ? '★一致' : '不一致'}`);
    console.log(`  検査: validate-data exit=${sh(sb, 'node tools/validate-data.js .').code} / gen-venue-pages --check exit=${sh(sb, 'node tools/gen-venue-pages.js . --check').code}`);
    console.log(`  $ git push → exit=${sh(sb, 'git push').code}`);
    console.log(`  origin の tree と一致: ${og('rev-parse', 'main^{tree}') === beforeTree ? '★一致' : '不一致'} / bot コミットは ${botCount(sb)}件 履歴に残存（force push していない）`);
    drop(sb);
  }

  console.log('\n--- R2: 古い1件だけを取り消そうとするとどうなるか');
  {
    const sb = makeSandbox();
    const g = G(sb);
    const beforeSha = g('rev-parse', 'HEAD');
    if (!runWlJob(sb, { WL_SCENARIO: 'day1' }).ok) throw new Error('day1 失敗');
    fresh(sb);
    if (!runWlJob(sb, { WL_SCENARIO: 'day2' }).ok) throw new Error('day2 失敗');
    fresh(sb);
    const bots = g('log', '--author=github-actions', '--pretty=%H', `${beforeSha}..HEAD`).split('\n').filter(Boolean);
    const r = sh(sb, `git revert --no-edit ${bots[bots.length - 1]}`);
    console.log(`  $ git revert --no-edit <古いほうだけ> → exit=${r.code}`);
    for (const l of r.out.split('\n').filter((x) => /CONFLICT/.test(x))) console.log(`    ${l}`);
    if (r.code !== 0) console.log(`  $ git revert --abort → exit=${sh(sb, 'git revert --abort').code} / HEAD=${g('rev-parse', '--short', 'HEAD')}（元に戻る）`);
    drop(sb);
  }

  console.log('\n--- R3: revert しただけでは止まらない');
  {
    const sb = makeSandbox();
    const g = G(sb), og = OG(sb);
    const beforeTree = g('rev-parse', 'HEAD^{tree}');
    const beforeSha = g('rev-parse', 'HEAD');
    if (!runWlJob(sb, { WL_SCENARIO: 'day1' }).ok) throw new Error('day1 失敗');
    fresh(sb);
    sh(sb, `git revert --no-edit ${g('log', '--author=github-actions', '--pretty=%H', `${beforeSha}..HEAD`).trim()} && git push`);
    console.log(`  revert して push → origin の tree が bot 実行前と一致: ${og('rev-parse', 'main^{tree}') === beforeTree ? '★一致' : '不一致'}`);
    fresh(sb);
    const again = runWlJob(sb, { WL_SCENARIO: 'day1' });
    console.log(`  ワークフローを止めずに翌朝ぶんを回す → ${again.ok ? '成功' : '失敗'}`);
    console.log(`  origin の tree: ${og('rev-parse', 'main^{tree}') === beforeTree ? 'bot 実行前のまま' : '★また bot の内容に戻った'}`);
    drop(sb);
  }

  console.log('\n--- R4: waitinglist-write-state.json を巻き戻すと何が起きるか');
  {
    const sb = makeSandbox();
    console.log(`  bot 実行前に控えはあるか: ${fs.existsSync(path.join(sb.work, 'waitinglist-write-state.json')) ? 'ある' : '★無い（初回実行で作られる）'}`);
    if (!runWlJob(sb, { WL_SCENARIO: 'day1' }).ok) throw new Error('day1 失敗');
    fresh(sb);
    const st = JSON.parse(fs.readFileSync(path.join(sb.work, 'waitinglist-write-state.json'), 'utf8'));
    const target = Object.keys(st.entries)[0];
    const machineName = st.entries[target].name;
    const p = path.join(sb.work, 'data.js');
    const rowRe = new RegExp(`\\{[^{}]*"id": "${target}"[^{}]*\\}`);
    const row = fs.readFileSync(p, 'utf8').match(rowRe)[0];
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(row, row.replace(/"name": "[^"]*"/, '"name": "人が直した大会名"')));
    sh(sb, 'git add -A && git commit -q -m "人が大会名を直した" && git push -q');
    const readName = () => {
      const mm = fs.readFileSync(path.join(sb.work, 'data.js'), 'utf8').match(rowRe);
      return mm ? (mm[0].match(/"name": "([^"]*)"/) || [])[1] : '(行が消えた)';
    };
    if (!runWlJob(sb, { WL_SCENARIO: 'day1' }).ok) throw new Error('day2 失敗');
    console.log(`  控えがある状態で翌朝 → name は「${readName()}」`);
    fresh(sb);
    sh(sb, 'git rm -q waitinglist-write-state.json && git commit -q -m "控えを巻き戻した" && git push -q');
    const r3 = runWlJob(sb, { WL_SCENARIO: 'day1' });
    console.log(`  控えを消した状態で翌朝 → ジョブは ${r3.ok ? '通る' : '通らない'} / name は「${readName()}」（機械の値=「${machineName}」）`);
    drop(sb);
  }
}

// ============================================================
const cmd = process.argv[2] || 'all';
const jobs = { inventory, probe, recovery, rollback };
if (cmd === 'all') { for (const f of Object.values(jobs)) f(); }
else if (jobs[cmd]) jobs[cmd]();
else { console.error(`使い方: node tools/workflow-audit.js [${Object.keys(jobs).join('|')}|all]`); process.exit(1); }
