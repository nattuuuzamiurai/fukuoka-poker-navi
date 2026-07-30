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
 *   3.5 抽出結果を【正規化してから】検査し、`data.js` に入れてはいけない行【だけ】を捨てる(詳細は下記)。
 *      正規化は tools/validate-data.js の normalizeExtractedRow(`9:00`→`09:00`、
 *      全角コロン、読めない金額はその項目だけ null)、1行だけの検査は同ファイルの
 *      extractedRowProblem(日付書式・実在日・name非空・開始時刻が HH:MM か・金額が数値か)、
 *      行を跨ぐ検査は同ファイルの duplicateIdProblem(id重複)
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
 * 【id重複も層2で捨てる理由(2026-07-31追記)】
 * コミット前ゲートは日付だけでなく id重複・件数も見る。id は
 * `ig-<venue>-<date>-<start>-<slug(name)>` で組み立てるので、Visionが同じ行を2回返した場合や
 * 「同じ日・同じ大会名で開始時刻が読めなかった2行」(どちらも既定の '00:00')で衝突する。
 * さらに slugify() は英数字以外を落とすため、日本語だけの大会名はすべて 'post' に潰れる。
 * これを層2で捨てないと、日付を直したのと同じ理由でジョブが毎日止まる。
 * ただしこれは1行だけでは判定できない検査なので、判定は validate-data.js の duplicateIdProblem に
 * 置き、「今回採用したidの集合」と「data.js側のid→スロット」をこちらが持って渡す。
 *
 * 【捨てる前に直せるものは直す理由(2026-07-31追記 / 層2の前段に正規化を置いた)】
 * 下記のとおり lastPostedAt は採用件数に関係なく無条件で前進するので、捨てた行は
 * 「遅れる」のではなく【自動経路から永久に失われる】。とくに初回実行は6店×直近12投稿の
 * バックログ全体を一度きり・不可逆に消費する。つまり破棄は最も重い処置であり、
 * `9:00`→`09:00` のように【曖昧さゼロ・無損失で直せる】逸脱に使うのは過剰だった。
 * そこで tools/validate-data.js の normalizeExtractedRow を検査の前に通し、
 *   - 開始時刻のゼロ埋め漏れ・全角コロン … 直して採用する(範囲外の 25:00 / 19:70 は従来通り破棄)
 *   - 読み取れない金額(`"3,500"` / `"5000円"`) … その項目だけ null にして【行は残す】
 * とする。正規化した内容は正規化前の値ごとログに出す(Visionの出力形式を人が測るため)。
 *
 * 【捨てすぎ(投稿まるごと不採用)を異常として扱う理由】
 * ある投稿から抽出した行が1件以上あるのに1件も採用できなかった場合、その投稿の内容は
 * サイトのどこにも残らず、しかも確認済み投稿日時が進むので【二度と再試行されない】。
 * 静かに捨てると誰も気づけないため、ジョブは止めない代わりに ::error:: 注記で目立たせ、
 * 手動取込み(tools/import-venue-image.js --instagram-url)の導線をログに出す。
 *
 * 【ただし「同じ投稿の再掲」は異常ではない(2026-07-31追記)】
 * 店が同じ画像を再投稿すると、その投稿の全行が「今回の取込みで既に採用済み」(duplicateIdProblem の
 * kind='duplicate-in-run')として捨てられ、採用0件になる。だが内容は1件目の投稿で取り込めており
 * 【何も失われていない】。これを ::error:: にすると、初回実行という一度きりの run で唯一の
 * 警告チャネルが空振りで埋まり、本物の異常(日付不正等)が読み取れなくなる。そのため
 * 「破棄理由がすべて duplicate-in-run の投稿」は異常から除外し、ログにだけ残す。
 * 一方 kind='existing-slot-conflict'(data.js に同じidで別日時の既存がある)は内容がどこにも
 * 入らないままなので、従来どおり異常として扱う。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 「data.js に入れてよい行か」の判定はコミット前ゲート(tools/validate-data.js)と同じものを使う。
// 二重に書くと必ず片方が古くなり、「抽出側は通すのにゲートで落ちる=ジョブが毎日止まる」ズレが生じる。
// normalizeExtractedRow は検査の前段(直せる逸脱を直す)、extractedRowProblem は1行だけの検査、
// duplicateIdProblem は行を跨ぐ検査(id重複)。
const { normalizeExtractedRow, extractedRowProblem, duplicateIdProblem } = require('./validate-data');

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
 * 【必ず normalizeExtractedRow を通した行を渡すこと】— id は start から組み立てるので、
 * `9:00` のまま渡すと id が `-900-` になり、同日内の並び順(start の文字列比較)も狂う。
 *
 * `source: 'auto'`ではなく`'semi'`にしているのは、対象店舗が「1投稿1イベント」形式で運用されており
 * 1回の投稿取得結果が今後の全日程を含むとは限らないため(詳細は本ファイル冒頭のコメント参照)。
 * `'semi'`ならtools/tournament-merge.jsのmergeStoreで「対応する(date,start)が無いものは残す」
 * 規則が適用され、複数投稿にまたがる日程が消えずに積み上がっていく。
 *
 * 【buyin/stack の既定値が 0 ではなく null な理由(2026-07-31修正)】
 * 0 は「0円 = 無料」という【読み取れた値】で、null が「読み取れなかった」。Visionが金額を
 * 返さなかった/読めない値を返した(正規化で null に倒れた)のは後者なので、0 にしてはいけない。
 * 表示はどちらも「詳細は店舗SNSを確認」(index.html / tools/venue-schedule.js の vpBuyin)で
 * 変わらないが、データとしての意味が逆になる。
 */
function toTournament(t, venueId) {
  const start = t.start || '00:00';
  return {
    id: `ig-${venueId}-${t.date}-${String(start).replace(':', '')}-${slugify(t.name)}`,
    venueId,
    name: String(t.name).trim(),
    date: t.date,
    start,
    buyin: t.buyin != null ? Number(t.buyin) : null,
    addon: t.addon != null ? Number(t.addon) : null,
    stack: t.stack != null ? Number(t.stack) : null,
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

/**
 * 正規化した抽出行1件のログ。【正規化前の値を必ず残す】 — これが無いと
 * 「Visionが実際にどんな形で返しているか」を人が測れず、プロンプトを直す判断ができない。
 */
function formatNormalizedRow(store, post, row, notes) {
  const detail = notes
    .map((n) => `${n.field}: ${JSON.stringify(n.from)} → ${JSON.stringify(n.to)}(${n.reason})`)
    .join(' / ');
  return (
    `[monitor-instagram-apify] 抽出結果を正規化しました: ${detail}` +
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
  // 今回の取込みで既に採用した id。id は venueId を含むので店を跨いだ衝突は起きないが、
  // 「同じ投稿が2回、同じ行を返す」「同じ日・同じ大会名で start が読めなかった2行」の衝突を拾う。
  const usedIds = new Set();
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
      normalizedCount: 0,
      normalized: [],
      unusablePostCount: 0,
      repostedPostCount: 0,
      stats: null,
    };

    if (newPosts.length === 0) {
      summaries.push(summary);
      continue;
    }

    const scheduleLike = newPosts.filter((p) => looksLikeSchedulePost(p.caption));
    summary.scheduleLikeCount = scheduleLike.length;

    // data.js 側の id → スロット。mergeStore は (date,start) が一致する既存しか置き換えないので、
    // 「同じidだがスロットが違う」既存があると両方残って id が重複する(人が admin.html で
    // 日時だけ直した場合など)。この店の処理を始める時点の arr から作る。
    const existingIdSlots = new Map(arr.map((t) => [t.id, `${t.date} ${t.start}`]));

    const extracted = [];
    let unusablePosts = 0; // 抽出行はあったのに1件も採用できなかった投稿の数(異常)
    let repostedPosts = 0; // 全行が「既に取込み済み」だった投稿の数(再投稿。異常ではない)
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
      // Visionの戻り値は無検証では使えない。1行ずつ「直せるものは直してから」検査し、
      // それでも不正な行だけを捨てて残りは取り込む。
      const rows = Array.isArray(raw) ? raw : [];
      let keptFromPost = 0;
      const droppedFromPost = [];
      for (const t of rows) {
        // 正規化(`9:00`→`09:00`、読めない金額はその項目だけ null)→ 1行だけの検査 →
        // 通ったらエントリを組み立てて、行を跨ぐ検査(id重複)。
        // 【検査もエントリ生成も正規化後の row を使うこと】— id と同日内の並び順が start に依存する。
        const { row, notes } = normalizeExtractedRow(t);
        if (notes.length) {
          summary.normalized.push({
            venueId: store.venueId,
            permalink: post.permalink,
            notes,
            name: row && row.name,
          });
          console.warn(formatNormalizedRow(store, post, row, notes));
        }
        let reason = extractedRowProblem(row);
        let kind = reason ? 'row' : null;
        let entry = null;
        if (!reason) {
          entry = toTournament(row, store.venueId);
          const dup = duplicateIdProblem(entry, usedIds, existingIdSlots);
          if (dup) {
            reason = dup.reason;
            kind = dup.kind;
          }
        }
        if (reason) {
          const record = {
            venueId: store.venueId,
            label: store.label,
            permalink: post.permalink,
            postedAt: post.postedAt,
            reason,
            kind,
            date: row && row.date,
            name: row && row.name,
          };
          droppedFromPost.push(record);
          summary.dropped.push(record);
          console.warn(formatDroppedRow(store, post, row, reason));
          continue;
        }
        usedIds.add(entry.id);
        extracted.push(entry);
        keptFromPost += 1;
      }
      // 抽出行はあったのに1件も採用できなかった投稿 = その投稿の内容が丸ごと失われた状態。
      // 確認済み投稿日時は下で前進するので二度と再試行されない。静かに捨てず異常として記録する。
      //
      // 【例外】破棄理由が【すべて】「今回の取込みで既に採用済み」(duplicate-in-run)なら、
      // それは店が同じ画像を再投稿しただけで、内容は1件目の投稿から取り込めている=何も失われていない。
      // これを異常にすると、初回実行という一度きりの run で唯一の警告チャネル(::error::)が
      // 空振りで埋まり、本物の異常が読めなくなる。ログには残す(上の破棄ログ+下の1行)。
      // なお「再投稿だが、その画像に元々読めない行も含まれていた」場合(重複+別理由の混在)は
      // 異常として上げる。その行はどの投稿からも取り込めておらず、本当に失われているため。
      if (rows.length > 0 && keptFromPost === 0) {
        const allAlreadyImported =
          droppedFromPost.length > 0 && droppedFromPost.every((d) => d.kind === 'duplicate-in-run');
        if (allAlreadyImported) {
          repostedPosts += 1;
          console.log(
            `[monitor-instagram-apify] 再投稿と判断しました(異常ではありません): 店=${store.label}(${store.venueId})` +
              ` / 投稿=${post.permalink}(${post.postedAt}) / 抽出${rows.length}件はすべて既に取込み済みの行と同一のため、` +
              'この投稿からの追加はありません。'
          );
        } else {
          unusablePosts += 1;
          anomalies.push({
            store,
            permalink: post.permalink,
            postedAt: post.postedAt,
            rowCount: rows.length,
            reasons: [...new Set(droppedFromPost.map((d) => d.reason))],
          });
        }
      }
    }
    summary.extractedCount = extracted.length;
    summary.droppedCount = summary.dropped.length;
    summary.normalizedCount = summary.normalized.length;
    summary.unusablePostCount = unusablePosts;
    summary.repostedPostCount = repostedPosts;

    // 新着の確認記録は、Vision抽出の成否に関わらずこの店で確認できた最新投稿まで進める
    // (同じ投稿を毎回「新着」として拾い直し続けないため)。
    const newest = newPosts[newPosts.length - 1];
    nextState[store.venueId] = { handle: store.handle, lastPostedAt: newest.postedAt, lastPermalink: newest.permalink };

    // 抽出品質を【記録として残す】。GitHub Actions の注記は緑のrunでは通知が飛ばず、
    // runログも既定90日で消えるため、注記だけでは「Visionの抽出品質を人が測れる」を満たせない。
    // この状態ファイルは元から毎回コミットされるので、ここに書けばgit履歴に差分として残り、
    // ダッシュボードからも読める。Vision抽出を実際に行った店だけ更新し、行っていない店は
    // 前回値をそのまま持ち越す(毎回変わる値を足して無意味な日次差分を増やさないため)。
    if (scheduleLike.length > 0) {
      nextState[store.venueId].lastExtraction = {
        checkedAt: today,
        posts: scheduleLike.length,
        kept: extracted.length,
        dropped: summary.droppedCount,
        // 正規化した行数と再投稿と判断した投稿数も残す。これが無いと
        // 「dropped が多いのに unusablePosts が 0」の理由(=再投稿)が状態ファイルから読めず、
        // Visionの出力形式がどれだけ揺れているか(normalized)も測れない。
        normalized: summary.normalizedCount,
        unusablePosts,
        reposts: repostedPosts,
      };
    } else if (prev && prev.lastExtraction) {
      nextState[store.venueId].lastExtraction = prev.lastExtraction;
    }

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
 *
 * 【必ず stdout に出すこと(console.error ではなく console.log)】
 * GitHub のワークフローコマンドは "sent to the runner over stdout" と規定されており、
 * stderr で認識される保証が無い。console.error にすると注記が付かず、この報告が誰にも届かない。
 *
 * なお注記は「緑のrunに赤い注記が付く」だけなので通知は飛ばず、runログも既定90日で消える。
 * 件数の記録は apify-monitor-state.json の lastExtraction 側(コミットされ、git履歴に残る)が持つ。
 */
function reportAnomalies(anomalies) {
  if (!anomalies || anomalies.length === 0) return;
  console.log('');
  console.log(
    `::error title=Instagram監視 - 取り込めなかった投稿::` +
      `${anomalies.length}件の投稿で、Visionが返した行を1件も採用できませんでした。` +
      `ジョブは継続しています(取り込めた他の行は反映済み)。人の確認が必要です。`
  );
  for (const a of anomalies) {
    console.log(
      `[monitor-instagram-apify] 投稿まるごと不採用: 店=${a.store.label}(${a.store.venueId})` +
        ` / 投稿=${a.permalink}(${a.postedAt}) / 抽出${a.rowCount}件すべて破棄 / 理由=${a.reasons.join(', ')}`
    );
  }
  console.log(
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
        `取り込んだトーナメント ${s.extractedCount}件 / 正規化した抽出行 ${s.normalizedCount}件 / ` +
        `破棄した抽出行 ${s.droppedCount}件 / 再投稿(取込み済み)の投稿 ${s.repostedPostCount}件 / ` +
        `1行も採用できなかった投稿 ${s.unusablePostCount}件`
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
  formatNormalizedRow,
  reportAnomalies,
  runMonitor,
  loadState,
  saveState,
  todayJst,
};
