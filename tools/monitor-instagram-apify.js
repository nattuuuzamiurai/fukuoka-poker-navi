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
 *   4. 抽出結果を tools/tournament-merge.js で `data.js` へ安全にupsertする
 *      (`source: 'auto', verified: false`。PR #11(import-waitinglist.js)・PR #14と同じ安全設計:
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
 * 【既知の設計上の割り切り】`source: 'auto'` は「取得結果=その時点の完全な今後のスケジュール」という
 * 前提のupsert規則(tools/tournament-merge.jsのmergeStore、Waitinglist取込みと同じ規則)を使う。
 * Waitinglistの公開APIと違い、Instagramの1投稿が今後の全日程を必ず含むとは限らないため、
 * ある投稿が一部の日程しか含まない場合、その投稿を処理した回で「以前この経路で取り込んだが
 * 今回の投稿には写っていない」自動取込み分が消えることがある(店舗が次の投稿で改めて
 * 全体を載せれば復元される)。人手情報(GTD/プライズ/pinnedTags/人手タグ)は引き継がれるため消えない。
 * この割り切りで問題が頻発するようなら、`source: 'semi'`(tools/import-venue-image.jsと同じ、
 * 「対応が無いものは残す」規則)に倒す変更を検討すること。
 */

'use strict';

const fs = require('fs');
const path = require('path');

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

/** Vision抽出の素の結果1件 → Tournamentスキーマ(source: 'auto', verified: false)。 */
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
    source: 'auto',
    verified: false,
  };
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
 * @param {{ stores: Array, before: Array, today: string, state: object }} opts
 * @param {{ fetchLib: object, visionLib: object, mergeLib: object, downloadImage: Function }} libs
 * @returns {Promise<{ arr: Array, state: object, changed: boolean, summaries: Array }>}
 */
async function runMonitor(opts, libs) {
  const { stores, before, today, state } = opts;
  const { fetchLib, visionLib, mergeLib, downloadImage: download } = libs;

  let arr = before;
  const nextState = { ...state };
  const summaries = [];
  let changed = false;

  for (const store of stores) {
    const prev = state[store.venueId] || null;
    const posts = await fetchLib.fetchInstagramPosts(store.handle);

    const newPosts = pickNewPosts(posts, prev && prev.lastPostedAt);
    const summary = { store, newPostCount: newPosts.length, scheduleLikeCount: 0, extractedCount: 0, stats: null };

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
      for (const t of Array.isArray(raw) ? raw : []) {
        if (t && t.date && t.name) extracted.push(toTournament(t, store.venueId));
      }
    }
    summary.extractedCount = extracted.length;

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

  return { arr, state: nextState, changed, summaries };
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

  const { arr, state: nextState, changed, summaries } = result;

  for (const s of summaries) {
    console.log('');
    console.log(`[${s.store.label} / ${s.store.venueId} / @${s.store.handle}]`);
    console.log(
      `  新着投稿 ${s.newPostCount}件 / うちスケジュール告知らしき投稿 ${s.scheduleLikeCount}件 / 抽出できたトーナメント ${s.extractedCount}件`
    );
    if (s.stats) {
      console.log(
        `  追加 ${s.stats.added}件 / 更新 ${s.stats.updated}件 / 変更なし ${s.stats.unchanged}件 / ` +
          `削除(投稿から消滅) ${s.stats.removed}件 / 手入力の置き換え ${s.stats.replacedManual.length}件 / ` +
          `投稿未掲載の手入力 ${s.stats.keptManual.length}件`
      );
    }
  }

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
  runMonitor,
  loadState,
  saveState,
  todayJst,
};
