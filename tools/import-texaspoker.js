#!/usr/bin/env node
/**
 * import-texaspoker.js
 *
 * 店舗「てきさすほーるでむ。」(venueId: v16)の公式スケジュールページ(HTML・カレンダー形式)
 * を取得し、トーナメント日程を `data.js` の TOURNAMENTS に upsert する。
 *
 * 対象ページ(認証不要・公開):
 *   GET https://texaspoker.pro/sc/sche3.cgi?year=<year>&mon=<mon>
 *   → Shift_JIS のHTML。月ごとのカレンダーグリッド + 大会ごとの詳細セクション
 *
 * Waitinglist(`tools/import-waitinglist.js`)のような構造化JSON APIは無いため、HTMLを
 * パースして取り出す。設計思想(書き込み前検査・状態管理・保存則)は同じものを踏襲するが、
 * 実装は【`tools/tournament-merge.js` の `mergeStore` をそのまま使う】(自前で複製しない)。
 * 理由: このスクリプトが書くのは Waitinglist と同じ `source: 'auto'`(取得結果=その時点の
 * 完全な今後のスケジュールという前提が成り立つ取得元)で、tournament-merge.js の
 * upsert規則(過去日不可侵・機械所有行の作り直し・人の行/項目の保護)はそのまま当てはまる。
 * import-waitinglist.js が自前の mergeStore を持つのは【店舗数が多く、複製の歴史的経緯が
 * あったため】(tournament-merge.js のヘッダ参照)。今回は新規実装なので、重複を増やさず
 * 共通ロジックを使う。
 *
 * 【リングゲーム(キャッシュゲーム)の除外】
 *   このサイトのカレンダーは「トーナメント」と「リングゲーム(キャッシュゲーム)営業日」を
 *   区別せず同じマス目に並べる(例: `ノーレーキリングゲーム`)。VENUES 側には既に
 *   `v16.ring: true` / `ringNote` として「リング営業もある店」という注記がある(掲載管理コンソール
 *   `fukuoka-poker-admin/admin-state.json` 参照)。TOURNAMENTS はトーナメントだけを載せる配列
 *   なので、リングゲームのマスは【大会名(見出し)がリング/キャッシュゲームを指す語を含むかどうか】
 *   だけで判定して除外する(`isRingRow`)。実測(2026年8-9月ぶん)で確認できた表記は
 *   `ノーレーキリングゲーム` の1種類のみ。将来 `キャッシュゲーム` 等の表記が現れても拾えるよう、
 *   `tools/monitor-instagram-apify.js` の `isNonTournamentFormat`(リングゲーム/キャッシュゲームの
 *   語彙)と同じ語を使う(共有モジュールではなくローカルに複製 — 理由は下記【複製している理由】)。
 *   店休日(`店休日`とだけ書かれ、リンクを持たないマス)は、そもそも大会詳細セクションが
 *   存在しないため自然に対象から外れる(特別な判定コードは不要)。
 *
 * 【複製している理由(2026-08-?? 追記)】
 *   `isNonTournamentFormat` / `normalizeName` は `tools/monitor-instagram-apify.js` /
 *   `tools/venue-listing-rules.js` に既にあるが、前者は Instagram監視専用の巨大なファイル
 *   (Apify・Vision 呼び出しの環境変数前提)で、そこから小さな判定関数だけを取り出して
 *   require すると、無関係な取込み経路同士が結合してしまう(片方の変更がもう片方の
 *   実行を壊しうる)。`import-waitinglist.js` が自前の `mergeStore` を持つ判断
 *   (店ごとに独立した安全性)と同じ理由で、ここでも独立性を優先しローカルに複製する。
 *   ただし `normalizeName` の正規化そのもの(NFKC・小文字化・区切り吸収)は
 *   `tools/venue-listing-rules.js` からそのまま `require` する(あちらが唯一の定義)。
 *
 * 【本文からの項目抽出(開始時刻・参加費・アドオン・スタック・リエントリー可否)】
 *   大会詳細セクションの本文は店が書いた自由文なので、Waitinglist の構造化JSONほど
 *   信頼できない。実測(2026年8-9月・全53件)で以下の書式を確認し、正規表現で抜き出す:
 *     - 開始時刻: `Timer Start 18:15` / `Timer Start…18:15` / `タイマースタート　18:30`
 *     - 参加費:  `Entry Fee:1100y` / `Entry Fee…2200y` / `Entry Fee  Free`(→0)
 *     - アドオン: `Re-Entry/Re-Buy/Add:1100y` / `Add On 550y` / `Add:2200y`
 *     - 初期スタック: `初期スタック3万点` → 30000 / `初期スタック5万点` → 50000
 *   【読み取れない項目は null にする(記法の翻訳はしない)】これは `tools/validate-data.js` /
 *   `tools/monitor-instagram-apify.js` と同じ規律。表記が変わって正規表現が当たらなくなっても、
 *   「大会名と日付は載るが詳細が null になる」だけで、誤った金額・時刻を公開する経路にはならない。
 *
 * 【★リエントリー可否の判定は「無し」の射程を狭く取る(実測で見つけた誤判定を踏まえた設計)】
 *   単純に「本文に『リエントリー』または『Re-Entry』があれば true」にすると、
 *   `超Deep Stuck Freeze Out(2026-08-30)` のように「Entry Fee 3300y」の直後に「※Add on無し」、
 *   本文の別の場所に「リエントリー、アドオン無しのガチンコバトル！」がある行を誤って true にする
 *   (「アドオン無し」という語だけを見て「Add on ... y」を拾えないのは正しいが、「リエントリー」
 *   という語の存在だけで true にすると「無し」を読み飛ばしてしまう)。
 *   一方で `〜力試し〜(2026-09-09)` のように「・Re-Entry 2,500y」(有料で明確に許可)の直後に
 *   「※Re-Buy/Add on 無し」(アドオン側だけ無し)がある行は true が正しい。
 *   この2つを両立させるには、「無し」の直前が【リエントリー/Re-Entry そのもの】(間に
 *   アドオン等の列挙語を挟んでもよい)である場合だけを「明示的な否定」として扱い、
 *   「無し」の前に価格や別の文が挟まる場合(=リエントリー自体は既に許可と書かれている)は
 *   否定とみなさない。実測(全53件・下記テストで固定)でこの2件を含めて誤りなし。
 *   ★★これは所詮ヒューリスティックであり、将来別の言い回しで誤る可能性はゼロではない。
 *     誤った場合の実害は「リエントリー可のバッジが出ない/出る」のどちらかで、後者(false → true
 *     への誤り)の方が実害が大きい(「もう一度買い直せる」という誤った期待を持たせる)ため、
 *     判定に迷う場合は false(バッジを出さない = 何も主張しない)側に倒す設計にしてある
 *     (`index.html` / `tools/venue-schedule.js` は `t.reentry` が truthy のときだけバッジを出す。
 *     false は「リエントリー不可」の主張ではなく「分からないので何も言わない」)。
 *   `guarantee` / `prize` は Waitinglist(`tools/import-waitinglist.js`)と同じ理由で常に null
 *   にする(自由文からの金額推測は誤りの温床。実測でも保証額・賞金の明示表記は見つからなかった)。
 *   タグの名前からの推測もしない(「名前からのタグ推測も行わない(誤タグを撒かないことを優先)」
 *   という Waitinglist の方針をそのまま踏襲。`tags` は常に空配列)。
 *
 * 【安全弁】次のいずれかが起きたら、この店舗のデータを一切書き換えない:
 *   1. fetch失敗 / HTTP 200以外 / ページが要求した年月を反映していない(サイト構造の変化の検知。
 *      カレンダーグリッドの見出し年月と、リクエストした year/mon を突き合わせる)
 *   2. カレンダー内の大会アンカー数と、見出し(年月日+大会名)を読み取れた件数が一致しない
 *      (=HTML構造が変わってパースが一部失敗している。黙って一部だけ捨てない)
 *   3. 取得した月をすべて合わせても大会が0件(店休日だけの月が3ヶ月続くことは想定しにくいため、
 *      サイト側の異常を疑う)
 *   4. 今日以降の件数の急減(前回の半分未満、または一度に10件以上の減少。--allow-shrink で解除)
 *   5. 書き込み直前の自己チェック(対象外の店舗・過去日エントリが変化していないか。
 *      `tools/schedule-write-guard.js`)
 *   6. 書き込み直前の突き合わせ(人の行・人が直した項目が壊れていないか。
 *      `tools/machine-write-state.js`)
 *
 * 【取得範囲】当月 + 翌々月まで(計3ヶ月ぶん・3リクエスト)。実測では当月・前月は必ず
 * 全日程が公開されているが、翌月以降は未公開のことが多い(空のカレンダーが返るだけで
 * エラーにはならない)。3ヶ月先まで見ておけば、月初〜月末のどのタイミングで実行しても
 * 「次に来る未公開分」を取りこぼしにくい。
 *
 * 【状態管理】機械が最後に書いた値の控えは `texaspoker-write-state.json`
 * (`tools/machine-write-state.js` の設計をそのまま使う。書き手ごとにファイルを分けるのは
 * Waitinglist・Instagram監視と同じ理由 — 別のジョブが同じJSONを触ると `git pull --rebase` が
 * 衝突するため)。
 *
 * 【取得のマナー】User-Agent で当サイトのボットとして名乗る(ブラウザを詐称しない)。
 * リクエスト間隔は1秒、1日1回だけ実行する想定(Waitinglist取込みと同じ配慮)。
 *
 * 使い方:
 *   node tools/import-texaspoker.js               … data.js を書き換える
 *   node tools/import-texaspoker.js --dry-run     … 書き込まず、差分サマリだけ出す
 *   node tools/import-texaspoker.js --allow-shrink… 件数の急減ガードを外して実行する
 *
 * 【終了コード】
 *   0 … 全店成功
 *   2 … 一部の店だけ失敗。成功した店のぶんは書き込み済み
 *   1 … 何も書いていない(全店失敗 / data.js を読めない / 自己チェックでバグを検出)
 *
 * 【require しても main() は走らない】(import-waitinglist.js / monitor-instagram-apify.js と
 *   同じガード。ただしこのファイルは他のツールと同じく純粋関数を export しており、テストは
 *   それらを直接 require して使う。export されているのは HTML パース・整形などの純粋関数だけで、
 *   fetch・data.js の読み書きを行う main() 自体は export していない)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 「機械が最後に書いた値」の控えと、そこから導く所有の判定。
const state = require('./machine-write-state');
// 書き込み直前の最終自己チェック(Waitinglist・Instagram監視と共通)。
const guard = require('./schedule-write-guard');
// 安全な upsert の共通ロジック(PR #11 の設計をそのまま踏襲したもの)。自前で複製しない。
const merge = require('./tournament-merge');
// 大会名の正規化(NFKC・小文字化・区切り吸収)。唯一の定義はこちら。
const { normalizeName } = require('./venue-listing-rules');

// ============================================================
// 対象店舗 — 1行足せば店舗を増やせる(想定: 同じ CGI 形式のサイトを使う店が今後増えた場合)
// ============================================================
const STORES = [
  { venueId: 'v16', label: 'てきさすほーるでむ。', baseUrl: 'https://texaspoker.pro/sc/sche3.cgi' },
];

const USER_AGENT = 'fukuokapoker.com-bot/1.0 (+https://fukuokapoker.com/contact.html)';

const MONTHS_TO_FETCH = 3;        // 当月 + 翌々月まで(当月含めて3ヶ月ぶん)
const REQUEST_INTERVAL_MS = 1000; // リクエスト間の待ち時間(礼儀)
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;           // 一時的な失敗のリトライ回数
const RETRY_BASE_MS = 3000;       // リトライ間隔(3秒 → 6秒)

const DATA_JS = path.join(__dirname, '..', 'data.js');
// 掲載管理コンソール向けの「自動取得している店」のリスト(下記 writeStoreList)。
// tools/import-waitinglist.js と共同編集する(理由・複製の規律は同ファイルの
// 「2026-09-01 追記」コメントを参照)。
const STORES_JSON = path.join(__dirname, '..', 'auto-import-stores.json');
// 機械が最後に書いた値の控え。書き手ごとにファイルを分ける理由は
// tools/import-waitinglist.js の同名の定数のコメントを参照。
const WRITE_STATE_JSON = path.join(__dirname, '..', 'texaspoker-write-state.json');
// このスクリプトが書く id はすべて `txp-<venueId>-<anchorId>` で始まる。
// 状態ファイル導入時点(=初回実行時点)で `source: 'auto'` かつこの接頭辞の行があれば、
// 控えが無くても機械のものとして扱う(Waitinglist と同じ seed の考え方)。
// 新規導入のツールなので実際に効くことは無い見込みだが、将来の再導入・障害復旧に備えて置く。
const WRITE_STATE_SEED = { source: 'auto', idPrefix: 'txp-' };

const EXIT_PARTIAL = 2;

const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');
const SHRINK_RATIO = 0.5;
const MAX_ABS_DROP = 10;

// ---------- 小道具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

function todayJst() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

/** {year, month} に n ヶ月を足す(月は1〜12。年またぎに対応)。 */
function addMonths(year, month, n) {
  const total = (year * 12 + (month - 1)) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

const ghMsg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s) => ghMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function fail(msg) {
  console.error(`[import-texaspoker] ERROR: ${msg}`);
  console.error('[import-texaspoker] data.js は書き換えていません。');
  process.exit(1);
}

// ============================================================
// 取得
// ============================================================

async function fetchMonthOnce(baseUrl, year, month) {
  const url = `${baseUrl}?year=${year}&mon=${month}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html',
      // ブラウザを詐称しない。理由は tools/import-waitinglist.js の同名の定数のコメントを参照。
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (${year}-${pad2(month)})`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 公式ページの charset は Shift_JIS。Node 22(フルICUビルド)の TextDecoder は
  // 追加パッケージなしで 'shift_jis' に対応している(iconv 相当の変換を標準APIだけで行う)。
  const html = new TextDecoder('shift_jis').decode(buf);

  // 【安全弁1】ページが要求した年月を反映しているか。
  // 実測: このCGIは不正な mon(0や13等)を渡しても前後の月へ丸めて 200 を返す(エラーにならない)。
  // つまり「200が返った」だけでは要求どおりの月が返っているとは限らない。見出しの年月を
  // 読み取って突き合わせることで、サイト構造の変化(見出しの位置・書式が変わった等)も検知できる。
  const yearMatch = html.match(/<b>(\d{4})年<\/b>/);
  const monthMatch = html.match(/<font size="\+2"><b>(\d{1,2})月<\/b><\/font>/);
  if (!yearMatch || Number(yearMatch[1]) !== year || !monthMatch || Number(monthMatch[1]) !== month) {
    throw new Error(
      `ページの見出しが要求した年月(${year}年${month}月)と一致しません` +
        `(見出し: ${yearMatch ? yearMatch[1] : '?'}年${monthMatch ? monthMatch[1] : '?'}月)。` +
        'サイトの構造が変わった可能性があります。'
    );
  }
  return html;
}

async function fetchMonth(baseUrl, year, month) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchMonthOnce(baseUrl, year, month);
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = RETRY_BASE_MS * attempt;
      console.warn(`[import-texaspoker] 取得失敗 (${attempt}/${MAX_ATTEMPTS}): ${e.message} — ${wait / 1000}秒後に再試行`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ============================================================
// パース
// ============================================================

/** HTMLタグを取り除いて素のテキストにする(<br> は改行に変換)。 */
function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// 【リング/キャッシュゲームを指す語】tools/monitor-instagram-apify.js の
// isNonTournamentFormat と同じ語彙(複製している理由はファイル冒頭のコメント参照)。
const RING_TERMS = ['リングゲーム', 'リング ゲーム', 'ring game', 'ringgame', 'キャッシュゲーム', 'cash game', 'cashgame'];

/** 大会名がリング/キャッシュゲーム(トーナメントではない)を指すか。 */
function isRingRow(name) {
  const key = normalizeName(name);
  if (!key) return false;
  return RING_TERMS.some((w) => key.includes(w));
}

// 開始時刻。「Timer Start 18:15」「Timer Start…18:15」「タイマースタート　18:30」を拾う。
const START_TIME_RE = /(?:Timer Start|タイマースタート)\s*[…:.]*\s*(\d{1,2}):(\d{2})/;

// 参加費。「Entry Fee:1100y」「Entry Fee…2200y」「Entry Fee  Free」を拾う。
// 【★"Free" は y が付かない書式がある(研修フリーロール等)ので、y の要求は数値側だけにする】
const ENTRY_FEE_RE = /Entry Fee\s*[…:.]*\s*(Free|[0-9,]+\s*y)/i;

// アドオン。「Re-Entry/Re-Buy/Add:1100y」「Re-Entry/Re-Buy/Add On 550y」「Add:2200y」
// 「Add On 550y」のいずれも拾う。単独の「Re-Entry 2,500y」(Re-Buy/Addを伴わない)はここでは
// 拾わない — この店の用法では「Re-Entry」単独は「アドオン無し」の再エントリーもあり得るため
// (実測: 〜力試し〜は「Re-Entry 2,500y」の直後に「Re-Buy/Add on 無し」と明記)。
const ADDON_RE = /(?:Re-?Entry\s*\/\s*Re-?Buy\s*\/\s*Add(?:\s*[Oo]n)?|(?:^|\n)\s*・?Add\s*[:：]|Add\s*[Oo]n)\s*[…:.]*\s*([0-9,]+)\s*y/;

// 初期スタック。「初期スタック3万点」→30000 / 「初期スタック50000点」のような桁書きにも対応。
const STACK_RE = /初期スタック\s*([0-9,]+)\s*(万)?点/;

// 【リエントリー可否】「無し」の直前が【リエントリー/Re-Entry そのもの】(間にアドオン等の
// 列挙語を挟んでもよい)である場合だけを明示的な否定として扱う。設計の詳細はファイル冒頭のコメント。
const REENTRY_NEGATIVE_RE = /(?:リエントリー|Re-?Entry)(?:[\s、,\/]*(?:アドオン|Re-?Buy|Add\s*(?:[Oo]n)?))?\s*(?:無し|なし)/i;
const REENTRY_POSITIVE_RE = /Re-?Entry|リエントリー/i;

/** 本文(タグ除去済みの平文)から、抽出できる範囲の項目を読み取る。読めない項目は null。 */
function extractBodyFields(bodyText) {
  const startMatch = bodyText.match(START_TIME_RE);
  const start = startMatch ? `${startMatch[1].padStart(2, '0')}:${startMatch[2]}` : '';

  const feeMatch = bodyText.match(ENTRY_FEE_RE);
  let buyin = null;
  if (feeMatch) buyin = /free/i.test(feeMatch[1]) ? 0 : Number(feeMatch[1].replace(/[^0-9]/g, ''));

  const addonMatch = bodyText.match(ADDON_RE);
  const addon = addonMatch ? Number(addonMatch[1].replace(/[^0-9]/g, '')) : null;

  const stackMatch = bodyText.match(STACK_RE);
  let stack = null;
  if (stackMatch) {
    const n = Number(stackMatch[1].replace(/[^0-9]/g, ''));
    stack = stackMatch[2] ? n * 10000 : n;
  }

  let reentry = false;
  if (REENTRY_NEGATIVE_RE.test(bodyText)) reentry = false;
  else if (REENTRY_POSITIVE_RE.test(bodyText)) reentry = true;

  return { start, buyin, addon, stack, reentry };
}

// 詳細セクションの見出し行。例: "　 2026年9月1日(火)　　<b>アリーナトーナメント</b>"
const HEADER_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日[^<]*<font[^>]*>\([^)]*\)<\/font>[\s　]*<b>([^<]*)<\/b>/;

/**
 * 1ヶ月ぶんのHTMLをパースし、大会1件ずつの生データ配列を返す。
 * リング/キャッシュゲームの行は除外し、件数を ringExcluded に数える。
 *
 * 【安全弁2】アンカー数と見出しを読み取れた件数が一致しなければ例外を投げる
 * (HTML構造が変わって一部だけパースに失敗している=黙って一部を捨てない)。
 */
function parseMonthHtml(html, year, month) {
  const parts = html.split(/<a name="(\d+)">/);
  const anchorCount = Math.floor((parts.length - 1) / 2);
  const rows = [];
  let ringExcluded = 0;
  let headerMismatch = 0;

  for (let i = 1; i < parts.length; i += 2) {
    const anchorId = parts[i];
    const content = parts[i + 1] || '';
    const m = content.match(HEADER_RE);
    if (!m) {
      headerMismatch += 1;
      continue;
    }
    const [, y, mo, d, rawName] = m;
    const name = rawName.trim();
    const date = `${y}-${pad2(Number(mo))}-${pad2(Number(d))}`;

    if (isRingRow(name)) {
      ringExcluded += 1;
      continue;
    }

    const bodyIdx = content.indexOf('本日のお知らせ');
    const bodyHtml = bodyIdx >= 0 ? content.slice(bodyIdx) : content;
    const bodyText = stripTags(bodyHtml);
    const fields = extractBodyFields(bodyText);

    rows.push({ anchorId, date, name, ...fields });
  }

  if (headerMismatch > 0) {
    throw new Error(
      `${year}年${month}月: アンカー${anchorCount}件のうち${headerMismatch}件で見出し` +
        '(年月日・大会名)を読み取れませんでした。サイトの構造が変わった可能性があります。'
    );
  }

  return { rows, ringExcluded };
}

// ============================================================
// 変換
// ============================================================

/**
 * パース結果1件 → data.js の Tournament スキーマ。
 * id はサイト自身が振るアンカー番号を使う(Waitinglist の `wl-<ULID>` と同じ考え方 — 大会名が
 * 多少変わっても同じ大会として追跡できる、店側の採番なので衝突しない)。
 * guarantee / prize は常に null(自由文からの推測は誤りの温床。tools/import-waitinglist.js と
 * 同じ方針)。タグの名前からの推測もしない(tags は常に空)。
 */
function toTournament(row, venueId) {
  return {
    id: `txp-${venueId}-${row.anchorId}`,
    venueId,
    name: row.name,
    date: row.date,
    start: row.start,
    buyin: row.buyin,
    addon: row.addon,
    stack: row.stack,
    guarantee: null,
    reentry: row.reentry,
    prize: null,
    tags: [],
    source: 'auto',
    verified: false,
  };
}

// ============================================================
// data.js の読み書き(tools/tournament-merge.js の共有ロジックを使う)
// ============================================================

// ============================================================
// 自動取得の対象店リスト(掲載管理コンソール向け・tools/import-waitinglist.js と共同編集)
// ============================================================
//
// 【複製している理由】`auto-import-stores.json` は tools/import-waitinglist.js が先に作った
// ファイルで、このスクリプト(v16)も自分の担当店ぶんを書き込む必要がある。単純に「自分の
// STORES から作り直して丸ごと上書き」すると、もう片方のスクリプトが書いた行が消えてしまうので、
// 【自分の担当店(venueId)の行だけを作り直し、それ以外の行はそのまま残す】マージ方式にしてある。
// `GENERATED_BY` / `venueSortKey` / `mergeOwnIntoStoreList` は tools/import-waitinglist.js に
// 同じ内容を複製したもの(このリポジトリの convention どおり、取込み経路どうしを require で
// 結合させないため)。**複製した3つは意味的に同一でなければならない** — 特に `GENERATED_BY` の
// 文字列が2つのスクリプトで食い違うと、日程に変化が無い日でもどちらが最後に実行したかで
// `auto-import-stores.json` の中身が揺れ、無意味なコミットが増える。どちらかを変更したら
// もう片方も同じ文言に直すこと。

/** 掲載管理コンソール向けJSONの `generatedBy`。2つの取込みスクリプトで文言を完全に一致させること(理由は上記)。 */
const GENERATED_BY = '複数の自動取込スクリプト(tools/import-waitinglist.js, tools/import-texaspoker.js)がそれぞれの担当店ぶんをSTORESから生成';

/** venueId ("v16" 等)を並び替え用の数値キーにする。数字部分が無い形式が来ても落ちないよう文字列比較にフォールバックする。 */
function venueSortKey(venueId) {
  const m = /^v(\d+)$/.exec(String(venueId));
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * 既存の stores 配列のうち「自分の担当ではない行」を残しつつ、自分の担当ぶんを作り直して合流する。
 * 実行するスクリプトがどちらでも同じ並び(venueId の数値昇順)になるようにする
 * (実行順で並びが変わると、中身が同じでも差分が出てしまうため)。
 */
function mergeOwnIntoStoreList(existingStores, ownEntries, ownVenueIds) {
  const others = (Array.isArray(existingStores) ? existingStores : []).filter((s) => !ownVenueIds.has(s && s.venueId));
  return others.concat(ownEntries).sort((a, b) => {
    const k = venueSortKey(a.venueId) - venueSortKey(b.venueId);
    return k !== 0 ? k : String(a.venueId).localeCompare(String(b.venueId));
  });
}

/**
 * 有効な STORES の内容を auto-import-stores.json に合流させる(自分の担当店の行だけ作り直す)。
 * 他スクリプト(import-waitinglist.js)が書いた行はそのまま残す。
 *
 * 【毎回同じ内容になること】入れるのは STORES から取れる値だけ(実行時刻・取得件数などは入れない
 * — 日程に変化が無い日でも差分になり、無意味なコミットが増えるため)。内容が変わらないときは
 * 書き込み自体を行わない(mtimeも動かさない)。dryRun=true では書かずに「ズレているか」だけ返す。
 * 書くのは main() が最後まで通ったときだけ(途中の異常検知では data.js と同じく何も書き換えない)。
 */
function writeStoreList(dryRun) {
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(STORES_JSON, 'utf8')); } catch (e) { /* 未生成/壊れている → 他店の行は無いものとして続行 */ }
  const ownVenueIds = new Set(STORES.map((s) => s.venueId));
  const ownEntries = STORES.map((s) => ({
    venueId: s.venueId,
    label: s.label,
    source: 'texaspoker',
  }));
  const stores = mergeOwnIntoStoreList(existing && existing.stores, ownEntries, ownVenueIds);
  const json = JSON.stringify({ generatedBy: GENERATED_BY, stores }, null, 2) + '\n';

  let cur = null;
  try { cur = fs.readFileSync(STORES_JSON, 'utf8'); } catch (e) { /* 未生成 */ }
  if (cur === json) return false;
  if (!dryRun) fs.writeFileSync(STORES_JSON, json);
  return true;
}

// ============================================================
// 1店舗ぶんの取得と検査
// ============================================================

/**
 * 1店舗ぶんを取得し、その店だけで完結する検査をすべて通す。
 * throw する(process.exit しない)。呼び出し側が catch してこの店だけをスキップする。
 */
async function loadStore(store, before, today) {
  const base = todayJst();
  const [by, bm] = base.split('-').map(Number);

  const allRows = [];
  let ringExcludedTotal = 0;
  const months = [];
  for (let i = 0; i < MONTHS_TO_FETCH; i++) {
    const { year, month } = addMonths(by, bm, i);
    months.push({ year, month });
  }

  for (let i = 0; i < months.length; i++) {
    if (i > 0) await sleep(REQUEST_INTERVAL_MS);
    const { year, month } = months[i];
    let html;
    try {
      html = await fetchMonth(store.baseUrl, year, month);
    } catch (e) {
      throw new Error(`${year}年${month}月の取得に失敗: ${e.message}`);
    }
    const { rows, ringExcluded } = parseMonthHtml(html, year, month);
    ringExcludedTotal += ringExcluded;
    allRows.push(...rows);
  }

  const mapped = allRows.map((row) => toTournament(row, store.venueId));

  // 【安全弁3】取得した全月を合わせても0件。
  if (mapped.length === 0) {
    throw new Error(
      `${months.map((m) => `${m.year}年${m.month}月`).join(' / ')} を合わせても大会が0件でした。` +
        'サイト側の異常か構造変化の可能性があります。'
    );
  }

  // 【安全弁4】今日以降の件数の急減(HTTP 200だが中身が欠けている部分障害を検出)。
  const prevFuture = before.filter((t) => t.venueId === store.venueId && t.date >= today).length;
  const nextFuture = mapped.filter((t) => t.date >= today).length;
  const drop = prevFuture - nextFuture;
  if (!ALLOW_SHRINK && prevFuture > 0 && nextFuture < Math.ceil(prevFuture * SHRINK_RATIO)) {
    throw new Error(
      `今日以降の件数が ${prevFuture}件 → ${nextFuture}件 と急減(前回の${Math.round(SHRINK_RATIO * 100)}%未満)。` +
        'サイト側の部分障害の可能性があります(意図した減少なら --allow-shrink)。'
    );
  }
  if (!ALLOW_SHRINK && drop >= MAX_ABS_DROP) {
    throw new Error(
      `今日以降の件数が ${prevFuture}件 → ${nextFuture}件 と一度に${drop}件減っています(上限${MAX_ABS_DROP}件)。` +
        'サイト側の部分障害の可能性があります(意図した減少なら --allow-shrink)。'
    );
  }

  return { mapped, months, ringExcludedTotal, prevFuture, nextFuture };
}

// ============================================================
// main
// ============================================================

async function main() {
  const today = todayJst();
  console.log(`[import-texaspoker] 基準日(JST): ${today}${DRY_RUN ? ' / DRY-RUN' : ''}`);

  const file = merge.readDataJs(DATA_JS);
  const before = file.arr;
  const beforeJson = JSON.stringify(before);

  const writeState = state.readState(WRITE_STATE_JSON);
  if (writeState.broken) {
    console.warn(
      `[import-texaspoker] ⚠ ${path.basename(WRITE_STATE_JSON)} を読めませんでした(壊れている?)。` +
        '控えなしで続行します。人の行は守られますが、auto行に対する人の修正は今回だけ守れません。'
    );
  } else if (writeState.missing) {
    console.log(`[import-texaspoker] ${path.basename(WRITE_STATE_JSON)} はまだありません。初回実行として続行します。`);
  } else {
    console.log(`[import-texaspoker] 機械が書いた値の控え: ${Object.keys(writeState.entries).length}件`);
  }

  const fetched = [];
  const failures = [];
  for (const store of STORES) {
    try {
      const { mapped, months, ringExcludedTotal, prevFuture, nextFuture } = await loadStore(store, before, today);
      console.log(
        `[import-texaspoker] ${store.label}: ${months.map((m) => `${m.year}-${pad2(m.month)}`).join(', ')} を取得 / ` +
          `トーナメント ${mapped.length}件(リング除外 ${ringExcludedTotal}件) / ` +
          `うち ${today} 以降 ${nextFuture}件(前回 ${prevFuture}件)`
      );
      fetched.push({ store, mapped });
    } catch (e) {
      failures.push({ store, message: e.message });
      console.error(`[import-texaspoker] ✗ ${store.label} (${store.venueId}) をスキップ: ${e.message}`);
      console.error(`::error title=${ghProp(`Texaspoker取込に失敗 (${store.label})`)}::${ghMsg(e.message)}`);
    }
  }

  if (failures.length) {
    console.error('');
    console.error(`[import-texaspoker] ===== 取得に失敗した店舗 ${failures.length}/${STORES.length}件 =====`);
    for (const f of failures) console.error(`  ✗ ${f.store.label} (${f.store.venueId}): ${f.message}`);
    console.error('[import-texaspoker] ※ この店のデータは今回いっさい変更しません(前回の内容がそのまま残ります)。');
    console.error('');
  }

  if (!fetched.length) {
    fail(`対象 ${STORES.length}店すべての取得に失敗しました。data.js は書き換えていません。`);
  }

  // マージ(tools/tournament-merge.js の共有ロジック。店ごとに1回ずつ)
  let arr = before;
  const allStats = [];
  const writtenAll = {};
  for (const { store, mapped } of fetched) {
    const { next, stats, written } = merge.mergeStore(arr, store.venueId, mapped, today, {
      records: writeState.entries,
      seed: WRITE_STATE_SEED,
    });
    arr = next;
    Object.assign(writtenAll, written);
    allStats.push({ store, stats });
  }

  for (const { store, stats } of allStats) {
    console.log('');
    console.log(`[${store.label} / ${store.venueId}]`);
    console.log(
      `  追加 ${stats.added}件 / 更新 ${stats.updated}件 / 変更なし ${stats.unchanged}件 / ` +
        `削除(サイトから消滅) ${stats.removed}件 / 人の行を守って見送り ${stats.protected}件 / ` +
        `サイト未掲載の手入力 ${stats.keptManual.length}件`
    );
    console.log(`  うち人手情報(GTD/プライズ/pinnedTags/人手タグ)を引き継いだもの ${stats.carried}件`);
    if (stats.protectedRows.length) {
      console.log(`  人の行を守り、取得した行を書きませんでした ${stats.protectedRows.length}件:`);
      for (const { incoming, existing } of stats.protectedRows) {
        console.log(`    - ${incoming.date} ${incoming.start} 人の行: ${existing.map((e) => `${e.name} (${e.id})`).join(' / ')}`);
        console.log(`      取得した読み値: ${incoming.name} / 参加費 ${incoming.buyin} / スタック ${incoming.stack} (${incoming.id})`);
      }
    }
    if (stats.protectedFields.length) {
      console.log(`  人が直した項目を残しました ${stats.fieldsProtected}項目 / ${stats.protectedFields.length}行:`);
      for (const { entry, fields } of stats.protectedFields) {
        console.log(`    - ${entry.date} ${entry.start} ${entry.name} (${entry.id}): ${fields.join(', ')}`);
      }
    }
    if (stats.removedHumanEdited.length) {
      console.log(`  ⚠ 人が直した行がサイトから消えたため削除しました ${stats.removedHumanEdited.length}件:`);
      for (const { entry, fields } of stats.removedHumanEdited) {
        console.log(`    - ${entry.date} ${entry.start} ${entry.name} (${entry.id}): 直していた項目 ${fields.join(', ')}`);
      }
    }
    if (stats.keptManual.length) {
      console.log('  サイト未掲載のため残した手入力(要目視確認):');
      for (const t of stats.keptManual) console.log(`    - ${t.date} ${t.start} ${t.name} (${t.id}, source=${t.source})`);
    }
  }

  // 【安全弁5】書き込み直前の自己チェック(対象外の店舗・過去日のエントリが変化していないか)。
  const beforeSnapshot = JSON.parse(beforeJson);
  const targets = new Set(fetched.map(({ store }) => store.venueId));
  const verdict = guard.checkNothingElseChanged(beforeSnapshot, arr, {
    targets,
    today,
    othersLabel: '取得に成功した店舗以外',
  });
  for (const line of guard.formatReorderReport(verdict, '[import-texaspoker]')) console.log(line);
  if (!verdict.ok) fail(verdict.message);

  // 【安全弁6】人の行・人が直した項目が1つも壊れていないことの突き合わせ。
  try {
    const recordOf = (t) =>
      Object.prototype.hasOwnProperty.call(writeState.entries, t.id) ? writeState.entries[t.id] : null;
    const isOwned = (t) => state.ownership(t, recordOf(t), WRITE_STATE_SEED).owned;
    const rowProblem = state.findUnownedRowChange(beforeSnapshot, arr, isOwned);
    if (rowProblem) throw new Error(rowProblem);
    const fieldProblem = state.findHumanFieldChange(beforeSnapshot, arr, recordOf);
    if (fieldProblem) throw new Error(fieldProblem);
    const slotProblem = state.findMachineRowInHumanSlot(beforeSnapshot, arr, isOwned);
    if (slotProblem) throw new Error(slotProblem);
  } catch (e) {
    fail(`${e.message}(バグ)。書き込みを中止します。`);
  }

  const changed = JSON.stringify(arr) !== beforeJson;
  console.log('');
  console.log(`[import-texaspoker] TOURNAMENTS 全体: ${before.length}件 → ${arr.length}件 / 変更${changed ? 'あり' : 'なし'}`);

  const nextStateEntries = state.buildNextEntries(writeState.entries, writtenAll, {
    today,
    replacedVenueIds: fetched.map(({ store }) => store.venueId),
    liveIds: new Set(arr.map((t) => t.id)),
  });

  if (DRY_RUN) {
    console.log('[import-texaspoker] --dry-run のため data.js は書き換えていません。');
    if (writeStoreList(true)) {
      console.log('[import-texaspoker] auto-import-stores.json は STORES とズレています(--dry-run 無しで実行すると更新されます)。');
    }
    if (state.writeState(WRITE_STATE_JSON, nextStateEntries, { writtenBy: 'tools/import-texaspoker.js', dryRun: true })) {
      console.log(`[import-texaspoker] ${path.basename(WRITE_STATE_JSON)} も更新対象です(--dry-run のため書いていません)。`);
    }
    return failures.length ? EXIT_PARTIAL : 0;
  }

  // 掲載管理コンソール向けの対象店リスト。data.js に差分があるかどうかとは無関係に、常に
  // STORES と一致させる(下の「変更が無いため書き換えていません」で早期returnする前に処理すること)。
  // 理由は tools/import-waitinglist.js の writeStoreList 呼び出し箇所のコメントと同じ。
  const storeListChanged = writeStoreList(false);
  console.log(`[import-texaspoker] auto-import-stores.json: ${storeListChanged ? '更新しました' : '変更なし'}(対象 ${STORES.length}店)`);

  if (!changed) {
    console.log('[import-texaspoker] 変更が無いため data.js は書き換えていません。');
  } else {
    merge.writeDataJs(DATA_JS, file, arr);
    console.log('[import-texaspoker] data.js を更新しました。');
  }

  const stateChanged = state.writeState(WRITE_STATE_JSON, nextStateEntries, { writtenBy: 'tools/import-texaspoker.js' });
  console.log(
    `[import-texaspoker] ${path.basename(WRITE_STATE_JSON)}: ${stateChanged ? '更新しました' : '変更なし'}` +
      `(控え ${Object.keys(nextStateEntries).length}件)`
  );

  if (failures.length) {
    console.error(
      `[import-texaspoker] 成功 ${fetched.length}店 / 失敗 ${failures.length}店。` +
        `成功したぶんは書き込み済みです。終了コード ${EXIT_PARTIAL} で終わります(ワークフローは赤くなります)。`
    );
    return EXIT_PARTIAL;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((e) => fail(e && e.stack ? e.stack : String(e)));
}

module.exports = {
  STORES,
  addMonths,
  isRingRow,
  stripTags,
  extractBodyFields,
  parseMonthHtml,
  toTournament,
  GENERATED_BY,
  venueSortKey,
  mergeOwnIntoStoreList,
};
