#!/usr/bin/env node
/**
 * no-internal-leaks.test.js — サイト訪問者に配信される実ファイルへの社内限定語彙の
 * 混入を機械的に検知する
 *
 * 実行: node tools/no-internal-leaks.test.js (単体) / node --test tools/*.test.js (全体)
 *
 * 【背景】社内の部署名・内部PR番号・依頼番号などが、公開ファイル(店舗ページの免責文・
 * コードコメント経由で生成物に紛れ込む等)に繰り返し混入する事故が起きた。README等の
 * 文書ルールだけでは同じ種類のミスの再発を防げないため、実際に配信される内容を対象に
 * 機械的に検査し、混入があればテストを落とす。
 *
 * 【対象(スコープ内)】サイト訪問者に実際に配信されるファイルだけに限定する。
 *   1. `tools/gen-venue-pages.js` / `gen-area-pages.js` / `gen-event-pages.js` /
 *      `gen-guide-pages.js` / `gen-guide-webcoin-regulation.js` を実際に実行した「後」の
 *      venues/<slug>/index.html・areas/<slug>/index.html・events/<slug>/index.html・
 *      guide/<slug>/index.html・ルート index.html。
 *      (コミット済みの生成物をそのまま読むのではなく、実行し直した結果を見る。
 *       生成テンプレート側に混入が入り込んだが再生成・コミットし忘れているケースを
 *       見逃さないため。生成先はこのリポジトリ本体ではなく一時ディレクトリにコピーした
 *       複製で、このテストの実行がリポジトリの作業ツリーを書き換えることはない)
 *   2. `<script src>` で直接配信されるJS/JSONファイル(data.js, big-events.js,
 *      promo-banners.js, listing-banner.js, fst-schedule-data.js, jopt-data.js,
 *      jopt-result-data.js, nippon-series-data.js, recurring-dedupe.js 等)。
 *      ただし実際に配信されるかどうかは `_config.yml` の `exclude:` が最終的な正とする
 *      (例: jopt-result-data.js / fukuoka-venues.json は同ファイルで配信除外済みのため、
 *      このリストに残っていても実際に除外されていれば自動的にスキップする)。
 *
 * 【対象外(意図的なスコープ外)】
 *   - `tools/*.js` 本体のソースコード・`*.test.js` … GitHub Pages配信からは
 *     `_config.yml` の `exclude: tools/` で除外済みだが、CIワークフローが直接
 *     `node tools/xxx.js` として実行するため削除はできない。「サイト訪問者への配信物」では
 *     ないためこのテストの対象にしない。
 *   - `README.md` … `_config.yml` で配信除外済み。開発者向け文書に社内経緯を記録すること
 *     自体の是非(Publicリポジトリである以上ソース閲覧は可能)は本テストとは別の、
 *     まだ判断待ちの論点であり、意図的にここでは扱わない。
 *   - `.github/workflows/*.yml` / `_config.yml` … GitHub上でのみ参照される設定で、
 *     サイト訪問者への配信物ではない。
 *   - `fukuoka-venues.json` … `_config.yml` で配信除外済み。かつPR#112で個別サニタイズ済み。
 *   - `ogp-design-spec.md` その他、`_config.yml` の `exclude:` に載っている
 *     Jekyll配信対象外ファイル全般。
 *
 * 【検知パターンの拡張】
 *   `LEAK_PATTERNS` に `{ label, pattern }` を追加するだけでよい(配列なので増やしやすい)。
 *   今後見つかった新しい混入パターンはここに追記していく。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// ============================================================
// 検知パターン(拡張しやすいよう配列で持つ。今後見つかったものはここに追加していく)
// ============================================================
const LEAK_PATTERNS = [
  // 社内の組織名(このリポジトリの運営体制を示す語彙。公開する理由が無い)
  { label: '社長', pattern: /社長/g },
  { label: 'マーケティング部', pattern: /マーケティング部/g },
  { label: '品質管理部', pattern: /品質管理部/g },
  { label: 'レビュー部', pattern: /レビュー部/g },
  { label: '開発部', pattern: /開発部/g },
  { label: '企画部', pattern: /企画部/g },
  { label: '経営管理オフィス', pattern: /経営管理オフィス/g },
  { label: '人事部', pattern: /人事部/g },
  { label: 'コンテンツ制作部', pattern: /コンテンツ制作部/g },
  // 内部の管理番号(社内の作業管理に使っているだけで、読者には意味を持たない)
  { label: '内部PR番号', pattern: /PR\s*#\d+/g },
  { label: '依頼番号', pattern: /依頼\d+/g },
  // 規約回避・不正アクセスを示唆する語(2026-09-16、fetch-venue-posts-apify.js に
  // 具体的な設計案の中身が残っていたことを受けて追加)
  { label: '検知回避', pattern: /検知回避/g },
  { label: 'セッションCookie注入', pattern: /セッションCookie注入/g },
];

// ============================================================
// _config.yml の exclude: を見て、公開JS/JSONファイル候補のうち
// 実際にはGitHub Pages配信から除外されているものを取り除く
// ============================================================
function loadJekyllExcludeSet(repoRoot) {
  const raw = fs.readFileSync(path.join(repoRoot, '_config.yml'), 'utf8');
  const excludes = new Set();
  const lines = raw.split('\n');
  let inExcludeBlock = false;
  for (const line of lines) {
    if (/^exclude:\s*$/.test(line)) { inExcludeBlock = true; continue; }
    if (inExcludeBlock) {
      if (/^\S/.test(line)) break; // インデント無し = 次のトップレベルキー(exclude:ブロック終端)
      const m = line.match(/^\s*-\s*"?([^"#]+?)"?\s*(?:#.*)?$/);
      if (m) excludes.add(m[1].trim());
    }
  }
  return excludes;
}

// サイト訪問者へ配信される可能性がある、ルート直下のJS/JSONデータファイル候補。
// 実際に配信されるかどうかは上の exclude セットで最終確認する。
const CANDIDATE_PUBLIC_DATA_FILES = [
  'data.js',
  'big-events.js',
  'promo-banners.js',
  'listing-banner.js',
  'fst-schedule-data.js',
  'jopt-data.js',
  'jopt-result-data.js',
  'nippon-series-data.js',
  'recurring-dedupe.js',
];

function publicDataFiles(repoRoot) {
  const excludes = loadJekyllExcludeSet(repoRoot);
  return CANDIDATE_PUBLIC_DATA_FILES.filter(f => fs.existsSync(path.join(repoRoot, f)) && !excludes.has(f));
}

// ============================================================
// テキストを行単位で走査し、LEAK_PATTERNSにマッチした箇所をすべて集める
// ============================================================
function scanFile(relLabel, absPath, violations) {
  scanText(relLabel, fs.readFileSync(absPath, 'utf8'), violations);
}

function scanText(relLabel, content, violations) {
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    for (const { label, pattern } of LEAK_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        violations.push({
          file: relLabel,
          lineNumber: idx + 1,
          label,
          matched: m[0],
          line: line.trim().slice(0, 200),
        });
        if (m.index === pattern.lastIndex) pattern.lastIndex++; // ゼロ幅マッチの無限ループ対策
      }
    }
  });
}

function formatViolations(violations) {
  return violations
    .map(v => `  - [${v.label}] ${v.file}:${v.lineNumber} … 「${v.matched}」\n      ${v.line}`)
    .join('\n');
}

// ============================================================
// 生成スクリプトを一時ディレクトリの複製に対して実行し、実際に配信される
// HTMLを再現する(このリポジトリ本体は一切書き換えない)
// ============================================================
function buildGeneratedSite() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fpn-leak-check-'));
  fs.cpSync(REPO, tmpRoot, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });

  const generators = [
    'gen-venue-pages.js',
    'gen-area-pages.js',
    'gen-event-pages.js',
    'gen-guide-pages.js',
    'gen-guide-webcoin-regulation.js',
  ];
  for (const script of generators) {
    const scriptPath = path.join(tmpRoot, 'tools', script);
    if (!fs.existsSync(scriptPath)) continue; // 将来スクリプト名が変わっても他は動かす
    // tmpRootは.gitを含まない複製のため、gen-sitemap.js内部のgit log呼び出しは失敗するが、
    // 呼び出し側で握りつぶされ lastmod 省略に倒れるだけで生成自体は成功する(仕様どおり)。
    // stdioを明示してそのgitのエラー出力がテスト実行の標準エラーへ素通しされないようにする。
    execFileSync(process.execPath, [scriptPath, tmpRoot], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  return tmpRoot;
}

function collectGeneratedHtmlTargets(tmpRoot) {
  const targets = [{ label: 'index.html', abs: path.join(tmpRoot, 'index.html') }];
  for (const dirName of ['venues', 'areas', 'events', 'guide']) {
    const base = path.join(tmpRoot, dirName);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(base, entry.name, 'index.html');
      if (fs.existsSync(p)) {
        targets.push({ label: path.join(dirName, entry.name, 'index.html'), abs: p });
      }
    }
  }
  return targets.filter(t => fs.existsSync(t.abs));
}

// ---- セットアップ(このファイルが読み込まれた時点で1回だけ実行する) ----
let tmpRoot;
let setupError = null;
try {
  tmpRoot = buildGeneratedSite();
} catch (e) {
  setupError = e;
}

test.after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('生成スクリプトの実行に成功する(このテストの前提)', () => {
  assert.equal(setupError, null, `生成スクリプトの実行に失敗しました: ${setupError && setupError.message}`);
});

test('生成後のHTMLページに社内限定語彙が混入していない', () => {
  assert.equal(setupError, null, '前提の生成に失敗しているため検査できません');
  const targets = collectGeneratedHtmlTargets(tmpRoot);
  assert.ok(targets.length > 0, '検査対象のHTMLが1件も見つかりませんでした(生成が失敗している可能性)');

  const violations = [];
  for (const { label, abs } of targets) scanFile(label, abs, violations);

  assert.equal(
    violations.length, 0,
    `以下の配信ファイルに社内限定語彙が混入しています:\n${formatViolations(violations)}`
  );
});

test('script srcで直接配信されるJS/JSONファイルに社内限定語彙が混入していない', () => {
  const files = publicDataFiles(REPO);
  assert.ok(files.length > 0, '検査対象のJS/JSONファイルが1件も見つかりませんでした(候補リスト・_config.ymlの読み違いの可能性)');

  const violations = [];
  for (const f of files) scanFile(f, path.join(REPO, f), violations);

  assert.equal(
    violations.length, 0,
    `以下の配信ファイルに社内限定語彙が混入しています:\n${formatViolations(violations)}`
  );
});

test('_config.ymlのexclude指定により、jopt-result-data.js / fukuoka-venues.jsonは配信対象外と判定される', () => {
  // このテスト自体の前提(exclude読み取りロジック)が壊れていないことを固定しておく。
  // 壊れると「配信されないから検査しなくてよい」判定が誤って甘くなる方向に倒れるため。
  const excludes = loadJekyllExcludeSet(REPO);
  assert.ok(excludes.has('jopt-result-data.js'), 'jopt-result-data.js が_config.ymlのexcludeから読み取れていない');
  assert.ok(excludes.has('fukuoka-venues.json'), 'fukuoka-venues.json が_config.ymlのexcludeから読み取れていない');
  assert.ok(!publicDataFiles(REPO).includes('jopt-result-data.js'), 'jopt-result-data.jsが配信対象に含まれてしまっている');
});

// ============================================================
// 回帰確認: tools/fetch-venue-posts-apify.js に残っていた具体的な設計案の文言
// (社内個人アカウント認証情報の利用検討・規約の検知回避を伴う設計だった事実)は、
// tools/*.js 自体はこのテストのスキャン対象外だが、「検知パターン自体は正しく
// 反応する/しない」ことをこの2件の文字列で固定しておく
// (修正前の文言 → マッチする。修正後の文言 → マッチしない)。
// ============================================================
test('検知パターンの回帰確認: 削除前の設計案の文言は検知され、削除後の文言は検知されない', () => {
  const beforeFix = [
    '【経緯】以前検討したInstagram自動ログイン監視(PR #13、運営者個人アカウントのセッションCookie注入＋',
    '検知回避を伴う設計)は運営判断で中止した。Apifyは正規の第三者スクレイピングサービスの',
  ].join('\n');
  const afterFix = fs.readFileSync(path.join(REPO, 'tools', 'fetch-venue-posts-apify.js'), 'utf8');

  const before = [];
  scanText('(回帰確認用)修正前の文言', beforeFix, before);
  assert.ok(before.length > 0, '修正前の文言が検知パターンにマッチしませんでした(パターンが弱すぎる可能性)');
  assert.ok(before.some(v => v.label === '検知回避'), '「検知回避」が検知されませんでした');
  assert.ok(before.some(v => v.label === 'セッションCookie注入'), '「セッションCookie注入」が検知されませんでした');

  const after = [];
  scanText('tools/fetch-venue-posts-apify.js', afterFix, after);
  assert.equal(
    after.length, 0,
    `修正後のファイルにまだ検知パターンがマッチしています(削除漏れの可能性):\n${formatViolations(after)}`
  );
});
