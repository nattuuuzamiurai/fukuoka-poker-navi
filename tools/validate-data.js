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
 *
 * 【このファイルが「日付の判定そのもの」も持つ理由(2026-07-31追加)】
 * 同じ判定を、data.js に入った【後】(このCLI)と入れる【前】(Vision抽出側 —
 * tools/monitor-instagram-apify.js / tools/import-venue-image.js)の両方が使う。
 * 二重に書けば必ず片方が古くなるので、規則の所有者はこのファイル1つに寄せ、
 * 抽出側は `dateProblem` / `extractedRowProblem` を require して使う。
 * (CLIとして起動されたときだけ main() を走らせるので、require しても副作用は無い)
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

// 開始時刻。ゼロ埋めの HH:MM のみ許す。
// 日付と同じくゼロ埋めを要求するのは、(1) start が id の構成要素であること
// (`ig-v18-2026-09-12-1900-nlh`)、(2) 同じ日の中の並び順を start の文字列比較で決めているため
// `9:00` が `19:00` より後ろに来てしまうこと、の2つの実害があるため。
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Tournament スキーマのうち、数値として data.js に入るフィールド。
// Vision が `"3,500"` や `"20k"` を返すと Number() が NaN になり、JSON化で null に化けて
// 【価格情報が無言で消える】。そのため NaN になる値は取り込まずに破棄理由として出す。
const NUMERIC_FIELDS = ['buyin', 'addon', 'stack', 'guarantee'];

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

/**
 * YYYY-MM-DD の文字列が実在する日付か(2026-02-31 のような値を弾く)。
 * ISO_DATE を通った文字列にだけ使うこと(前後の空白等は ISO_DATE 側のアンカーで弾かれる前提)。
 */
function isRealDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * date として受け付けられない値かどうかを判定する【唯一の定義】。
 *   'format'   … YYYY-MM-DD(ゼロ埋め)ではない(`2026-9-5` / `9/5` / `2026-07-01T00:00:00Z` / 空 / undefined)
 *   'calendar' … 書式は合っているが存在しない日付(`2026-02-31`)
 *   null       … 問題なし
 * @param {*} value
 * @returns {'format'|'calendar'|null}
 */
function dateProblem(value) {
  const s = String(value);
  if (!ISO_DATE.test(s)) return 'format';
  if (!isRealDate(s)) return 'calendar';
  return null;
}

/**
 * Vision(LLM)が返した抽出結果1件を data.js に入れてよいかを判定する【1行だけを見る検査】。
 * 駄目なら【ログにそのまま出せる日本語の理由】、問題なければ null を返す。
 *
 * 【この関数が保証する範囲 — 誤解しないこと】
 * 日付については、data.js に入った後の最終ゲート(このファイルの main)と同じ `dateProblem` を
 * 使うのでズレない(「抽出側は通すのにコミット前ゲートで落ちる=その日のジョブが丸ごと止まる」が起きない)。
 * **ただしゲートは日付以外に id重複・件数も見る。それらは1行だけでは判定できないので、この関数には
 * 入っていない。行を跨ぐ検査(id重複)は `duplicateIdProblem` を呼び出し側が使って別途担保すること。**
 * (実際、id重複を層2で見ていなかったために「Visionが同じ行を2回返す → ゲートで落ちる →
 *  状態が進まない → 翌日も同じ所で止まる」という、まさに塞ぎたかった失敗モードが残っていた)
 *
 * @param {*} t Vision抽出の素の1件
 * @returns {string|null}
 */
function extractedRowProblem(t) {
  if (!t || typeof t !== 'object') return '抽出結果がオブジェクトではない';
  if (!t.name || !String(t.name).trim()) return '大会名が読み取れない(name が空)';
  if (!t.date) return '日付が読み取れない(date が空)';
  const problem = dateProblem(t.date);
  if (problem === 'format') return '日付が YYYY-MM-DD(ゼロ埋め)ではない';
  if (problem === 'calendar') return '存在しない日付';
  // start は省略可(取込み側が '00:00' を既定値にする)。値があるなら HH:MM だけ許す。
  if (t.start != null && String(t.start).trim() !== '' && !HHMM.test(String(t.start))) {
    return `開始時刻が HH:MM(ゼロ埋め)ではない(start=${JSON.stringify(String(t.start))})`;
  }
  for (const field of NUMERIC_FIELDS) {
    const v = t[field];
    if (v == null) continue; // null/undefined は「読み取れなかった」の正しい表現
    if (String(v).trim() === '' || Number.isNaN(Number(v))) {
      return `${field} が数値として読めない(${field}=${JSON.stringify(v)})`;
    }
  }
  return null;
}

/**
 * 【行を跨ぐ検査】同じ id のエントリが二重に生まれないか。
 * `extractedRowProblem` は1行だけを見るのでここは分けてある。呼び出し側が
 * 「今回の取込みで既に採用した id の集合」を持って1件ずつ呼ぶこと。
 *
 * 【なぜ必要か】id は `ig-<venue>-<date>-<start>-<slug(name)>` で組み立てるため、
 * Visionが同じ行を2回返す/同じ日・同じ大会名で start が読めなかった2行(どちらも既定の '00:00')が
 * あると衝突する。放置すると data.js の id が重複し、コミット前ゲートが落ちて
 * apify-monitor-state.json が進まず、翌日も同じ投稿から再試行して同じ所で止まる。
 *
 * @param {{id:string,date:string,start:string}} entry これから採用しようとしているエントリ
 * @param {Set<string>} usedIds 今回の取込みで既に採用した id
 * @param {Map<string,string>|null} [existingIdSlots] data.js 側の id → `${date} ${start}`。
 *   mergeStore は (date,start) が一致する既存エントリしか置き換えないので、
 *   「同じidだがスロットが違う」既存があると両方残って重複する(人が admin.html で
 *   日時だけ直した場合などに起こりうる)。渡さなければこの検査は省略される。
 * @returns {string|null}
 */
function duplicateIdProblem(entry, usedIds, existingIdSlots) {
  if (usedIds && usedIds.has(entry.id)) {
    return `同じidの行が重複(date/start/nameが同一。id=${entry.id})`;
  }
  const slot = `${entry.date} ${entry.start}`;
  if (existingIdSlots && existingIdSlots.has(entry.id) && existingIdSlots.get(entry.id) !== slot) {
    return `既存エントリと id が衝突(既存は ${existingIdSlots.get(entry.id)} / id=${entry.id})`;
  }
  return null;
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

  // 4. 日付書式(このゲートの本命)。判定は dateProblem 1本(抽出側と同じもの)。
  const badFormat = tournaments.filter(t => dateProblem(t && t.date) === 'format');
  const badCalendar = tournaments.filter(t => dateProblem(t && t.date) === 'calendar');
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
      '  LLM(Vision)抽出由来(source が semi で id が自動採番)なら、元のInstagram投稿の日付も確認すること。',
      '',
      '  ★ Instagram監視のジョブ(.github/workflows/monitor-instagram-apify.yml)で落ちた場合は',
      '    リポジトリの data.js を検索しても見つかりません。この行はランナー上の作業コピーにしか',
      '    存在せず、コミットされずに破棄されるためです(=公開はされていない)。',
      '    直す対象は data.js ではなく、抽出側(tools/monitor-instagram-apify.js)です。',
      '    抽出側には不正な行だけを捨てる検査(同じ tools/validate-data.js の extractedRowProblem)が',
      '    入っているので、ここまで届いたということはその検査に穴があります。',
      '    その投稿を取り込み直したいときは apify-monitor-state.json の lastPostedAt を戻すか、',
      '    `node tools/import-venue-image.js --venue <id> --instagram-url <投稿URL>` で手動取込みします。'
    );
    fail(lines);
  }

  console.log(`[validate-data] OK: TOURNAMENTS ${tournaments.length}件 / id重複なし / 日付はすべて YYYY-MM-DD(実在する日付)`);
}

// CLIとして起動されたときだけ検査を走らせる。
// (抽出側が dateProblem / extractedRowProblem を require するため。require で main() が
//  走ると「引数が無い」で即 exit(1) してしまう)
if (require.main === module) main();

module.exports = { ISO_DATE, HHMM, isRealDate, dateProblem, extractedRowProblem, duplicateIdProblem };
