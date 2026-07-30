#!/usr/bin/env node
/**
 * monitor-instagram-apify.js
 *
 * 公式サイトAPIが無い6店舗(v40/v20/v18/v21/v34/v35)のInstagram投稿をApify経由で日次チェックし、
 * 新着のスケジュール告知らしき投稿を見つけたらVisionで抽出して `data.js` に安全にupsertする。
 *
 * 【全体の流れ】
 *   1. 店舗ごとに tools/fetch-venue-posts-apify.js でApifyから最近の投稿一覧を取得する
 *   2. `apify-monitor-state.json` に記録した「最後に確認済みの投稿日時」より新しい投稿だけを
 *      「新着」として拾う(状態が無い店舗は、今回取得できた分をそのまま新着扱いにする。
 *      Apifyは常に直近 resultsLimit 件までしか返さないため件数は有界)
 *   3. 新着のうちキャプションがスケジュール告知らしいものだけを対象に、画像をダウンロードして
 *      tools/venue-schedule-vision.js でTournamentデータへ抽出する(簡易キーワード判定。
 *      取りこぼしより誤検知の方が実害が小さいため広めに拾う。実際にトーナメント情報が読み取れるかは
 *      後段のVision抽出が0件かどうかで最終判断される)
 *   3.5 抽出結果を1行ずつ検査し、`data.js` に入れてはいけない値(日付が YYYY-MM-DD でない等)の
 *      行【だけ】を捨てる(tools/validate-data.js の extractedRowProblem。詳細は下記)
 *   4. 抽出結果を tools/tournament-merge.js で `data.js` へ安全にupsertする
 *      (`source: 'semi', verified: false`。PR #11(import-waitinglist.js)・PR #14と同じ安全設計:
 *       対象venue以外・過去日には一切触れない、書き込み前に自己チェック、失敗時は書き換えない)
 *   5. 新着の有無・処理成否に関わらず、Apify呼び出し自体が失敗した店舗が1つでもあれば、
 *      このスクリプトは**どの店舗のぶんも** data.js / 状態ファイルを書き換えずに異常終了する
 *      (import-waitinglist.js と同じ「全店ぶん確定してからまとめて書く」設計。マージ自体はメモリ上で
 *      逐次計算し、実際のファイル書き込みは最後に1回だけ行うことで実現している)
 *
 * 使い方:
 *   node tools/monitor-instagram-apify.js               … data.js / 状態ファイルを更新する
 *   node tools/monitor-instagram-apify.js --dry-run     … どちらも書き換えず、検知結果だけ表示する
 *
 * 必要な環境変数:
 *   APIFY_API_TOKEN     … Apify呼び出しに必須(tools/fetch-venue-posts-apify.js参照)
 *   ANTHROPIC_API_KEY   … Vision抽出に必須(tools/venue-schedule-vision.js参照)
 *
 * 【source: 'semi' を使う理由(2026-07-31修正: 'auto'で運用していた際に致命的なデータ消失バグが発生)】
 * `source: 'auto'`(tools/tournament-merge.jsのmergeStore、Waitinglist取込みと同じ規則)は
 * 「今回の取得結果=その時点の完全な今後のスケジュール」を前提に、対象店舗の今日以降のautoエントリを
 * 毎回全部作り直す(=取得結果に無いものは消す)。Waitinglistの公開APIは月間の全日程を毎回返すためこの
 * 前提が成り立つが、対象店舗の一部(例: pokerbar_iris)は「1投稿1イベント」形式でInstagramに投稿しており、
 * 1回の投稿が今後の全日程を含まない。この状態で`source: 'auto'`を使うと、前回検知した投稿由来の
 * エントリ(まだ未来日)が、今回のマージで「取得結果に無い」と判定されて消えてしまう
 * (実データ・実コードで再現: Run1でイベントA追加→Run2で別投稿からイベントB検知→イベントAが消滅)。
 * そのため`source: 'semi'`(tools/import-venue-image.jsと同じ、「対応する(date,start)が無いものは残す」
 * 規則)を使う。これにより複数投稿にまたがる日程が積み上がっていき、店舗側の告知投稿が消えたり
 * 日程自体が中止・変更されたりした場合は、admin.html等で人手による整理が必要になる。
 *
 * 【抽出結果の検査を「不正な行だけ捨てる」形にしている理由(2026-07-31追加)】
 * Vision(LLM)は `2026-9-5` / `9/5` / `2026-07-01T00:00:00Z` のような日付を返し得る。
 * この値が `data.js` に入ると公開サイトの並び順が壊れ、翌朝以降の静的ページ再生成も落ちる。
 * ただし【ここで例外を投げてジョブごと落としてはいけない】。この関数は6店ぶんを1つの配列に
 * 積み上げて最後に一度だけ書き出すので、1店の1件で落とすと `apify-monitor-state.json` が進まず、
 * 翌日も6店すべてが同じ投稿から再試行して同じ所で落ちる(=パイプラインが永久に止まる)。
 * しかも落ちた行はランナー上の作業コピーにしか無く、当番がリポジトリで直せる対象が存在しない。
 * そのため「不正な行だけを捨て、残りは取り込み、状態は前進させる」。捨てた行は
 * 店・投稿・値がわかる形でログに出し、Visionの抽出品質を人が測れるようにする。
 *
 * 【捨てすぎ(投稿まるごと不採用)を異常として扱う理由】
 * ある投稿から抽出した行が1件以上あるのに1件も採用できなかった場合、その投稿の内容は
 * サイトのどこにも残らず、しかも確認済み投稿日時が進むので【二度と再試行されない】。
 * 静かに捨てると誰も気づけないため、ジョブは止めない代わりに ::error:: 注記で目立たせ、
 * 手動取込み(tools/import-venue-image.js --instagram-url)の導線をログに出す。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 「data.js に入れてよい日付か」の判定はコミット前ゲート(tools/validate-data.js)と同じものを使う。
// 二重に書くと必ず片方が古くなり、「抽出側は通すのにゲートで落ちる=ジョブが毎日止まる」ズレが生じる。
const { extractedRowProblem } = require('./validate-data');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_JS = path.join(REPO_ROOT, 'data.js');
const STATE_PATH = path.join(REPO_ROOT, 'apify-monitor-state.json');

// ============================================================
// 対象店舗 — 公式サイトAPIが無く、Instagramでのみ日程告知される6店舗
// ============================================================
const STORES = [
  { venueId: 'v40', handle: 'triple_orio', label: 'TripleBarrel 折尾店' },
  { venueId: 'v20', handle: 'king2485queen', label: 'KING&QUEEN SUITED 直方店' },
  { venueId: 'v18', handle: 'pokerbar_iris', label: 'Poker Bar IRIS' },
  { venueId: 'v21', handle: 'kurume_ken_poker', label: 'KENポーカー久留米' },
  { venueId: 'v34', handle: 'king806queenkurosaki', label: 'KING&QUEEN SUITED 黒崎店' },
  { venueId: 'v35', handle: 'ace_and_king259', label: 'A&K' },
];

// キャプションにこれらの語が含まれる投稿だけを「スケジュール告知らしい」として扱う簡易判定。
// 取りこぼしより誤検知の方が実害が小さい(誤検知してもVision抽出が0件なら何も起きない)ため広めに取る。
const SCHEDULE_KEYWORDS = [
  'スケジュール',
  '日程',
  'タイムテーブル',
  '月間',
  '今月',
  '来月',
  '開催予定',
  '大会情報',
  'トーナメント表',
];

const DRY_RUN = process.argv.includes('--dry-run');
const REQUEST_TIMEOUT_MS = 20000;

function fail(msg) {
  console.error(`[monitor-instagram-apify] ERROR: ${msg}`);
  console.error('[monitor-instagram-apify] data.js / apify-monitor-state.json は書き換えていません。');
  process.exit(1);
}

const pad2 = (n) => String(n).padStart(2, '0');
function todayJst() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    throw new Error(`${statePath} の読み込みに失敗しました: ${e.message}`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function looksLikeSchedulePost(caption) {
  const text = String(caption || '');
  return SCHEDULE_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * 記録済みの最終確認投稿日時(lastPostedAt)より新しい投稿だけを、古い順に返す。
 * 記録が無い店舗(初回)は、投稿日時が読み取れたものをそのまま(古い順で)返す
 * (Apifyは常に直近 resultsLimit 件までしか返さないため、初回でも件数は有界)。
 */
function pickNewPosts(posts, lastPostedAt) {
  const valid = (Array.isArray(posts) ? posts : []).filter(
    (p) => p && p.postedAt && !Number.isNaN(Date.parse(p.postedAt))
  );
  const sorted = [...valid].sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  if (!lastPostedAt) return sorted;
  const lastMs = Date.parse(lastPostedAt);
  if (Number.isNaN(lastMs)) return sorted;
  return sorted.filter((p) => Date.parse(p.postedAt) > lastMs);
}

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'post';
}

/**
 * Vision抽出の素の結果1件 → Tournamentスキーマ(source: 'semi', verified: false)。
 * `source: 'auto'`ではなく`'semi'`にしているのは、対象店舗が「1投稿1イベント」形式で運用されており
 * 1回の投稿取得結果が今後の全日程を含むとは限らないため(詳細は本ファイル冒頭のコメント参照)。
 * `'semi'`ならtools/tournament-merge.jsのmergeStoreで「対応する(date,start)が無いものは残す」
 * 規則が適用され、複数投稿にまたがる日程が消えずに積み上がっていく。
 */
function toTournament(t, venueId) {
  const start = t.start || '00:00';
  return {
    id: `ig-${venueId}-${t.date}-${String(start).replace(':', '')}-${slugify(t.name)}`,
    venueId,
    name: String(t.name).trim(),
    date: t.date,
    start,
    buyin: t.buyin != null ? Number(t.buyin) : 0,
    addon: t.addon != null ? Number(t.addon) : null,
    stack: t.stack != null ? Number(t.stack) : 0,
    guarantee: t.guarantee != null ? Number(t.guarantee) : null,
    reentry: t.reentry === 'late' ? 'late' : Boolean(t.reentry),
    prize: t.prize || null,
    tags: Array.isArray(t.tags) ? t.tags : [],
    source: 'semi',
    verified: false,
  };
}

/**
 * 破棄した抽出行1件を、人が追跡できる1行のログにする。
 * 「どの店の・どの投稿の・どんな値だったか」が揃っていないとVisionの抽出品質を測れないので、
 * 理由 / 店 / 投稿URL / 投稿日時 / 実際の date と name をすべて出す。
 */
function formatDroppedRow(store, post, row, reason) {
  return (
    `[monitor-instagram-apify] 抽出結果を1件破棄しました: ${reason}` +
    ` / 店=${store.label}(${store.venueId})` +
    ` / 投稿=${post.permalink}(${post.postedAt})` +
    ` / date=${JSON.stringify(row && row.date)} / name=${JSON.stringify(row && row.name)}`
  );
}

async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`画像取得に失敗しました(HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * 中核ロジック(依存はすべて注入。ネットワーク/ファイルI/Oを直接行わないのでテストしやすい)。
 * 失敗(Apify取得エラー等)は例外を投げる。呼び出し側はそれを「data.js/状態ファイルを一切書き換えず終了」の
 * 合図として扱うこと(この関数の中では成功した店舗ぶんも含めて何もファイルに書き込まないため安全)。
 *
 * 【不正な抽出行の扱い】data.js に入れてはいけない行(日付が YYYY-MM-DD でない等)は
 * その行だけを捨て、残りは取り込む。例外は投げない(投げると6店ぶん全部が書き込まれず、
 * 状態も進まないため翌日も同じ所で落ちる)。捨てた行は summaries[].dropped に、
 * 「1件も採用できなかった投稿」は anomalies に入れて呼び出し側へ返す。
 *
 * @param {{ stores: Array, before: Array, today: string, state: object }} opts
 * @param {{ fetchLib: object, visionLib: object, mergeLib: object, downloadImage: Function }} libs
 * @returns {Promise<{ arr: Array, state: object, changed: boolean, summaries: Array, anomalies: Array }>}
 */
async function runMonitor(opts, libs) {
  const { stores, before, today, state } = opts;
  const { fetchLib, visionLib, mergeLib, downloadImage: download } = libs;

  let arr = before;
  const nextState = { ...state };
  const summaries = [];
  const anomalies = [];
  let changed = false;

  for (const store of stores) {
    const prev = state[store.venueId] || null;
    const posts = await fetchLib.fetchInstagramPosts(store.handle);

    const newPosts = pickNewPosts(posts, prev && prev.lastPostedAt);
    const summary = {
      store,
      newPostCount: newPosts.length,
      scheduleLikeCount: 0,
      extractedCount: 0,
      droppedCount: 0,
      dropped: [],
      stats: null,
    };

    if (newPosts.length === 0) {
      summaries.push(summary);
      continue;
    }

    const scheduleLike = newPosts.filter((p) => looksLikeSchedulePost(p.caption));
    summary.scheduleLikeCount = scheduleLike.length;

    const extracted = [];
    for (const post of scheduleLike) {
      let imageBuffer;
      try {
        imageBuffer = await download(post.imageUrl);
      } catch (e) {
        console.warn(
          `[monitor-instagram-apify] ${store.label}: 画像ダウンロード失敗、この投稿はスキップ (${post.permalink}): ${e.message}`
        );
        continue;
      }
      let raw;
      try {
        raw = await visionLib.extractTournaments(imageBuffer, { postedDateHint: post.postedAt.slice(0, 10) });
      } catch (e) {
        console.warn(
          `[monitor-instagram-apify] ${store.label}: Vision抽出失敗、この投稿はスキップ (${post.permalink}): ${e.message}`
        );
        continue;
      }
      // Visionの戻り値は無検証では使えない。1行ずつ検査し、不正な行だけを捨てて残りは取り込む。
      const rows = Array.isArray(raw) ? raw : [];
      let keptFromPost = 0;
      const droppedFromPost = [];
      for (const t of rows) {
        const reason = extractedRowProblem(t);
        if (reason) {
          const record = {
            venueId: store.venueId,
            label: store.label,
            permalink: post.permalink,
            postedAt: post.postedAt,
            reason,
            date: t && t.date,
            name: t && t.name,
          };
          droppedFromPost.push(record);
          summary.dropped.push(record);
          console.warn(formatDroppedRow(store, post, t, reason));
          continue;
        }
        extracted.push(toTournament(t, store.venueId));
        keptFromPost += 1;
      }
      // 抽出行はあったのに1件も採用できなかった投稿 = その投稿の内容が丸ごと失われた状態。
      // 確認済み投稿日時は下で前進するので二度と再試行されない。静かに捨てず異常として記録する。
      if (rows.length > 0 && keptFromPost === 0) {
        anomalies.push({
          store,
          permalink: post.permalink,
          postedAt: post.postedAt,
          rowCount: rows.length,
          reasons: [...new Set(droppedFromPost.map((d) => d.reason))],
        });
      }
    }
    summary.extractedCount = extracted.length;
    summary.droppedCount = summary.dropped.length;

    // 新着の確認記録は、Vision抽出の成否に関わらずこの店で確認できた最新投稿まで進める
    // (同じ投稿を毎回「新着」として拾い直し続けないため)。
    const newest = newPosts[newPosts.length - 1];
    nextState[store.venueId] = { handle: store.handle, lastPostedAt: newest.postedAt, lastPermalink: newest.permalink };

    if (extracted.length > 0) {
      const { next, stats } = mergeLib.mergeStore(arr, store.venueId, extracted, today);
      mergeLib.assertOnlyTargetChanged(arr, next, store.venueId, today);
      arr = next;
      changed = true;
      summary.stats = stats;
    }
    summaries.push(summary);
  }

  return { arr, state: nextState, changed, summaries, anomalies };
}

/**
 * 「抽出行はあったのに1件も採用できなかった投稿」を目立つ形で報告する。
 *
 * 【ジョブを失敗させない理由】ここで非ゼロ終了すると、後続ステップ(検査→コミット→push)が
 * 走らず `apify-monitor-state.json` の前進も取り込めた他店のデータもリポジトリに残らない。
 * 結果として翌日も同じ投稿から再試行して同じ所で止まる — 今回直した不具合そのものに戻る。
 * そこで【ジョブは緑のまま通し、GitHub Actions の注記(::error::)で人に見せる】。
 * ローカル実行では単なる1行のログとして出るだけで、動作に影響しない。
 */
function reportAnomalies(anomalies) {
  if (!anomalies || anomalies.length === 0) return;
  console.log('');
  console.error(
    `::error title=Instagram監視 - 取り込めなかった投稿::` +
      `${anomalies.length}件の投稿で、Visionが返した行を1件も採用できませんでした。` +
      `ジョブは継続しています(取り込めた他の行は反映済み)。人の確認が必要です。`
  );
  for (const a of anomalies) {
    console.error(
      `[monitor-instagram-apify] 投稿まるごと不採用: 店=${a.store.label}(${a.store.venueId})` +
        ` / 投稿=${a.permalink}(${a.postedAt}) / 抽出${a.rowCount}件すべて破棄 / 理由=${a.reasons.join(', ')}`
    );
  }
  console.error(
    '[monitor-instagram-apify] これらの投稿は【再試行されません】(確認済み投稿日時が進むため)。' +
      '内容が必要なら `node tools/import-venue-image.js --venue <id> --instagram-url <投稿URL>` で手動取込みしてください。' +
      'すべての店で同じ理由が続く場合は tools/venue-schedule-vision.js のプロンプト/モデルを疑ってください。'
  );
}

async function main() {
  const today = todayJst();
  console.log(`[monitor-instagram-apify] 基準日(JST): ${today}${DRY_RUN ? ' / DRY-RUN' : ''}`);

  if (!process.env.APIFY_API_TOKEN) {
    fail('APIFY_API_TOKEN が未設定です。Apify呼び出しをスキップし、data.js / 状態ファイルは書き換えません。');
  }

  const fetchLib = require('./fetch-venue-posts-apify');
  const visionLib = require('./venue-schedule-vision');
  const mergeLib = require('./tournament-merge');

  const file = mergeLib.readDataJs(DATA_JS);
  const before = file.arr;
  let state;
  try {
    state = loadState(STATE_PATH);
  } catch (e) {
    fail(e.message);
    return;
  }

  let result;
  try {
    result = await runMonitor({ stores: STORES, before, today, state }, { fetchLib, visionLib, mergeLib, downloadImage });
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
    return;
  }

  const { arr, state: nextState, changed, summaries, anomalies } = result;

  for (const s of summaries) {
    console.log('');
    console.log(`[${s.store.label} / ${s.store.venueId} / @${s.store.handle}]`);
    console.log(
      `  新着投稿 ${s.newPostCount}件 / うちスケジュール告知らしき投稿 ${s.scheduleLikeCount}件 / ` +
        `取り込んだトーナメント ${s.extractedCount}件 / 破棄した抽出行 ${s.droppedCount}件`
    );
    if (s.stats) {
      console.log(
        `  追加 ${s.stats.added}件 / 更新 ${s.stats.updated}件 / 変更なし ${s.stats.unchanged}件 / ` +
          `削除(投稿から消滅) ${s.stats.removed}件 / 手入力の置き換え ${s.stats.replacedManual.length}件 / ` +
          `投稿未掲載の手入力 ${s.stats.keptManual.length}件`
      );
    }
  }

  reportAnomalies(anomalies);

  // 対象外店舗・過去日が変化していないことの最終自己チェック(店舗ごとのassertOnlyTargetChangedに加えた二重チェック)
  const targets = new Set(STORES.map((s) => s.venueId));
  const others = (list) => list.filter((t) => !targets.has(t.venueId));
  if (JSON.stringify(others(before)) !== JSON.stringify(others(arr))) {
    fail('対象外の店舗のデータが変化しています(バグ)。書き込みを中止します。');
    return;
  }
  const pastOf = (list) => list.filter((t) => targets.has(t.venueId) && t.date < today);
  if (JSON.stringify(pastOf(before)) !== JSON.stringify(pastOf(arr))) {
    fail('過去日のエントリが変化しています(バグ)。書き込みを中止します。');
    return;
  }

  console.log('');
  if (DRY_RUN) {
    console.log('[monitor-instagram-apify] --dry-run のため data.js / 状態ファイルは書き換えません。');
    return;
  }

  if (!changed) {
    console.log('[monitor-instagram-apify] スケジュール告知の新着は無かったため data.js は書き換えません。');
    if (JSON.stringify(nextState) !== JSON.stringify(state)) {
      saveState(STATE_PATH, nextState);
      console.log('[monitor-instagram-apify] 確認済みの投稿日時のみ apify-monitor-state.json に記録しました。');
    }
    return;
  }

  mergeLib.writeDataJs(DATA_JS, file, arr);
  saveState(STATE_PATH, nextState);
  console.log('[monitor-instagram-apify] data.js と apify-monitor-state.json を更新しました。');
  console.log('[monitor-instagram-apify] 忘れずに `node tools/gen-venue-pages.js .` を実行し、店舗静的ページを再生成してください。');
}

if (require.main === module) {
  main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
}

module.exports = {
  STORES,
  SCHEDULE_KEYWORDS,
  looksLikeSchedulePost,
  pickNewPosts,
  slugify,
  toTournament,
  formatDroppedRow,
  reportAnomalies,
  runMonitor,
  loadState,
  saveState,
  todayJst,
};
