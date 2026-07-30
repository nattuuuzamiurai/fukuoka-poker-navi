#!/usr/bin/env node
/**
 * validate-data.js
 *
 * data.js を「コミットして本番に配ってよい状態か」だけで判定する最終ゲート。
 * 日次の自動取込ワークフローが、
 *   (1) コミットの直前 … 自分のスクリプトが書いた内容を検査する
 *   (2) `git pull --rebase` の直後 … 他のジョブ/人のコミットを取り込んだ【押す物】を検査する
 * の2回呼ぶ。人が data.js を手で編集したときにも、同じものをそのまま走らせられる。
 *
 * 使い方:
 *   node tools/validate-data.js <リポジトリのパス>      例) node tools/validate-data.js .
 *   テスト: node tools/validate-data.test.js
 *
 * 見るもの(どれか1つでも駄目なら非ゼロ終了する):
 *   1. 構文     … 壊れた data.js を配ると本番サイトが白画面になる
 *   2. 件数     … TOURNAMENTS が MIN_TOURNAMENTS 未満なら異常(部分障害でごっそり消えた)
 *   3. id重複   … 同じ id の行が二重に出る / 更新が別のエントリに当たる
 *   4. 日付書式 … date が YYYY-MM-DD(ゼロ埋め)の【実在する日付】か
 *
 * 【4(日付書式)を入れている理由 — 実害が2つある】
 *   a) 静的ページの再生成が落ちる。tools/venue-schedule.js の monthRange() が
 *      YYYY-MM-DD 以外を弾くため、`2026-9-5` が1件でも入ると翌朝以降の日次ジョブが
 *      毎朝落ちる(人が data.js を直すまで自動取込が止まる)。
 *   b) 公開サイトの並び順が壊れる。一覧は日付文字列の辞書順で並べているので
 *      '2026-9-5' > '2027-03-01' となり、9月の大会が2027年の大会より後ろ=最下部に出る。
 *
 *   このゲートは data.js を書く経路すべての共通の栓。Waitinglist取込み(公開APIの
 *   `startAt` 由来なので書式は安定)よりも、LLM(Vision)が読み取った日付をそのまま
 *   入れる Instagram監視の方が、`2026-9-5` / `9/5` / `2026-07-01T00:00:00Z` のような
 *   値を持ち込みやすい。どちらのパイプラインが原因でもここで捕まる。
 *
 * 【ワークフローに直書きせずスクリプトにした理由】
 *   - 同じ検査を2つの yml が呼ぶ(将来3本目が増えても同じ)。yml に二重に書くと必ず片方だけ古くなる。
 *   - 当番が原因を即座に特定できるように、不正値と該当トーナメント(venueId/id/name)を
 *     並べて出す必要がある。この文面を `node -e '...'` のワンライナーで書くと、
 *     YAML の引用符の都合(シングルクォートで囲むのでJS側にシングルクォートを書けない)で
 *     読めない代物になる。
 *   - テストできる(tools/validate-data.test.js)。人が手元でも同じものを走らせられる。
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// 部分障害で大量に消えたことを検知するための下限。現在 609 件。
// 掲載店が減って恒常的に下回るようになったら、ここを下げる前に「本当に減ったのか」を確認すること。
const MIN_TOURNAMENTS = 500;

// 一覧に出す最大件数(全部出すとログが埋まる)。
const MAX_LIST = 20;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(lines) {
  for (const line of [].concat(lines)) console.error(line);
  process.exit(1);
}

/** そのトーナメントを人が data.js の中から見つけられる形にする */
function where(t) {
  const id = t && t.id !== undefined ? String(t.id) : '(idなし)';
  const venueId = t && t.venueId !== undefined ? String(t.venueId) : '(venueIdなし)';
  const name = t && t.name !== undefined ? String(t.name) : '(nameなし)';
  return `venueId=${venueId} / id=${id} / name=${name}`;
}

/** YYYY-MM-DD の文字列が実在する日付か(2026-02-31 のような値を弾く) */
function isRealDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function listOf(entries, render) {
  const lines = entries.slice(0, MAX_LIST).map(render);
  if (entries.length > MAX_LIST) lines.push(`  … ほか ${entries.length - MAX_LIST} 件`);
  return lines;
}

function main() {
  const repoArg = process.argv.slice(2).filter(a => !a.startsWith('--'))[0];
  if (!repoArg) fail('リポジトリのパスを指定してください  例) node tools/validate-data.js .');
  // path.join('.', 'data.js') は 'data.js' に正規化され、require() がパッケージ名として
  // 解決しようとして失敗する。受け取ったパスは必ず絶対パスに直す(gen-venue-pages.js と同じ)。
  const dataPath = path.join(path.resolve(repoArg), 'data.js');

  // 1. 構文チェック。require より先にやる(実行せずにパースだけするので、
  //    壊れ方によらず「どの行が壊れているか」が出る)。
  const parsed = spawnSync(process.execPath, ['--check', dataPath], { encoding: 'utf8' });
  if (parsed.status !== 0) {
    fail([`[validate-data] data.js の構文が壊れています: ${dataPath}`, parsed.stderr || parsed.stdout || '']);
  }

  let data;
  try {
    data = require(dataPath);
  } catch (e) {
    fail([`[validate-data] data.js を読み込めません: ${dataPath}`, String(e && e.stack || e)]);
  }

  const tournaments = data && data.TOURNAMENTS;
  if (!Array.isArray(tournaments)) {
    fail('[validate-data] TOURNAMENTS が配列として取り出せません(module.exports を確認してください)');
  }
  if (!Array.isArray(data.VENUES)) {
    fail('[validate-data] VENUES が配列として取り出せません(module.exports を確認してください)');
  }

  // 2. 件数
  if (tournaments.length < MIN_TOURNAMENTS) {
    fail(`[validate-data] TOURNAMENTS件数が異常: ${tournaments.length}件(下限 ${MIN_TOURNAMENTS}件)。取込みが部分的に失敗した可能性があります。`);
  }

  // 3. id重複
  const seen = new Map();
  const dup = [];
  for (const t of tournaments) {
    const id = t && t.id;
    if (seen.has(id)) dup.push(t); else seen.set(id, t);
  }
  if (dup.length) {
    fail([
      `[validate-data] id が重複しています: ${dup.length}件`,
      ...listOf(dup, t => `  - 重複した id: ${JSON.stringify(t && t.id)} (${where(t)})`),
    ]);
  }

  // 4. 日付書式(このゲートの本命)
  const badFormat = tournaments.filter(t => !ISO_DATE.test(String(t && t.date)));
  const badCalendar = tournaments.filter(t => ISO_DATE.test(String(t && t.date)) && !isRealDate(String(t.date)));
  if (badFormat.length || badCalendar.length) {
    const lines = [`[validate-data] 日付が YYYY-MM-DD(ゼロ埋め)ではありません: ${badFormat.length + badCalendar.length}件`];
    if (badFormat.length) {
      lines.push(...listOf(badFormat, t => `  - 想定外の値: ${JSON.stringify(t && t.date)} (${where(t)})`));
    }
    if (badCalendar.length) {
      lines.push(`  ※ 書式は合っているが存在しない日付: ${badCalendar.length}件`);
      lines.push(...listOf(badCalendar, t => `  - 存在しない日付: ${JSON.stringify(t.date)} (${where(t)})`));
    }
    lines.push(
      '',
      '  この値が data.js に入ると:',
      '   (1) 店舗静的ページの再生成(tools/gen-venue-pages.js)が落ち、日次の自動取込が止まります',
      '   (2) 公開サイトの一覧は日付文字列の辞書順で並ぶため、9月の大会が2027年の大会より後ろに出ます',
      '  直し方: 上の venueId / id / name のエントリの date を YYYY-MM-DD に直す。',
      '  LLM(Vision)抽出由来(source が semi で id が自動採番)なら、元のInstagram投稿の日付も確認すること。'
    );
    fail(lines);
  }

  console.log(`[validate-data] OK: TOURNAMENTS ${tournaments.length}件 / id重複なし / 日付はすべて YYYY-MM-DD(実在する日付)`);
}

main();
