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
 * バックログ全体を一度きり・不可逆に消費する。そこで tools/validate-data.js の
 * normalizeExtractedRow を検査の前に通し、
 *   - 開始時刻の【書式の揺れ】(ゼロ埋め漏れ・全角・前後の空白) … 直して採用する
 *   - 読み取れない金額(`"3,500"` / `"5000円"`) … その項目だけ null にして【行は残す】
 * とする。正規化した内容は正規化前の値ごとログに出す(Visionの出力形式を人が測るため)。
 *
 * 【直すのは書式の揺れだけで、記法の翻訳(`7pm`→`19:00`、`19時`→`19:00`)はしない】
 * `7pm` も一意に決まるが、翻訳ルールを1つ足すごとに【誤った開始時刻を公開する】経路が増える。
 * 開始時刻の誤りはプレイヤーが違う時間に店へ行く実害で、「大会が1件載らない」より重い。
 * 書式の揺れの補正にはこの危険が無い(情報を1ビットも足していない)。この線引きは
 * 実測で覆せる — 捨てた生値は破棄ログに、直した件数は lastExtraction.normalized に残るので、
 * `19時` が実際に頻出すると分かってからルールを足すこと(想像で先回りしない)。
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
  return pickNewPostsWithStats(posts, lastPostedAt).posts;
}

/**
 * pickNewPosts と同じ選別を行い、【何件をどの理由で落としたか】も返す。
 *
 * 【なぜ内訳が要るか】この関数は2種類の投稿を静かに捨てる:
 *   1. postedAt が読めない投稿(不正データ)
 *   2. 既に確認済みの投稿(正常。毎回拾い直さないための仕組み)
 * 1は【消失】で2は【正常】だが、どちらも結果は「配列から消える」で区別が付かなかった。
 * 保存則の左辺(scheduleLikeCount)はこの選別より【後】の値なので、ここで落ちた投稿は
 * どのカウンタにも現れない。取込みの上流まで遡って数えられるようにする。
 *
 * 【★件数は残差で数えないこと★】`all.length - valid.length` や
 * `sorted.length - fresh.length` のような引き算にすると、呼び出し側の保存則
 * (checkIntakeAccounting)が恒等式になり何も検査しなくなる。この先ここに絞り込みが
 * 1段増えただけで、消えた投稿がそのまま「日時が読めない」「既読」に吸い込まれ、
 * 【未読の投稿が黙って消えたのに「既読」と誤報される】。必ず性質そのものを数えること。
 * (tournament-merge.js の pastDated が同じ罠にはまった。理由はそちらのコメントに詳しい)
 *
 * @returns {{ posts: Array, invalidPostedAt: number, alreadySeen: number }}
 */
const hasReadablePostedAt = (p) => Boolean(p && p.postedAt && !Number.isNaN(Date.parse(p.postedAt)));

function pickNewPostsWithStats(posts, lastPostedAt) {
  const all = Array.isArray(posts) ? posts : [];
  const valid = all.filter(hasReadablePostedAt);
  const invalidPostedAt = all.filter((p) => !hasReadablePostedAt(p)).length;
  const sorted = [...valid].sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  const lastMs = lastPostedAt ? Date.parse(lastPostedAt) : NaN;
  if (!lastPostedAt || Number.isNaN(lastMs)) {
    // 記録が無い(初回)= 「既読」の投稿は1件も無い。これは残差ではなく事実として0。
    return { posts: sorted, invalidPostedAt, alreadySeen: 0 };
  }
  const fresh = sorted.filter((p) => Date.parse(p.postedAt) > lastMs);
  const alreadySeen = sorted.filter((p) => Date.parse(p.postedAt) <= lastMs).length;
  return { posts: fresh, invalidPostedAt, alreadySeen };
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
/**
 * 「この行は大会ではない」ことを判定する。
 *
 * 【設計をやり直した経緯(2026-08-01)】
 * 最初は「トーナメントである積極的な証拠(開始時刻/参加費/スタック/保証額)を1つも持たない行は
 * 大会として扱わない」という【構造だけの判定】にした。語彙に依存しないので漏れない、と考えたが、
 * **これは誤りだった**。実際の画像を確認したところ:
 *   v20 8月分 … 月間カレンダーに【大会名のみ】。時刻の記載なし
 *   v18 8月分 … 【大会名と日付のみ】。時刻・参加費とも記載なし
 * つまり `FST SATELLITE` `華金` `DEEP STACK` のような【正当な大会】も証拠ゼロで、
 * 定休日のマスとまったく同じ形をしている。構造判定は
 * 「大会か否か」ではなく「詳細が書かれているか否か」を見ていただけで、
 * **v18の30行がまるごと消える**ところだった。
 *
 * 【結論: 構造では分離できない】「休み」と「FST SATELLITE」を分けているのは
 * 【名前の意味】だけ。したがってここは語で判定するしかなく、**語のリストは必ず漏れる**。
 * そこで「漏れない判定」を目指すのをやめ、**漏れた場合の被害を抑える多層防御**にした:
 *   1. ここ(語の判定)で、よくある表現を落とす
 *   2. 証拠ゼロの行は捨てずに `lowConfidence: true` を付ける
 *      → サイトに【⚠ 要確認】バッジが出る。漏れた定休日も、詳細未定の大会も、
 *        どちらに対しても表示の意味が正しい
 *   3. 公開前は⑤(人による全件照合)が最後の関門
 */
const CLOSURE_TERMS = [
  '休み',
  'お休み',
  '定休日',
  '休業',
  '休館',
  'closed',
  'close',
  'holiday',
  'no game',
  'nogame',
  'off',
];

/** 正規化(全角→半角・小文字・区切りの揺れ吸収)。名前の判定はすべてこれを通す。 */
function normalizeName(name) {
  return String(name == null ? '' : name)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・/\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 定休日・休業のマスか。
 * 記号だけ(`×` `✕` `-` `—` `ー`)や空に近い名前もここで落とす。
 */
function isClosureRow(name) {
  const key = normalizeName(name);
  if (!key) return true;
  if (/^[×✕xx*ー—–\-~〜・.,、。\s]+$/u.test(key)) return true;
  // 【★部分一致にしないこと★】`some((w) => key.includes(w))` にすると、短い語が
  // 単語の内側で一致して【正当な大会を落とす】。実測では
  //   OFFICIAL TOURNAMENT / PLAYOFF / KICK OFF / TAKE OFF(← 'off')
  //   夏休みスペシャル / 冬休みトナメ(← '休み')
  //   HOLIDAY SPECIAL / CLOSE THE DEAL
  // が破棄され、12件中10件が過剰破棄だった。対象6店は英語名を多用するので理論上の話ではない。
  //
  // しかも【層1で捨てた行は層2に届かない】— 「⚠を付けて残す」多層防御に到達しないまま、
  // 内容が完全に失われ、lastPostedAt は前進するので再試行もされない。
  //
  // そこで isHeadingRow と同じ形にする: 休業語を取り除いて【何も残らない】ときだけ休業とみなす。
  // 副作用として `本日休み` `お休みです` のような複合表現は漏れるが、
  // 漏れた定休日は証拠ゼロなので lowConfidence(⚠要確認)が付き、層2が受け止める。
  // 【非対称性】漏れ=⚠付きで公開(⑤で拾える) / 過剰破棄=完全に失われ再試行なし。
  let rest = key;
  for (const w of [...CLOSURE_TERMS].sort((a, b) => b.length - a.length)) rest = rest.split(w).join(' ');
  rest = rest.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return rest === '';
}

/**
 * 画像の見出しを行として拾ったものか。
 * `月間TOURNAMENT` のように【大会の固有性がなく、日程表そのものを指す語だけ】でできた名前。
 * 部分一致にすると `FST TOURNAMENT` のような正当な名前まで落ちるので、
 * **見出し語を取り除いたあとに何も残らない場合だけ**見出しとみなす。
 */
const HEADING_WORDS = ['月間', 'tournament', 'tournaments', 'schedule', 'スケジュール', 'トーナメント', '大会', '予定', '日程', 'monthly'];

function isHeadingRow(name) {
  const key = normalizeName(name);
  if (!key) return false;
  let rest = key;
  for (const w of HEADING_WORDS) rest = rest.split(w).join(' ');
  // 年号(2026)や記号だけが残るのも見出し扱い
  rest = rest.replace(/[0-9]{2,4}/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return rest === '';
}

/**
 * トーナメントである積極的な証拠(開始時刻/参加費/スタック/保証額)を持つか。
 *
 * 【もう「落とす」ためには使わない】上の経緯のとおり、証拠ゼロでも正当な大会はある。
 * 現在の用途は【`lowConfidence`(⚠要確認)を付けるかの判断】。
 * `buyin: 0` は「無料」という読み取れた値なので証拠として数える(フリーロールは実在する)。
 */
function tournamentEvidence(t) {
  const has = (v) => v != null && String(v).trim() !== '';
  return {
    start: has(t && t.start),
    buyin: has(t && t.buyin),
    stack: has(t && t.stack),
    guarantee: has(t && t.guarantee),
  };
}

/**
 * 名前に「金額そのもの」を表すトークンが含まれるか。
 *
 * 【意味の推測はしない】`1K` が参加費なのかバウンティ額なのかは判断しない。
 * 「その数字は名前から来た可能性がある」という**観測だけ**を返す。
 */
const MONEY_TOKEN_IN_NAME = /(free|フリーロール|フリロ|無料|[0-9]+\s*k(?![a-z])|[0-9]+\s*円|[0-9]+\s*yen|¥\s*[0-9])/i;

function nameContainsMoneyToken(name) {
  return MONEY_TOKEN_IN_NAME.test(normalizeName(name));
}

/**
 * トーナメントである証拠を持つか(= ⚠要確認 を付けずに済むか)。
 *
 * 【名前由来の可能性がある buyin は証拠に数えない】
 * Visionは画像に金額が無くても `FREE ROLL`→0 / `1K MULTI`→1000 のように
 * **大会名から参加費を推論して返すことがある**。値自体は妥当なことが多いが、
 * これを証拠として数えると【⚠要確認バッジが消える】。すると
 *   ・誤った参加費が公開される
 *   ・かつ、それを疑えと伝える唯一の表示も消える
 * が**重なる**。しかも画像に数字はあるので⑤(人の照合)でも一致して見え、見抜けない。
 * ⑤を最後の関門にしてきたこの案件で、**⑤の外側に落ちる唯一の経路**だった。
 *
 * そこで「証拠が buyin だけ」かつ「名前に金額トークンがある」行は証拠なしとして扱い、
 * ⚠を残す。**参加費の値そのものは消さない**(消す方が情報を失う)。
 */
function hasTournamentEvidence(t) {
  const e = tournamentEvidence(t);
  if (e.start || e.stack || e.guarantee) return true;
  if (!e.buyin) return false;
  return !nameContainsMoneyToken(t && t.name);
}

/**
 * トーナメントではない【競技形式】か。
 *
 * 【なぜここは語で判定してよいか】ポーカーの競技形式は
 * リングゲーム(=キャッシュゲーム)のように**名前が安定した有限の集合**で、
 * かつ参加費が書かれていることがある。「休業を表す無限の言い回し」とは性質が違う。
 */
const NON_TOURNAMENT_FORMATS = ['リングゲーム', 'リング ゲーム', 'ring game', 'ringgame', 'キャッシュゲーム', 'cash game', 'cashgame'];

function isNonTournamentFormat(name) {
  const key = normalizeName(name);
  if (!key) return false;
  return NON_TOURNAMENT_FORMATS.some((w) => key.includes(w));
}

/**
 * Visionが返したタグを、サイトが実際に使っている語彙に寄せる。
 *
 * 【なぜ必要か】2026-08-01 の dry-run で、Visionは `satellite`(12件) `freeroll`(4件)
 * `deep stack` / `deepstack`(5件) `mystery・bounty`(2件) のように【英語小文字】で返した。
 * サイト側の語彙は `サテライト`(200件) `フリーロール`(72) `ディープ`(32) `バウンティ`(20) で、
 * そのまま入れると**タグ絞り込みが機能しない**(同じ意味のタグが2種類に割れる)。
 *
 * 【プロンプトで「日本語で」と書くだけにしないこと】このリポジトリの原則どおり、
 * LLMの指示遵守を正しさの担保に使わない。プロンプトにも書くが、効いているのはこの変換。
 *
 * 【未知のタグは捨てる】通す設計にすると、`freezeout` `special` のような
 * サイトに存在しない語がそのまま増え、タグ絞り込みの選択肢を汚す。
 * 捨てても大会自体は残るので損失は小さい。
 * **捨てた事実は取込み側が正規化ログ(summary.normalized)に記録する**
 * (`droppedTags` を使う。この関数自体は notes を持たないので、記録は呼び出し側の責任)。
 */
const TAG_CANONICAL = new Map([
  ['satellite', 'サテライト'],
  ['サテライト', 'サテライト'],
  ['freeroll', 'フリーロール'],
  ['free roll', 'フリーロール'],
  ['フリーロール', 'フリーロール'],
  ['deepstack', 'ディープ'],
  ['deep stack', 'ディープ'],
  ['deep', 'ディープ'],
  ['ディープ', 'ディープ'],
  ['ディープスタック', 'ディープ'],
  ['bounty', 'バウンティ'],
  ['mystery bounty', 'バウンティ'],
  ['mystery', 'バウンティ'],
  ['バウンティ', 'バウンティ'],
  ['ミステリーバウンティ', 'バウンティ'],
  ['turbo', 'ターボ'],
  ['ターボ', 'ターボ'],
  ['plo', 'PLO'],
  ['mix', 'ミックス'],
  ['ミックス', 'ミックス'],
  ['league', 'リーグ'],
  ['リーグ', 'リーグ'],
  ['special', '特別開催'],
  ['特別開催', '特別開催'],
  ['jopt', 'JOPT'],
  ['wjpt', 'WJPT'],
  ['fst', 'FST'],
]);

/** タグ1つを正規化する。未知なら null(=捨てる)。 */
function canonicalTag(tag) {
  if (tag == null) return null;
  // 全角/半角・大文字小文字・区切り(・, /, -, 全角空白)の揺れを吸収してから引く。
  const key = String(tag)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・/\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key) return null;
  if (TAG_CANONICAL.has(key)) return TAG_CANONICAL.get(key);
  // `mystery・bounty` のような複合語は、含まれる既知語のうち最も長いものに寄せる。
  for (const [k, v] of [...TAG_CANONICAL].sort((a, b) => b[0].length - a[0].length)) {
    if (key.includes(k)) return v;
  }
  return null;
}

/** タグ配列を正規化する(未知は捨て、重複は畳む)。 */
function canonicalTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const c = canonicalTag(t);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** サイトの語彙に無くて捨てられるタグを返す(記録用)。 */
function droppedTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => canonicalTag(t) === null && String(t == null ? '' : t).trim() !== '');
}

function toTournament(t, venueId) {
  // 【★読み取れなかった開始時刻を '00:00' で埋めないこと★】
  // '00:00' は「深夜0時開始」という【読み取れた値】であり、サイトはそのまま「00:00」と表示する
  // (venue-schedule.js / index.html はどちらも `t.start || '—'`)。つまり
  // 【プレイヤーが深夜0時に店へ行く】という実害に直結する。
  // 既存618件に '00:00' は1件も無い一方、**184件が start:'' を使っており**、
  // それは「—」と表示される。「読み取れなかった」の正しい表現は空文字の方。
  // これは buyin で `0`(=無料という読み取れた値)を既定値にしないのと同じ規律。
  const start = t.start == null ? '' : String(t.start);
  // idの時刻部分。空のときは 'nostart' を置く(空文字だと `--` が並んで境界が読めなくなる)。
  // 同じ日・同じ名前で時刻が読めない行が2つあれば id は衝突するが、それは
  // 【区別できないものを区別できないと言っている】だけで正しい。duplicateIdProblem が拾う。
  const startKey = start ? start.replace(':', '') : 'nostart';
  const entry = {
    id: `ig-${venueId}-${t.date}-${startKey}-${slugify(t.name)}`,
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
    tags: canonicalTags(t.tags),
    source: 'semi',
    verified: false,
  };
  // 【証拠ゼロの行は捨てずに印を付ける】開始時刻・参加費・スタック・保証額がどれも読めない行は
  // 「詳細未定の大会」か「語の判定から漏れた定休日」のどちらか。機械には区別できないので、
  // サイトに【⚠ 要確認】を出す(既存の lowConfidence バッジ)。
  // どちらの場合でも表示の意味が正しく、⑤(人の全件照合)が最後の関門になる。
  if (!hasTournamentEvidence(t)) entry.lowConfidence = true;
  return entry;
}

/**
 * 破棄した抽出行1件を、人が追跡できる1行のログにする。
 * 「どの店の・どの投稿の・どんな値だったか」が揃っていないとVisionの抽出品質を測れないので、
 * 理由 / 店 / 投稿URL / 投稿日時 / 実際の date と name をすべて出す。
 */
/**
 * キャプションから【本文を出さずに】較正の判断材料になる機械的な信号だけを取り出す。
 *
 * 信号の意味:
 *   chars       … 文字数。とくに【0 = キャプションが無い】が重要で、これが分かるだけで
 *                 「画像だけの日程投稿」= キーワード方式では構造的に永久に拾えない、と原因が確定する
 *   hasDateLike … `8月` `8/1` のような日付らしき並びがあるか
 *   hasTimeLike … `19:30` `19時` のような時刻らしき並びがあるか
 * 全角数字も拾う(店の告知は全角混じりが多い)。
 *
 * 【★この2つは「片側の証拠」として読むこと★】
 *   あり ⇒ 日程告知の可能性が高い(キーワード側を疑う根拠になる)
 *   なし ⇒ 【何も言えない】
 * 例えば `AUGUST SCHEDULE` は数字を1つも含まないので「日付=なし / 時刻=なし」と出るが、
 * これは紛れもない日程告知である。**「両方なし」を「日程告知ではない」と読むと、
 * 4本目の経路(キーワード不一致)の較正判断を誤る。**
 */
/** 日付レンジの集計に使ってよい書式(YYYY-MM-DD ゼロ埋め)。 */
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CAPTION_DATE_LIKE = /[0-9０-９]{1,2}\s*[/／月]/;
const CAPTION_TIME_LIKE = /[0-9０-９]{1,2}\s*[:：時]/;

/**
 * 「実質的に空」と見なす文字。半角/全角の空白・改行は `trim()` が落とすが、
 * 【ゼロ幅スペース(U+200B等)は落とさない】ので明示的に除く。
 * 全角スペースだけ・ゼロ幅スペースだけのキャプションは looksLikeSchedulePost では
 * 空文字と同じく【構造的に永久に拾えない】ため、`キャプション3字` のように出すと
 * 「短いだけだからキーワードを足せば拾えるかも」と誤読される。
 */
const CAPTION_BLANK_CHARS = /[\s\u200B-\u200D\u2060\uFEFF]/g;

function captionSignals(caption) {
  const text = String(caption || '');
  return {
    chars: [...text].length,
    isBlank: text.replace(CAPTION_BLANK_CHARS, '') === '',
    hasDateLike: CAPTION_DATE_LIKE.test(text),
    hasTimeLike: CAPTION_TIME_LIKE.test(text),
  };
}

/**
 * キーワード判定(looksLikeSchedulePost)で落とした投稿を1行にする。
 *
 * この経路は画像を1度も見ずに投稿を捨て、それでいて lastPostedAt は前進する。
 * 件数だけでは「日程を投稿していない店」なのか「投稿しているが語に当たらない店」なのか
 * 区別できないので、どの投稿を落としたかを追える情報を出す。
 *
 * 【★キャプション本文は出さない(2026-08-01)★】
 * このリポジトリは public で、Actions のログは誰でも読める(既定90日保持)。
 * しかもこのログが集めるのは「キーワードに当たらなかった投稿」= 日程告知【以外】であり、
 * 優勝者名・お礼・連絡先が入りやすい側に【収集が偏っている】。
 * 一方で診断に必要なのは「取りこぼしていないか」の判断で、それは permalink を開けば
 * キャプション全文が読める以上、本文の複製が人にできることを増やしていない。
 * 便益がほぼ無くリスクだけがあるので、本文は出さず【機械的な信号だけ】にする。
 * 「本文を出さない」ことはテストで固定してある(将来また出すコードが入ったら落ちる)。
 */
function formatFilteredOutPost(store, post) {
  const sig = captionSignals(post.caption);
  // 空白のみ・ゼロ幅スペースのみも「なし」側に寄せる。文字数だけ出すと
  // 「短いだけだからキーワードを足せば拾えるかも」と誤読されるが、実際には空文字と同じで
  // キーワード方式では【構造的に永久に拾えない】。
  const captionDesc = sig.isBlank
    ? sig.chars === 0
      ? 'キャプションなし(0字)'
      : `キャプション実質なし(空白のみ${sig.chars}字)`
    : `キャプション${sig.chars}字 / 日付らしき表記=${sig.hasDateLike ? 'あり' : 'なし'}` +
      ` / 時刻らしき表記=${sig.hasTimeLike ? 'あり' : 'なし'}`;
  return (
    `[monitor-instagram-apify] キーワード不一致で対象外: 店=${store.label}(${store.venueId})` +
    ` / 投稿=${post.permalink}(${post.postedAt})` +
    ` / ${captionDesc}` +
    ' ※本文は出しません(公開ログのため)。内容は投稿URLで確認してください'
  );
}

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
  // 内容が確実に失われた投稿(画像DL失敗 / Vision抽出失敗)。::error:: で報告する。
  const lostPosts = [];
  // Visionが0件を返した投稿。誤検知の可能性があるので ::warning:: で報告する。
  const emptyResults = [];
  // 今回の取込みで既に採用した id。id は venueId を含むので店を跨いだ衝突は起きないが、
  // 「同じ投稿が2回、同じ行を返す」「同じ日・同じ大会名で start が読めなかった2行」の衝突を拾う。
  const usedIds = new Set();
  let changed = false;

  for (const store of stores) {
    const prev = state[store.venueId] || null;
    // fetchStats には Apifyが返した生の件数と、必須フィールド欠落で捨てた件数が入る
    // (埋めない実装のときは undefined のままで、下で「捨てていない」として扱う)。
    const fetchStats = {};
    const posts = await fetchLib.fetchInstagramPosts(store.handle, { stats: fetchStats });

    const picked = pickNewPostsWithStats(posts, prev && prev.lastPostedAt);
    const newPosts = picked.posts;
    const summary = {
      store,
      // 取込みの最上流から数える。Apifyが返した生の件数が分からない実装では
      // 「1件も捨てていない」とみなす(誤って残余を出さないため)。
      apifyRawCount: typeof fetchStats.rawCount === 'number' ? fetchStats.rawCount : posts.length,
      malformedCount: typeof fetchStats.malformed === 'number' ? fetchStats.malformed : 0,
      invalidPostedAtCount: picked.invalidPostedAt,
      alreadySeenCount: picked.alreadySeen,
      newPostCount: newPosts.length,
      scheduleLikeCount: 0,
      filteredOutCount: 0,
      extractedCount: 0,
      droppedCount: 0,
      dropped: [],
      normalizedCount: 0,
      normalized: [],
      // 投稿レベルの内訳。scheduleLike の1投稿は必ずこのどれか1つに入る(下の保存則を参照)。
      importedPostCount: 0,
      repostedPostCount: 0,
      unusablePostCount: 0,
      visionFailedCount: 0,
      imageFailedCount: 0,
      emptyResultCount: 0,
      // 行レベル。visionRowCount = Visionが返した行の総数。
      visionRowCount: 0,
      stats: null,
      // 手順⑤(採用行の全件照合)のための明細。
      addedRows: [], // { entry, permalink } — 実際に data.js へ増える行と、その出所の投稿
      posts: [], // 投稿ごとの1行サマリ(抽出行数・日付レンジ・その投稿からの追加件数)
    };

    if (newPosts.length === 0) {
      summaries.push(summary);
      continue;
    }

    const scheduleLike = newPosts.filter((p) => looksLikeSchedulePost(p.caption));
    summary.scheduleLikeCount = scheduleLike.length;
    // 【残差(newPosts.length - scheduleLike.length)で数えないこと】保存則が恒等式になるうえ、
    // 下のキャプション出力ループは looksLikeSchedulePost しか見ていないので、
    // scheduleLike の条件が増えると【件数だけ増えてログには出ない】不一致も生じる。
    // 同じ述語で数えれば、件数とログは常に一致する。
    summary.filteredOutCount = newPosts.filter((p) => !looksLikeSchedulePost(p.caption)).length;

    // 【キーワードで落とした投稿は画像を1度も見ないまま捨てられる】しかも lastPostedAt は
    // 下で無条件に前進するので二度と処理されない。looksLikeSchedulePost は日本語9語の
    // 単純な部分一致でしかなく、`AUGUST SCHEDULE`(英語)・`トナメ表`・`8月分アップしました`・
    // 絵文字のみ、はすべて素通りする。
    // 「日程を投稿していないから0件」なのか「投稿しているが語に当たらず全部捨てている」のかは
    // 【キャプションを見なければ区別できない】ので、ここで実際の文面をログに出す。
    // dry-runは消費ゼロで何度でも回せるため、これで推測を測定に変えられる。
    // ★キーワードを増やすのは、この実測を見てから。想像で先回りしないこと。
    for (const p of newPosts) {
      if (looksLikeSchedulePost(p.caption)) continue;
      console.log(formatFilteredOutPost(store, p));
    }

    // data.js 側の id → スロット。mergeStore は (date,start) が一致する既存しか置き換えないので、
    // 「同じidだがスロットが違う」既存があると両方残って id が重複する(人が admin.html で
    // 日時だけ直した場合など)。この店の処理を始める時点の arr から作る。
    const existingIdSlots = new Map(arr.map((t) => [t.id, `${t.date} ${t.start}`]));

    const extracted = [];
    // 採用した行が【どの投稿から来たか】。手順⑤(採用行の全件照合)で、
    // 1行ずつ元の投稿画像と突き合わせるために要る。dry-run は data.js を書かないので、
    // ここで控えておかないと出所がどこにも残らない。
    const sourceByEntryId = new Map();
    // 投稿ごとの1行サマリ(「抽出N行・追加0」の理由を検算するため)。
    // 例: 3月の月間表を読んだ投稿なら「日付レンジ 2026-03-01〜2026-03-31 / 追加0」で
    // 「全部過去日だったから追加0」と一目で説明が付く。
    const postDetails = [];
    let unusablePosts = 0; // 抽出行はあったのに1件も採用できなかった投稿の数(異常)
    let repostedPosts = 0; // 全行が「既に取込み済み」だった投稿の数(再投稿。異常ではない)
    let importedPosts = 0; // 1件以上採用できた投稿の数
    let visionFailedPosts = 0; // Vision抽出が例外で終わった投稿の数(内容は失われる)
    let imageFailedPosts = 0; // 画像ダウンロードが失敗した投稿の数(内容は失われる)
    let emptyResultPosts = 0; // Visionが0行を返した投稿の数(誤検知なら正常)
    let visionRows = 0; // Visionが返した行の総数(行レベルの突き合わせの左辺)
    for (const post of scheduleLike) {
      // 【対象投稿は必ず1件ずつここに並ぶ】どの結末になっても記録が残るよう、
      // 先に push してから結果で埋める(postDetails.length === scheduleLikeCount を保つ。
      // 途中の continue で record が抜けると、投稿レベルの保存則と件数が食い違う)。
      const detail = {
        venueId: store.venueId,
        permalink: post.permalink,
        postedAt: post.postedAt,
        rowCount: 0,
        dateMin: null,
        dateMax: null,
        addedCount: 0,
        outcome: '不明',
      };
      postDetails.push(detail);
      let imageBuffer;
      try {
        imageBuffer = await download(post.imageUrl);
      } catch (e) {
        // 【この投稿の内容は失われ、二度と再試行されない】ので必ず数える。
        imageFailedPosts += 1;
        detail.outcome = '画像DL失敗';
        lostPosts.push({ store, permalink: post.permalink, postedAt: post.postedAt, kind: 'image-failed', detail: e.message });
        console.warn(
          `[monitor-instagram-apify] ${store.label}: 画像ダウンロード失敗、この投稿はスキップ (${post.permalink}): ${e.message}`
        );
        continue;
      }
      let raw;
      try {
        raw = await visionLib.extractTournaments(imageBuffer, { postedDateHint: post.postedAt.slice(0, 10) });
      } catch (e) {
        visionFailedPosts += 1;
        detail.outcome = 'Vision抽出失敗';
        lostPosts.push({ store, permalink: post.permalink, postedAt: post.postedAt, kind: 'vision-failed', detail: e.message });
        console.warn(
          `[monitor-instagram-apify] ${store.label}: Vision抽出失敗、この投稿はスキップ (${post.permalink}): ${e.message}`
        );
        continue;
      }
      // Visionの戻り値は無検証では使えない。1行ずつ「直せるものは直してから」検査し、
      // それでも不正な行だけを捨てて残りは取り込む。
      const rows = Array.isArray(raw) ? raw : [];
      visionRows += rows.length;
      detail.rowCount = rows.length;
      // 日付レンジは【Visionが返した行そのもの】から取る。過去日の行はマージで落ちるので、
      // 採用後の行から取ると「なぜ追加0なのか」の説明にならない。
      {
        // 【書式が正しい日付だけを見る】文字列比較なので `2026-3-31` は `2026-03-15` より
        // 大きく評価され、レンジの上端が歪む。不正日付の行はどのみち破棄され、
        // その事実は破棄ログに出るので、ここで除いても情報は失われない。
        const dates = rows.map((t) => t && t.date).filter((d) => typeof d === 'string' && VALID_DATE.test(d));
        detail.dateMin = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
        detail.dateMax = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
      }
      // 0行 = 「この画像から大会を1件も読み取れなかった」。looksLikeSchedulePost は
      // わざと緩くしてあり誤検知した投稿はここに来るので、異常(赤)ではなく警告(黄)扱いにする。
      // ただし【黙って通してはいけない】— 本当は日程表なのに読めていない場合と区別が付かず、
      // 以前はログにも件数にも一切出ていなかった。
      if (rows.length === 0) {
        emptyResultPosts += 1;
        detail.outcome = 'Vision抽出0件';
        emptyResults.push({ store, permalink: post.permalink, postedAt: post.postedAt });
        console.warn(
          `[monitor-instagram-apify] ${store.label}: Visionが0件を返しました (${post.permalink})。` +
            'スケジュール告知ではない投稿を拾った(誤検知)か、日程表なのに読み取れていない可能性があります。'
        );
        continue;
      }
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
        // 【トーナメントらしさの検査】extractedRowProblem は「data.js に入れてよい形か」を見るが、
        // 「そもそも大会か」は見ない。定休日のマスや見出しはここで落とす。
        if (!reason && isClosureRow(row.name)) {
          reason = '定休日・休業のマス(大会名ではない)';
          kind = 'not-a-tournament';
        }
        if (!reason && isHeadingRow(row.name)) {
          reason = '画像の見出しを行として拾ったもの(大会の固有名ではない)';
          kind = 'not-a-tournament';
        }
        if (!reason && isNonTournamentFormat(row.name)) {
          reason = 'トーナメントではない競技形式(リングゲーム/キャッシュゲーム)';
          kind = 'not-a-tournament';
        }
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
        // 【捨てたタグを記録する】canonicalTags は toTournament の中で走るので
        // normalizeExtractedRow の notes 経路を通らない。ここで記録しないと
        // 「捨てた事実はログに出る」が嘘になる(テレメトリについて事実でない記述を残さない)。
        const lostTags = droppedTags(row.tags);
        if (lostTags.length) {
          const note = [{ field: 'tags', from: lostTags, to: null, reason: 'サイトの語彙に無いタグを捨てた' }];
          summary.normalized.push({ venueId: store.venueId, permalink: post.permalink, notes: note, name: row.name });
          console.warn(formatNormalizedRow(store, post, row, note));
        }
        usedIds.add(entry.id);
        extracted.push(entry);
        sourceByEntryId.set(entry.id, post.permalink);
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
      if (keptFromPost > 0) {
        importedPosts += 1;
        detail.outcome = '取り込めた';
      } else {
        const allAlreadyImported =
          droppedFromPost.length > 0 && droppedFromPost.every((d) => d.kind === 'duplicate-in-run');
        if (allAlreadyImported) {
          repostedPosts += 1;
          detail.outcome = '再投稿';
          console.log(
            `[monitor-instagram-apify] 再投稿と判断しました(異常ではありません): 店=${store.label}(${store.venueId})` +
              ` / 投稿=${post.permalink}(${post.postedAt}) / 抽出${rows.length}件はすべて既に取込み済みの行と同一のため、` +
              'この投稿からの追加はありません。'
          );
        } else {
          unusablePosts += 1;
          detail.outcome = '全行不採用';
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
    summary.importedPostCount = importedPosts;
    summary.visionFailedCount = visionFailedPosts;
    summary.imageFailedCount = imageFailedPosts;
    summary.emptyResultCount = emptyResultPosts;
    summary.visionRowCount = visionRows;

    // 新着の確認記録は、Vision抽出の成否に関わらずこの店で確認できた最新投稿まで進める
    // (同じ投稿を毎回「新着」として拾い直し続けないため)。
    const newest = newPosts[newPosts.length - 1];
    nextState[store.venueId] = { handle: store.handle, lastPostedAt: newest.postedAt, lastPermalink: newest.permalink };

    // 【マージを先に行う】行レベルの内訳(added/updated/unchanged/pastDated)は mergeStore が
    // 返すので、これを lastExtraction に書くにはマージが先に済んでいる必要がある。
    if (extracted.length > 0) {
      // 【mergeStore には手を入れない】「実際に増えた行」はマージ前後のidの差分で求める。
      // 共有モジュール(import-venue-image.js / Waitinglist取込みとの関係)に触らずに済み、
      // かつ「追加」の定義がマージの実装ではなく観測結果になる。
      const beforeIds = new Set(arr.map((t) => t.id));
      const { next, stats } = mergeLib.mergeStore(arr, store.venueId, extracted, today);
      mergeLib.assertOnlyTargetChanged(arr, next, store.venueId, today);
      arr = next;
      changed = true;
      summary.stats = stats;
      // 【M-1】同じ (date,start) の既存手入力を置き換えた行に印を付ける。
      // 手入力は別idなので「idが増えた=新規」に見えるが、実際には人の入力を上書きしている。
      // ⑤の照合では「これは新規ではなく人の入力を置き換えた」と分かる方が重要
      // (「人の手入力が次回実行で消える」問題の可視化にもなる)。
      const replacedBySlot = new Map();
      for (const t of stats.replacedManual) {
        const k = `${t.date} ${t.start}`;
        if (!replacedBySlot.has(k)) replacedBySlot.set(k, []);
        replacedBySlot.get(k).push(t.id);
      }
      summary.addedRows = next
        .filter((t) => t.venueId === store.venueId && !beforeIds.has(t.id))
        .map((entry) => ({
          entry,
          permalink: sourceByEntryId.get(entry.id) || null,
          replacedManualIds: replacedBySlot.get(`${entry.date} ${entry.start}`) || [],
        }))
        // 【M-2】投稿ごとにまとめる。data.js は日付順なので、そのままだと同じ投稿の行が
        // ばらばらに並ぶ。⑤は「投稿を1回開いて、その投稿の行をまとめて確認 → 次の投稿」
        // という作業なので、permalink → 日付 → 開始時刻 の順に並べ替える。
        .sort(
          (a, b) =>
            String(a.permalink).localeCompare(String(b.permalink)) ||
            String(a.entry.date).localeCompare(String(b.entry.date)) ||
            String(a.entry.start).localeCompare(String(b.entry.start))
        );
      for (const row of summary.addedRows) {
        const d = postDetails.find((x) => x.permalink === row.permalink);
        if (d) d.addedCount += 1;
      }
    }
    summary.posts = postDetails;

    // 抽出品質を【記録として残す】。GitHub Actions の注記は緑のrunでは通知が飛ばず、
    // runログも既定90日で消えるため、注記だけでは「Visionの抽出品質を人が測れる」を満たせない。
    // この状態ファイルは元から毎回コミットされるので、ここに書けばgit履歴に差分として残り、
    // ダッシュボードからも読める。Vision抽出を実際に行った店だけ更新し、行っていない店は
    // 前回値をそのまま持ち越す(毎回変わる値を足して無意味な日次差分を増やさないため)。
    // 【M-2】キーワード不一致で全部落ちた店(折尾の「新着12件→対象0件」がまさにこれ)でも記録する。
    // ここを `scheduleLike.length > 0` だけにしていると、【このカウンタが最も必要な場面】で
    // lastExtraction 自体が書かれず、状態ファイルに lastPostedAt しか残らない。
    // 「runログは90日で消えるので永続カウンタが要る」という理屈がそこだけ破れてしまう。
    if (scheduleLike.length > 0 || summary.filteredOutCount > 0) {
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
        // 【ここから下が「静かに失われていた経路」の永続カウンタ】
        // runログは既定90日で消えるので、注記やconsole.warnだけでは後から追えない。
        // この状態ファイルは毎回コミットされるため、書けばgit履歴に残る。
        // 取込みの最上流(Apifyの応答)から数える。ここが無いと、Visionに届く前に
        // 消えた投稿(形式不正・投稿日時が読めない)が git履歴のどこにも残らない。
        apifyRaw: summary.apifyRawCount,
        malformed: summary.malformedCount,
        invalidPostedAt: summary.invalidPostedAtCount,
        alreadySeen: summary.alreadySeenCount,
        newPosts: summary.newPostCount,
        filteredOut: summary.filteredOutCount, // キーワードに当たらず画像を見ないまま捨てた投稿
        importedPosts,
        visionFailed: visionFailedPosts,
        imageFailed: imageFailedPosts,
        emptyResult: emptyResultPosts,
        // 行レベルの突き合わせ用(抽出 = 追加+更新+変更なし+過去日+破棄 が成り立つか)
        visionRows,
        pastDated: summary.stats ? summary.stats.pastDated : 0,
        added: summary.stats ? summary.stats.added : 0,
        updated: summary.stats ? summary.stats.updated : 0,
        unchanged: summary.stats ? summary.stats.unchanged : 0,
      };
    } else if (prev && prev.lastExtraction) {
      nextState[store.venueId].lastExtraction = prev.lastExtraction;
    }

    summaries.push(summary);
  }

  return { arr, state: nextState, changed, summaries, anomalies, lostPosts, emptyResults };
}

/**
 * 【取込みレベルの保存則】Apifyが返した1件は、必ずどれか1つの結末に落ちる。
 *
 *   Apifyが返した件数 = 形式不正で除外 + 投稿日時が読めない + 既読 + キーワード不一致 + 対象
 *
 * 【なぜ投稿レベルより上流が要るか】投稿レベルの保存則の左辺(scheduleLikeCount)は、
 * 「Apifyの応答を正規化し」「投稿日時で選別し」「キーワードで絞った】【後】の値。
 * 上流で捨てられた投稿はどのカウンタにも現れないのに、確認済み投稿日時だけは前進する
 * (=二度と処理されない)。キーワード不一致より更に見えにくい経路なので、左辺を
 * 「Apifyが返した件数」まで遡らせて塞ぐ。
 *
 * @returns {{ ok: boolean, expected: number, actual: number, missing: number }}
 */
function checkIntakeAccounting(summary) {
  const actual =
    summary.malformedCount +
    summary.invalidPostedAtCount +
    summary.alreadySeenCount +
    summary.filteredOutCount +
    summary.scheduleLikeCount;
  return {
    ok: actual === summary.apifyRawCount,
    expected: summary.apifyRawCount,
    actual,
    missing: summary.apifyRawCount - actual,
  };
}

/**
 * 【投稿レベルの保存則】新着の1投稿は、必ずどれか1つの結末に落ちる。
 *
 * 【なぜカウンタを足すだけで終わらせないか】
 * 2026-07-31 の dry-run では、72投稿すべてがVision抽出に失敗しながら
 * ::error:: も ::warning:: も出ず、サマリは「1行も採用できなかった投稿 0件」と表示していた。
 * 原因は「結末が6通りあるのに、そのうち3つがどのカウンタにも入っていなかった」こと。
 * カウンタを3本足すだけでは【7本目の結末が生まれたときに同じことが起きる】ので、
 * 「すべての投稿がちょうど1つのバケツに入る」ことを不変条件として固定する。
 * 将来ここに `continue` を1本足すと、この検査が即座に落ちる。
 *
 * @returns {{ ok: boolean, expected: number, actual: number, missing: number }}
 */
function checkPostAccounting(summary) {
  const actual =
    summary.importedPostCount +
    summary.repostedPostCount +
    summary.unusablePostCount +
    summary.visionFailedCount +
    summary.imageFailedCount +
    summary.emptyResultCount;
  return {
    ok: actual === summary.scheduleLikeCount,
    expected: summary.scheduleLikeCount,
    actual,
    missing: summary.scheduleLikeCount - actual,
  };
}

/**
 * 【行レベルの保存則】Visionが返した1行は、必ずどれか1つの結末に落ちる。
 *
 *   Visionが返した行 = 破棄 + 過去日 + 追加 + 更新 + 変更なし
 *
 * 2026-07-31 の dry-run では「久留米: 抽出20 / 破棄0 / 追加0」のように、
 * 抽出した行がどこへ消えたのか誰も説明できない数字が並んでいた(正常に全部過去日だったのか、
 * 別の経路で消えたのかが区別できない)。残余が出るなら、それが未知の消失経路そのもの。
 *
 * @returns {{ ok: boolean, rows: number, dropped: number, pastDated: number,
 *             added: number, updated: number, unchanged: number, residual: number }}
 */
function checkRowAccounting(summary) {
  const s = summary.stats || { pastDated: 0, added: 0, updated: 0, unchanged: 0 };
  const accounted = summary.droppedCount + s.pastDated + s.added + s.updated + s.unchanged;
  return {
    ok: accounted === summary.visionRowCount,
    rows: summary.visionRowCount,
    dropped: summary.droppedCount,
    pastDated: s.pastDated,
    added: s.added,
    updated: s.updated,
    unchanged: s.unchanged,
    residual: summary.visionRowCount - accounted,
  };
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
/**
 * 手順⑤(採用行の全件照合)のための明細を出す。
 *
 * 【なぜ必要か】dry-run は data.js を書かないので、「実際に何が増えるのか」が
 * どこにも残らない。件数(追加62件)だけでは、1行ずつ元の投稿画像と突き合わせる
 * 照合作業ができない。
 *
 * 【ここに出るのは公開する内容そのもの】日付・開始時刻・大会名・参加費・スタック・permalink は
 * いずれも data.js に載せてサイトで公開する値。PR #28 で削ったのは
 * 「見ないと決めた投稿のキャプション本文」で、性質が正反対のもの。公開範囲は1文字も増えない。
 * 【ただしキャプションは決して出さないこと】— この経路にも同じ規律を適用する。
 */
function reportAcceptedRows(summaries) {
  const withRows = summaries.filter((s) => s.addedRows.length > 0);
  const total = withRows.reduce((a, s) => a + s.addedRows.length, 0);
  const noStart = withRows.reduce((a, s) => a + s.addedRows.filter((r) => !r.entry.start).length, 0);
  console.log('');
  console.log(`[monitor-instagram-apify] === 追加される行の明細(計${total}行) ===`);
  if (noStart > 0) {
    // 【声を大きくする】開始時刻はプレイヤーが最も必要とする値。読めた行が少ないなら
    // 「店が時刻を書いていない」のではなく「Visionが時刻の列を読めていない」可能性が高い。
    // 0件のときは出さない(ノイズにしない)。
    const pct = Math.round((noStart / total) * 100);
    console.log(
      `::warning title=Instagram監視 - 開始時刻が読めない行::${total}行中${noStart}行(${pct}%)で開始時刻が読み取れていません。` +
        'サイトには「—」と表示されます(00:00 とは表示しません)。' +
        '割合が高い場合は、店が時刻を書いていないのではなく【Visionが時刻を読めていない】可能性が高いので、' +
        '投稿画像を確認してください。'
    );
  }
  if (total === 0) {
    console.log('  (data.js に増える行はありません)');
  }
  for (const s of withRows) {
    for (const { entry, permalink, replacedManualIds } of s.addedRows) {
      // 【data.js に書かれるとおりの値を出す】読み取れなかった項目は `不明`。
      // 0 は「無料」という読み取れた値なので `不明` と区別する。
      const num = (v) => (v == null ? '不明' : String(v));
      const reentry = entry.reentry === 'late' ? 'レイトのみ' : entry.reentry ? 'あり' : 'なし';
      const tags = entry.tags && entry.tags.length ? entry.tags.join('・') : 'なし';
      const replaced = replacedManualIds.length
        ? ` / ★既存の手入力(id=${replacedManualIds.join(', ')})を置き換え`
        : '';
      console.log(
        `[monitor-instagram-apify] 追加行: ${entry.venueId} / ${entry.date} / ${entry.start || '開始時刻不明'} / ${entry.name}` +
          ` / 参加費${num(entry.buyin)} / アドオン${num(entry.addon)} / スタック${num(entry.stack)}` +
          ` / GTD${num(entry.guarantee)} / 再入場${reentry} / 賞品${entry.prize == null ? '不明' : entry.prize}` +
          ` / タグ${tags} / ${permalink || '出所不明'}${replaced}`
      );
    }
  }

  // 投稿ごとの1行サマリ。「抽出28行なのに追加0」が、過去日ばかりの月間表を読んだ結果なのかを
  // 日付レンジで検算できるようにする(レンジが未来なのに追加0なら、それは調べるべき異常)。
  const posts = summaries.flatMap((s) => s.posts);
  console.log('');
  console.log(`[monitor-instagram-apify] === 投稿別の内訳(計${posts.length}投稿) ===`);
  for (const p of posts) {
    const range = p.dateMin ? `${p.dateMin}〜${p.dateMax}` : '日付なし';
    console.log(
      `[monitor-instagram-apify] 投稿別: ${p.venueId} / ${p.permalink} / 抽出${p.rowCount}行` +
        ` / 日付レンジ ${range} / 追加${p.addedCount} / ${p.outcome}`
    );
  }
}

/**
 * 「Vision抽出0件」に必ず添える注意書き。
 *
 * 【0件を「異常なし」と読ませないため】0件は (a)日程を含まない投稿を拾った(正常) と
 * (b)日程表なのに読めなかった(内容が失われた) の【どちらでも同じ数字】になる。
 * 機械には分類できないので分類させず、人のゲートに置く。ただし注意書きを外して
 * 数字だけにすると「0件=問題なし」と読まれる — この案件で繰り返し出た失敗の形
 * (72/72消失で「1行も採用できなかった投稿 0件」と表示していたのと同じ)なので、
 * 件数が0でない限り必ずこの但し書きを付ける。
 */
function emptyCaveat(count) {
  return count > 0 ? '(要確認: 日程を含まない投稿か、読めなかったか判別できません)' : '';
}

/**
 * 全店の合計を1ブロックで出す。
 *
 * 【dry-run でもカウンタを観測できるようにするため必要】dry-run は状態ファイルを書かないので、
 * lastExtraction に入れた永続カウンタはディスクに残らない。dry-run の判断材料は
 * このログだけなので、店ごとの内訳とは別に合計をここで出す。
 */
function reportTotals(summaries) {
  const sum = (f) => summaries.reduce((a, s) => a + f(s), 0);
  const lost = sum((s) => s.imageFailedCount + s.visionFailedCount + s.unusablePostCount);
  const intakeResidual = sum((s) => checkIntakeAccounting(s).missing);
  const postResidual = sum((s) => checkPostAccounting(s).missing);
  console.log('');
  console.log('[monitor-instagram-apify] === 全店合計 ===');
  console.log(
    `  Apify取得 ${sum((s) => s.apifyRawCount)}件 → 新着 ${sum((s) => s.newPostCount)}件 ` +
      `(形式不正 ${sum((s) => s.malformedCount)} / 投稿日時が読めない ${sum((s) => s.invalidPostedAtCount)} / ` +
      `既読 ${sum((s) => s.alreadySeenCount)})` +
      `${intakeResidual === 0 ? '' : ` ← 残余 ${intakeResidual}件`}`
  );
  console.log(
    `  新着投稿 ${sum((s) => s.newPostCount)}件 → 対象 ${sum((s) => s.scheduleLikeCount)}件 / ` +
      `キーワード不一致で対象外 ${sum((s) => s.filteredOutCount)}件`
  );
  // 【M-5】行側だけでなく投稿側にも残余マーカーを出す(片方だけ出ていると、
  // 「投稿側は常に合っている」と誤読される)。
  console.log(
    `  投稿の行き先: 取り込めた ${sum((s) => s.importedPostCount)}件 / 再投稿 ${sum((s) => s.repostedPostCount)}件 / ` +
      `【失われた ${lost}件】(画像DL失敗 ${sum((s) => s.imageFailedCount)} / ` +
      `Vision抽出失敗 ${sum((s) => s.visionFailedCount)} / 全行不採用 ${sum((s) => s.unusablePostCount)}) / ` +
      `Vision抽出0件 ${sum((s) => s.emptyResultCount)}件${emptyCaveat(sum((s) => s.emptyResultCount))}` +
      `${postResidual === 0 ? ' / 残余なし' : ` ← 残余 ${postResidual}件`}`
  );
  const rows = summaries.map(checkRowAccounting);
  const rsum = (f) => rows.reduce((a, r) => a + f(r), 0);
  console.log(
    `  行の行き先: Vision抽出 ${rsum((r) => r.rows)}行 = 追加 ${rsum((r) => r.added)} + ` +
      `更新 ${rsum((r) => r.updated)} + 変更なし ${rsum((r) => r.unchanged)} + ` +
      `過去日 ${rsum((r) => r.pastDated)} + 破棄 ${rsum((r) => r.dropped)}` +
      `${rows.every((r) => r.ok) ? '(残余なし)' : ` ← 残余 ${rsum((r) => r.residual)}行`}`
  );
}

/**
 * 内容が確実に失われた投稿(画像DL失敗 / Vision抽出失敗)を ::error:: で報告する。
 *
 * 【この経路が今回いちばん危険だった】どちらも console.warn しか出しておらず、
 * 確認済み投稿日時は前進するので二度と再試行されない。2026-07-31 の dry-run では
 * 72投稿すべてがVision抽出に失敗しながら注記は1件も出ず、サマリは「1行も採用できなかった
 * 投稿 0件」と表示していた(集計から漏れているのではなく、積極的に「異常なし」と誤報していた)。
 */
function reportLostPosts(lostPosts) {
  if (!lostPosts || lostPosts.length === 0) return;
  const byKind = (k) => lostPosts.filter((p) => p.kind === k).length;
  console.log('');
  console.log(
    `::error title=Instagram監視 - 内容が失われた投稿::` +
      `${lostPosts.length}件の投稿を処理できませんでした` +
      `(画像ダウンロード失敗 ${byKind('image-failed')}件 / Vision抽出失敗 ${byKind('vision-failed')}件)。` +
      'これらの投稿の内容はサイトに一切入らず、確認済み投稿日時が進むため【再試行されません】。' +
      'ジョブは継続しています(取り込めた他の投稿は反映済み)。人の確認が必要です。'
  );
  for (const p of lostPosts) {
    const label = p.kind === 'image-failed' ? '画像ダウンロード失敗' : 'Vision抽出失敗';
    console.log(
      `[monitor-instagram-apify] 内容が失われた投稿(${label}): 店=${p.store.label}(${p.store.venueId})` +
        ` / 投稿=${p.permalink}(${p.postedAt}) / 理由=${p.detail}`
    );
  }
  console.log(
    '[monitor-instagram-apify] 内容が必要なら ' +
      '`node tools/import-venue-image.js --venue <id> --instagram-url <投稿URL>` で手動取込みしてください。'
  );
}

/**
 * Visionが0件を返した投稿を ::warning:: で報告する。
 *
 * 【赤(::error::)にしない理由】looksLikeSchedulePost はわざと緩く作ってあり
 * (「取りこぼしより誤検知の方が実害が小さい」)、誤検知した投稿は正常に0件で返る。
 * これを赤にすると、既存の duplicate-in-run を異常から外したのと同じ理由 —
 * 「唯一の警告チャネルが空振りで埋まり、本物の異常が読めなくなる」— に抵触する。
 * 一方で【黙って通してもいけない】(本当は日程表なのに読めていない場合と区別が付かない)ので、
 * 黄色で残して人が件数の推移を見られるようにする。
 */
function reportEmptyResults(emptyResults) {
  if (!emptyResults || emptyResults.length === 0) return;
  console.log('');
  console.log(
    `::warning title=Instagram監視 - Visionが0件を返した投稿::` +
      `${emptyResults.length}件の投稿から大会を1件も読み取れませんでした。` +
      '【この2つは機械では判別できません】(a) 日程を含まない投稿を拾った(=何も失われていない) / ' +
      '(b) 日程表なのに読み取れなかった(=その投稿の内容が失われ、再試行もされない)。' +
      '投稿URLを開いて人が確かめてください。'
  );
  for (const p of emptyResults) {
    console.log(
      `[monitor-instagram-apify] Vision 0件: 店=${p.store.label}(${p.store.venueId})` +
        ` / 投稿=${p.permalink}(${p.postedAt})`
    );
  }
}

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

  const { arr, state: nextState, changed, summaries, anomalies, lostPosts, emptyResults } = result;

  for (const s of summaries) {
    console.log('');
    console.log(`[${s.store.label} / ${s.store.venueId} / @${s.store.handle}]`);
    // 【投稿の行き先を先に出す】以前は「1行も採用できなかった投稿 N件」しか出しておらず、
    // 全投稿がVision抽出に失敗しても「0件」=異常なしに読めてしまった。
    const lost = s.imageFailedCount + s.visionFailedCount + s.unusablePostCount;
    console.log(
      `  Apify取得 ${s.apifyRawCount}件 → 新着 ${s.newPostCount}件 ` +
        `(形式不正 ${s.malformedCount} / 投稿日時が読めない ${s.invalidPostedAtCount} / 既読 ${s.alreadySeenCount})`
    );
    const intake = checkIntakeAccounting(s);
    if (!intake.ok) {
      console.log(
        `::error title=Instagram監視 - 取得件数の集計が合わない::${s.store.label}(${s.store.venueId}): ` +
          `Apifyが返した${intake.expected}件に対し内訳の合計が${intake.actual}件で、${intake.missing}件がどこにも数えられていません。` +
          'Vision に届く前の段階で投稿が消えています(バグ)。'
      );
    }
    console.log(
      `  新着投稿 ${s.newPostCount}件 → 対象 ${s.scheduleLikeCount}件 / ` +
        `キーワード不一致で対象外 ${s.filteredOutCount}件`
    );
    console.log(
      `  投稿の行き先: 取り込めた ${s.importedPostCount}件 / 再投稿 ${s.repostedPostCount}件 / ` +
        `【失われた ${lost}件】(画像DL失敗 ${s.imageFailedCount} / Vision抽出失敗 ${s.visionFailedCount} / ` +
        `全行不採用 ${s.unusablePostCount}) / Vision抽出0件 ${s.emptyResultCount}件${emptyCaveat(s.emptyResultCount)}`
    );
    // 【M-4】投稿別の明細が対象投稿数と一致すること。他の3つの保存則と同じ扱いにする
    // (テストだけで固定していると、実運用で崩れたときに誰も気づけない)。
    if (s.posts.length !== s.scheduleLikeCount) {
      console.log(
        `::error title=Instagram監視 - 投稿別の明細が合わない::${s.store.label}(${s.store.venueId}): ` +
          `対象${s.scheduleLikeCount}投稿に対し明細が${s.posts.length}行しかありません。` +
          '途中で記録されずに抜けた投稿があります(バグ)。'
      );
    }
    const post = checkPostAccounting(s);
    if (!post.ok) {
      // ここが合わない = どの結末にも数えられていない投稿がある(未知の消失経路)。
      console.log(
        `::error title=Instagram監視 - 投稿の集計が合わない::${s.store.label}(${s.store.venueId}): ` +
          `対象${post.expected}件に対し内訳の合計が${post.actual}件で、${post.missing}件がどこにも数えられていません。` +
          'tools/monitor-instagram-apify.js に、どの結末にも記録されない経路が増えています(バグ)。'
      );
    }
    const row = checkRowAccounting(s);
    console.log(
      `  行の行き先: Vision抽出 ${row.rows}行 = 追加 ${row.added} + 更新 ${row.updated} + ` +
        `変更なし ${row.unchanged} + 過去日 ${row.pastDated} + 破棄 ${row.dropped}` +
        `${row.ok ? '' : ` ← 残余 ${row.residual}行`}`
    );
    if (!row.ok) {
      console.log(
        `::error title=Instagram監視 - 行の集計が合わない::${s.store.label}(${s.store.venueId}): ` +
          `Visionが返した${row.rows}行のうち${row.residual}行の行き先が説明できません。` +
          '未知の消失経路がある可能性があります。'
      );
    }
    console.log(`  正規化した抽出行 ${s.normalizedCount}件`);
    if (s.stats) {
      console.log(
        `  既存側の変化: 削除(投稿から消滅) ${s.stats.removed}件 / ` +
          `手入力の置き換え ${s.stats.replacedManual.length}件 / ` +
          `投稿未掲載の手入力 ${s.stats.keptManual.length}件`
      );
    }
  }

  reportAcceptedRows(summaries);
  reportTotals(summaries);
  reportLostPosts(lostPosts);
  reportEmptyResults(emptyResults);
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
  formatFilteredOutPost,
  canonicalTag,
  canonicalTags,
  droppedTags,
  nameContainsMoneyToken,
  hasTournamentEvidence,
  isClosureRow,
  isHeadingRow,
  normalizeName,
  tournamentEvidence,
  isNonTournamentFormat,
  captionSignals,
  emptyCaveat,
  pickNewPostsWithStats,
  checkIntakeAccounting,
  reportAnomalies,
  reportLostPosts,
  reportEmptyResults,
  reportTotals,
  reportAcceptedRows,
  checkPostAccounting,
  checkRowAccounting,
  runMonitor,
  loadState,
  saveState,
  todayJst,
};
