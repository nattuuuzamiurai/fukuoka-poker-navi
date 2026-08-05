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
 *   node tools/monitor-instagram-apify.js --probe       … 【探索専用】打ち切らずに全投稿を判定し、数えるだけ
 *                                                         (採用もマージもしない。README リスク台帳 #13 の測定用)
 *
 *   ★知らない引数を渡したときは【何もせずに exit 1】する。`--dry-run` の打ち間違い
 *     (`--dryrun` `--dry_run` `--prob`)がそのまま【本番実行】になる経路を塞ぐため。
 *     この経路の本番実行は不可逆で、拾えなかった投稿は自動経路から永久に失われる。
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
// 「機械が最後に書いた値」の控えと、そこから導く所有の判定。
const machineState = require('./machine-write-state');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_JS = path.join(REPO_ROOT, 'data.js');
const STATE_PATH = path.join(REPO_ROOT, 'apify-monitor-state.json');
// 機械が最後に書いた値の控え。これといまの data.js を突き合わせて「人が直したか」を判定する。
// ★書き手ごとにファイルを分けてある(Waitinglist取込みは 06:23、こちらは 07:10 に走るので、
//   同じJSONを両方が触ると `git pull --rebase` が衝突してジョブが落ちる)。
// ★apify-monitor-state.json に相乗りさせないのは、あちらが「投稿をどこまで見たか」の状態で
//   意味が違うため。1ファイルに2つの関心を入れると、片方の都合でもう片方が壊れる。
const WRITE_STATE_PATH = path.join(REPO_ROOT, 'instagram-write-state.json');

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

// 【キーワードによる事前の絞り込みは廃止した(2026-08-04)】理由は calendarShape のコメント参照。
// 取り込むかどうかは【画像を読んだ結果の構造】だけで決める。キャプションは一切参照しない。

// ============================================================
// 実行モード — 引数は【知っているものだけ】受け付ける
// ============================================================
// 【★知らない引数を黙って無視しないこと★】無視すると `--dryrun` `--dry_run` `--prob` のような
// 打ち間違いが【本番実行】になる。この経路の本番実行は不可逆(lastPostedAt が前進し、
// その回で拾えなかった投稿は自動経路から永久に失われる)なので、
// 「dry-run / 探索のつもりが本番だった」を構造的に塞ぐ。
// 判定は main() の【いちばん最初】で行い、1バイトも書かずに exit 1 する。
const ARGV = process.argv.slice(2);
const KNOWN_FLAGS = ['--dry-run', '--probe'];
const UNKNOWN_ARGS = ARGV.filter((a) => !KNOWN_FLAGS.includes(a));

// 【探索専用モード(--probe)】走査を打ち切らずに【全投稿】を判定し、数えるだけのモード。
// 採用もマージもせず、data.js も状態ファイルも書かない(= lastPostedAt を前進させないので
// バックログを1件も消費しない)。目的は README リスク台帳 #13 の測定 —
// 「採用したカレンダーより新しい位置に、カレンダー判定を満たす投稿が何件あるか」。
//
// 【★--dry-run に相乗りさせず、別のフラグにしてある理由★】
//   --dry-run は「本番と【同じ判断】をするが書かない」予行。--probe は
//   【本番とは違う判断(打ち切らない)】をする測定。同じフラグにすると
//   「予行が通ったから本番も同じはず」という dry-run の意味そのものが壊れる。
//   逆向きの事故(探索のつもりで本番)は、上の「知らない引数は受け付けない」で塞いである。
const PROBE = ARGV.includes('--probe');
// --probe は必ず dry-run を含む(書き込みの分岐に入らせない)。
// これに加えて main() では書き込み関数そのものを取り上げてある(forbidWrite)。
const DRY_RUN = ARGV.includes('--dry-run') || PROBE;
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

/**
 * 確認済み投稿日時の状態ファイルを読む。
 *
 * 【★壊れていても落とさない(2026-08-05・リスク台帳 #19 の解消)★】
 *   以前はここで throw し、呼び出し側が fail() → exit(1) していた。書き込みは起きないので
 *   翌朝も同じ壊れたファイルを読んで同じ理由で落ちる = 人が直すまで永久に止まる。
 *
 *   【判断の根拠は「もう一方の状態ファイルに揃える」ではない。この状態が持つ性質そのもの】
 *     ・記録が【無い/空】= その店の取得窓の投稿がすべて「新着」になる。つまり空として
 *       続行して起きるのは【もう一度読み直す】ことだけで、【取りこぼし】は構造的に起きない。
 *       取りこぼすのは lastPostedAt が【進みすぎた】ときで、空はその真逆側である
 *     ・続行すればその実行の最後に正しい内容で書き直され、コミットされる = 【自分で直る】
 *   落とす側の利益は「壊れた記録のまま走らせない」ことだが、空でも安全側(読み直す側)に
 *   倒れる以上その利益は無い。一方で落とす側の損失(毎朝止まる)は確実に発生する。
 *
 * 【★ただし「黙って続ける」にはしない — 続行にも代償がある★】
 *   ・その店の取得窓ぶん(実測で1店あたり直近12投稿)を Vision に渡し直す = 費用と時間
 *   ・`checkedPosts` / `lastExtraction` の履歴が失われる(git履歴には残る)
 *   ・【人が admin.html で消した行が復活しうる】同じカレンダーを読み直すため。
 *     「行を消す = その枠を機械に引き渡す」という現行の規則(リスク台帳 #15)の下では
 *     復活自体は規則どおりの動作だが、平常は「既読なので読み直さない」ことで結果的に
 *     起きていない。記録を失うとその偶然の保護が外れる
 *   そこで呼び出し側が ::error:: で必ず人に見せる(`reportBrokenState`)。
 *
 * 【もう一方の状態ファイル(instagram-write-state.json)とは、同じ結論でも理由が違う】
 *   あちらが落とさないのは「記録が無い = 人のもの」が既定値で、空でも【人の行が守られる側】に
 *   倒れるから(machine-write-state.js のヘッダ)。こちらは「空 = 全部を読み直す」側に倒れるから。
 *   **どちらも「空にしたときにどちらへ倒れるか」で決めており、揃えたのではない。**
 *   ★もし将来「記録が空だと取りこぼす」形の状態ファイルを足すなら、この理由は効かない。
 *     そのときは落とす/落とさないをもう一度その性質から決めること。
 *
 * 【中身がオブジェクトでない場合も broken として報告する】以前は静かに `{}` に潰していたが、
 *   「読めたが形が違う」は壊れているのと同じで、黙って続けると誰も気づけない。
 *
 * @returns {{ state: object, missing: boolean, broken: boolean, reason: string|null }}
 */
function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { state: {}, missing: true, broken: false, reason: null };
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    return { state: {}, missing: false, broken: true, reason: `ファイルを読み込めません: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { state: {}, missing: false, broken: true, reason: `JSONとして解釈できません: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: {},
      missing: false,
      broken: true,
      reason: `中身がオブジェクトではありません(${Array.isArray(parsed) ? '配列' : String(parsed === null ? 'null' : typeof parsed)})`,
    };
  }
  return { state: parsed, missing: false, broken: false, reason: null };
}

/**
 * 確認済み投稿日時の記録が読めなかったことを ::error:: で報告する。
 *
 * 【★ジョブを非ゼロ終了させてはいけない(ここが肝)★】
 *   このステップを失敗させると後続のコミット・pushが走らず、【直った状態ファイルが
 *   リポジトリに残らない】。壊れたファイルが main にある場合、翌朝も同じものを読むので
 *   「落として止める」のとまったく同じ永久ループに戻る。直すには最後まで走り切る必要がある。
 *   そのため報告は ::error:: 注記だけで行い、終了コードは変えない
 *   (`reportLostPosts` と同じ扱い。GitHub のワークフローコマンドは stdout に出すこと)。
 */
function reportBrokenState(statePath, reason, opts) {
  const dryRun = Boolean(opts && opts.dryRun);
  const name = path.basename(statePath);
  console.log('');
  console.log(
    `::error title=Instagram監視 - 確認済み投稿日時の記録が読めません::` +
      `${name} を読めませんでした(${reason})。` +
      '【ジョブは止めません】記録が空のときと同じ扱いで続行します。' +
      '空は「取りこぼす」側ではなく【もう一度読み直す】側に倒れるので、日程が失われることはありません。' +
      'ただし取得窓の投稿を Vision に渡し直すため費用と時間がかかり、' +
      '【人が admin.html で消した行が復活することがあります】(同じカレンダーを読み直すため)。' +
      (dryRun
        ? 'このモードでは何も書かないので、ファイルは壊れたままです。'
        : 'この実行の最後に正しい内容で書き直すので、次回からは元に戻ります。') +
      `壊れる前の内容は git 履歴で確認できます: \`git log -p -- ${name}\``
  );
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** `YYYY-MM-DD` どうしの日数差(a - b)。どちらかが読めなければ null。 */
function daysBetween(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86400000);
}

/**
 * 【矛盾の検出】確認済み投稿日時が【未来】になっていないか(README リスク台帳 #22)。
 *
 * 【なぜ要るか — 症状が「静かな永久停止」だから】
 *   `lastPostedAt` が未来だと `pickNewPostsWithStats` が取得した全投稿を「既読」と判定する。
 *   ログ上は「新着0件」= 店が何も投稿していない平常日と【区別が付かない】まま、
 *   その店の取込みが永久に止まる。#19(壊れて毎朝赤くなる)より**見えない**ぶん質が悪い。
 *
 * 【★これは「両方向を実データで示す」規律の対象外(2026-08-05・レビュー部の線引き)】
 *   この案件が禁じてきたのは【閾値や経験則にもとづく警報で、鳴る側を実データで示せないもの】
 *   (PR #32 の到達不能な上振れ分岐が典型)。
 *   一方これは【矛盾の検出】である — 投稿日時が現在より未来という状態は物理的に存在しない。
 *   **ありえない状態の検出は仮説の検証ではないので、鳴る側の実データを要さない**
 *   (定義上、正常なデータにその状態は存在しない)。この区別は README にも記録してある。
 *
 * 【比較の相手は「実行日(JST)の終わり + 1日」】秒単位の時計ずれで誤検知しないための余裕で、
 *   **調整するための閾値ではない**(1日先の投稿がありえない点は変わらない)。
 *   JSTの日 D は UTC の D T15:00Z に終わるので、そこから更に24時間を足した時刻を境界にする。
 *
 * 【読めない値(NaN)はここでは扱わない】`pickNewPostsWithStats` が「記録なし」として
 *   全投稿を新着に倒すので、静かな停止にはならない(=安全側に落ちている)。
 *
 * @returns {{ value: string, boundary: string }|null}
 */
function impossibleLastPostedAt(prev, today) {
  const value = prev && prev.lastPostedAt;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const boundaryMs = Date.parse(`${today}T15:00:00Z`) + 86400000;
  if (Number.isNaN(boundaryMs) || ms <= boundaryMs) return null;
  return { value, boundary: new Date(boundaryMs).toISOString() };
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
 *   2. 公開前は⑤(人による全件照合)が最後の関門
 *
 * 【★2026-08-04: この多層防御から「⚠ 要確認」の層が抜けた】
 * かつては 1 と 2 の間に「証拠ゼロの行に `lowConfidence` を付ける」層があり、
 * 漏れた定休日にも詳細未定の大会にも⚠が付いていた。社長の基準
 * (名前だけの行は平常)に合わせて⚠は【参加費が名前由来かもしれない行】専用になったので、
 * **語の判定から漏れた定休日は、いま何の印も付かずに公開される**。
 * 受け止めるのは⑤だけ。⑤を外す(cron解除)ときはこの穴を必ず勘定に入れること
 * (README リスク台帳 #14)。
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
  // 副作用として `本日休み` `お休みです` のような複合表現は漏れる。
  // 【★2026-08-04: 漏れた側の受け皿が⑤だけになった】以前は「証拠ゼロなので ⚠ 要確認 が付く」と
  // 書いていたが、⚠は【参加費が名前由来かもしれない行】専用になったため、
  // 漏れた定休日は印なしで公開される(README リスク台帳 #14)。
  // 【非対称性は変わらない】漏れ=内容は残り⑤で拾える / 過剰破棄=完全に失われ再試行なし。
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
 * ⚠ 要確認(`lowConfidence`)を付けるか。
 *
 * 【★判定を作り直した(2026-08-04・社長の指示)】
 *   「最低限はトナメ名。次点で参加費と開始時間。賞金は店舗のトーナメントではあまり気にしなくていい」
 * = **名前しか書かれていない行は【平常】**。
 *
 * 【旧判定(開始時刻/参加費/スタック/保証額がどれも無い行に⚠)が壊れていた理由】
 * 前回の試験実行(採用44行)の実測は
 *   トーナメント名 44/44(100%) / 参加費 6/44(13.6%) / 開始時刻 2/44(4.5%) / GTD 0/44 / 賞品 0/44
 * で、旧判定は **44行中42行(95%)に点灯**していた。
 * **全部に付く印は何も指していない**のと同じで、本当に危ない行を隠す。
 * この案件が繰り返し潰してきた【常時点灯する警報】そのものだった。
 *
 * 【残す唯一の条件 = 名前由来かもしれない参加費】
 * Visionは画像に金額が無くても `FREE ROLL`→0 / `1K MULTI`→1000 のように
 * **大会名から参加費を推論して返す**ことがある。誤った参加費は
 * 【プレイヤーが持っていく金額】を間違えさせるうえ、画像に数字はあるので
 * ⑤(人の全件照合)でも一致して見え**見抜けない** — ⑤の外側に落ちる唯一の経路。
 * だからここだけは印を残す。**参加費の値そのものは消さない**(消す方が情報を失う)。
 *
 * 【★旧実装の欠陥をここで構造的に解消している(README リスク台帳 #11)】
 * 旧実装は `if (e.start || e.stack || e.guarantee) return true;` が先に返るため、
 * 名前由来のガードは **`buyin` が唯一の証拠のときにしか効かなかった**。実測:
 *   `1K MULTI` / 時刻なし     → buyin=1000 / ⚠ 付く
 *   `1K MULTI` / 時刻あり     → buyin=1000 / ⚠ 付かない
 *   `1K MULTI` / スタックあり → buyin=1000 / ⚠ 付かない
 * つまり **Visionが時刻を1つ読めた瞬間、捏造された参加費から ⚠ が消える**。
 * 表面化していなかったのは「95%の行に時刻が無い」からにすぎず、
 * **店が時刻を書き始めるという良い変化が、参加費ガードを静かに無力化する**関係だった。
 * この関数は **`name` と `buyin` 以外を一切見ない**ので、その依存自体が存在しない。
 *
 * 【★平常時は0行になる = 鳴らない警報になりうる】前回の44行では該当0件だったとみられる。
 * **鳴らない警報は壊れていても気づけない**。この案件は同じ罠を既に2度踏んでいる —
 * PR #32 の【到達不能な上振れ分岐】と、【上振れで発火しないことだけを検査した結果、
 * 警告が完全に死んでも緑になる】検査。だから片側だけの検査で満足しない。
 * そのためテストは**両方向**を固定してある:
 *   ・付くべき行で付く … `1K MULTI`+buyin を【時刻あり/スタックあり/GTDあり/何も無し の4通り全部】
 *   ・付くべきでない行で付かない … 名前だけの行 / 時刻だけの行
 *   ・`return false` に潰す変異でテストが落ちること(2026-08-04に確認済み)
 *
 * 【GTD・賞品は判定に使わない】社長の指示のとおり店舗大会では重要度が低く、実測でも0/44。
 * 判定に入れても常に同じ側に倒れるだけで、印の意味を薄める。
 */
function buyinMayComeFromName(t) {
  // `buyin: 0` は「無料」という【読み取れた値】なので対象に含める
  // (`FREE ROLL`→0 は、まさに名前から推論された0でありうる)。
  const buyin = t && t.buyin;
  const hasBuyin = buyin != null && String(buyin).trim() !== '';
  if (!hasBuyin) return false;
  return nameContainsMoneyToken(t && t.name);
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
  // 【⚠ 要確認 を付ける唯一の条件】= 参加費が大会名から推測された疑いがあること。
  // 「時刻も参加費も無い行」は社長の基準では【平常】なので印を付けない(判定の根拠は
  // buyinMayComeFromName のコメント。旧判定は44行中42行に点灯していた)。
  if (buyinMayComeFromName(t)) entry.lowConfidence = true;
  return entry;
}

/**
 * 破棄した抽出行1件を、人が追跡できる1行のログにする。
 * 「どの店の・どの投稿の・どんな値だったか」が揃っていないとVisionの抽出品質を測れないので、
 * 理由 / 店 / 投稿URL / 投稿日時 / 実際の date と name をすべて出す。
 */
/** 日付レンジ・カレンダー判定に使ってよい書式(YYYY-MM-DD ゼロ埋め)。 */
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 【キャプションはどこからも参照しない(2026-08-04)】
 * 以前はキーワードで落とした投稿の較正のために、本文を出さずに機械的な信号
 * (文字数 / 日付らしき表記 / 時刻らしき表記)だけを出す `formatFilteredOutPost` があった。
 * キーワード判定の廃止でその経路ごと無くなったので、関数もろとも削除した。
 * 較正に必要な数値は `formatCalendarVerdict`(支配月 / 異なる日付 / 広がり)が出す。
 *
 * 【★キャプションを読むコードを足すときは、まずここを読むこと★】
 * このリポジトリは public で Actions のログは誰でも読める(既定90日保持)。
 * 新方式は【全投稿】が判定ログを通るので、本文を出すと日程告知以外
 * (優勝者名・お礼・連絡先)まで公開ログに複製されることになる。旧方式より収集範囲が広い。
 * 診断に必要なことは permalink を開けば分かるので、本文を出す便益はほぼ無い。
 * 「本文を出さない」ことは formatCalendarVerdict のテストとCLI全出力の漏洩走査で固定してある。
 */

/**
 * 【月間カレンダーかどうか】を、語彙ではなく【抽出結果の構造】で判定する。
 *
 * 【なぜ語彙で判定しないか(2026-08-04)】
 * 社長の指示でスコープが「最新月のカレンダー1枚だけ」に絞られた。従来のキーワード判定
 * (`looksLikeSchedulePost`)は廃止した — dry-run #5 で
 * **v40 は12投稿すべてがキーワードで捨てられ Vision に一度も渡っていなかった**(うち7件は
 * キャプション自体が無い)。キャプションが無い投稿はキーワードをどう調整しても届かないので、
 * 「1店まるごと永久に0件」が実際に起きていた。判定は画像の中身(抽出結果)で行う。
 *
 * 【判定条件】支配的な月(最も日付が多い月)について
 *   異なる日付が MIN_CALENDAR_DATES 以上 かつ 日付の広がりが MIN_CALENDAR_SPAN_DAYS 日以上
 *
 * 【閾値の根拠(dry-run #5 の実測)】分離が極めて明確だった:
 *   カレンダー   : 広がり 25 / 29 / 29 / 30 / 30 日
 *   カレンダーでない: 広がり  0 /  0 /  2 日
 * **2日と25日の間に何も無い**。広がりを条件に入れているのは、
 * 週2日営業のような【疎なカレンダー】(日付は少ないが月全体に散る)を取りこぼさないため。
 * 日付の数だけで判定すると、そういう店の正当なカレンダーを個別告知と誤判定する。
 *
 * 【★★閾値を触る前に README リスク台帳 #13 を読むこと。緩めてはいけない★★】
 * 誤差の向きが**旧方式から反転している**。旧方式(全投稿を処理する)では
 * 「取りこぼしより誤検知の方が実害が小さい」が正しかったが、
 * **最新1枚だけを採る新方式では逆**:
 *   ・厳しすぎる(偽陰性) … 走査が**続く**。見つからなければ「カレンダー0枚」という正直な signal が残る
 *   ・緩すぎる(偽陽性)   … 走査が**止まる**。本物は永久に未読になり、**部分データが公開され**、
 *                          保存則も ::error も無音のまま【成功に見える】
 * (レビュー部の再現: シリーズ告知5件=異なる日付5・広がり28日 が本物の月間カレンダーを追い越した)
 * 次に触る人の自然な発想は「取りこぼさないよう緩める」だが、**それが最も危険な方向**。
 * **下げる変更は #13 を読み直してからでなければ入れない。**
 */
const MIN_CALENDAR_DATES = 5;
const MIN_CALENDAR_SPAN_DAYS = 10;

/** 抽出結果からカレンダーらしさの指標を出す。判定に使った値は必ずログに出すこと。 */
function calendarShape(rows) {
  const dates = (Array.isArray(rows) ? rows : [])
    .map((t) => t && t.date)
    .filter((d) => typeof d === 'string' && VALID_DATE.test(d));
  if (dates.length === 0) {
    return { dominantMonth: null, distinctDates: 0, spanDays: 0, isCalendar: false };
  }
  // 支配的な月 = 異なる日付が最も多い月。月をまたぐ投稿(実在する)でも1つに決まる。
  const byMonth = new Map();
  for (const d of dates) {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, new Set());
    byMonth.get(m).add(d);
  }
  let dominantMonth = null;
  let best = null;
  for (const [m, set] of byMonth) {
    if (!best || set.size > best.size || (set.size === best.size && m > dominantMonth)) {
      dominantMonth = m;
      best = set;
    }
  }
  const sorted = [...best].sort();
  const spanDays =
    (Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) - Date.parse(`${sorted[0]}T00:00:00Z`)) / 86400000;
  return {
    dominantMonth,
    distinctDates: best.size,
    spanDays,
    isCalendar: best.size >= MIN_CALENDAR_DATES && spanDays >= MIN_CALENDAR_SPAN_DAYS,
  };
}

/** 判定結果を1行にする(本文は出さない)。閾値の調整はこのログの実測で行う。 */
function formatCalendarVerdict(store, post, shape, verdict) {
  return (
    `[monitor-instagram-apify] 投稿判定: 店=${store.label}(${store.venueId})` +
    ` / 投稿=${post.permalink}(${post.postedAt})` +
    ` / 支配月=${shape.dominantMonth || 'なし'} / 異なる日付=${shape.distinctDates} / 広がり=${shape.spanDays}日` +
    ` / ${verdict}`
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
 * 【探索専用モード(opts.probe)】走査を打ち切らず、取得できた投稿を【全部】判定する。
 * 採用もマージもせず、返す state は渡された state と【ビット単位で同じ】(= lastPostedAt を
 * 前進させないのでバックログを1件も消費しない)。測定の目的と読み方は reportProbe を参照。
 *
 * @param {{ stores: Array, before: Array, today: string, state: object, probe?: boolean }} opts
 * @param {{ fetchLib: object, visionLib: object, mergeLib: object, downloadImage: Function }} libs
 * @returns {Promise<{ arr: Array, state: object, changed: boolean, summaries: Array, anomalies: Array }>}
 */
async function runMonitor(opts, libs) {
  const { stores, before, today, state } = opts;
  // 【探索専用モード】打ち切らずに全投稿を判定し、採用も状態の前進も一切しない。
  const probe = Boolean(opts.probe);
  // 機械が最後に書いた値の控え(id → エントリ)。無ければ空 = 全行が人のものとして扱われ、
  // この経路は【新しい枠に足すことしかしない】。安全側に倒れる既定値。
  const writeRecords = opts.writeRecords || {};
  const { fetchLib, visionLib, mergeLib, downloadImage: download } = libs;

  let arr = before;
  const nextState = { ...state };
  const summaries = [];
  const anomalies = [];
  // 内容が確実に失われた投稿(画像DL失敗 / Vision抽出失敗)。::error:: で報告する。
  const lostPosts = [];
  // Visionが0件を返した投稿。誤検知の可能性があるので ::warning:: で報告する。
  const emptyResults = [];
  // 取得に失敗した店。ジョブは非ゼロ終了させるが、成功した店のデータは書き込む。
  const storeFailures = [];
  // 今回の取込みで既に採用した id。id は venueId を含むので店を跨いだ衝突は起きないが、
  // 「同じ投稿が2回、同じ行を返す」「同じ日・同じ大会名で start が読めなかった2行」の衝突を拾う。
  const usedIds = new Set();
  // 今回この経路が書いた【人の値を戻す前の】候補行(id → エントリ)。状態ファイルに控える。
  const writtenAll = {};
  let changed = false;

  for (const store of stores) {
    const prev = state[store.venueId] || null;
    // fetchStats には Apifyが返した生の件数と、必須フィールド欠落で捨てた件数が入る
    // (埋めない実装のときは undefined のままで、下で「捨てていない」として扱う)。
    const fetchStats = {};
    // 【summary は fetch より前に作る】取得に失敗した店も1行ぶんの記録を残す必要があるため。
    // 取込み系の数字(apifyRawCount など)は取得に成功してから埋める。
    const summary = makeStoreSummary(store);
    // 【矛盾の検出(#22)】確認済み投稿日時が未来 = その店の取込みが静かに止まっている状態。
    // 取得の成否に関わらず判定できるので、fetch より前に見る。
    summary.impossibleLastPostedAt = impossibleLastPostedAt(prev, today);
    // 【静かな停止を測る(警報ではない)】最後に取込みが成立した日。取得に失敗した店・
    // 新着0件の店もこの後の処理へ進まないので、ここで前回値から初期化しておく。
    summary.lastImportedAt = (prev && prev.lastImportedAt) || null;
    let posts;
    try {
      posts = await fetchLib.fetchInstagramPosts(store.handle, { stats: fetchStats });
    } catch (e) {
      // 【店舗単位で隔離する】1店の取得失敗で全店を止めない。
      // 2026-08-01 の dry-run #4 では1店目のタイムアウトで残り5店が取得すらされなかった。
      //
      // 【★この店の lastPostedAt は絶対に前進させない★】nextState は state の浅いコピーなので、
      // ここで触らずに continue すれば前回値がそのまま残る。前進させてしまうと
      // 「取得に失敗しただけの投稿」が処理済みとして【永久に失われる】。
      // Waitinglist取込み(import-waitinglist.js)にも同じ隔離が入っている(PR #22)が、
      // あちらは状態ファイルを持たないので、この lastPostedAt の扱いだけが Instagram 固有。
      // 実装は共通化していないので、片方を直しても自動では追従しない点に注意。
      summary.fetchFailed = true;
      summary.fetchError = e && e.message ? e.message : String(e);
      summary.fetchElapsedMs = fetchStats.elapsedMs != null ? fetchStats.elapsedMs : null;
      storeFailures.push({ store, error: summary.fetchError, elapsedMs: summary.fetchElapsedMs });
      console.warn(
        `[monitor-instagram-apify] ${store.label}(${store.venueId}): 取得失敗、この店はスキップ` +
          `(確認済み投稿日時は前進させないので次回やり直せます): ${summary.fetchError}`
      );
      summaries.push(summary);
      continue;
    }
    summary.fetchElapsedMs = fetchStats.elapsedMs != null ? fetchStats.elapsedMs : null;

    // 【探索モードでは「既読」で絞らない】測定したいのは「取得窓の中で、採用したカレンダーの
    // 前後にどんな形の投稿が並んでいるか」なので、既に確認済みの投稿も判定の対象に含める。
    // ★ここで lastPostedAt を渡さないので `alreadySeen` は 0 になるが、これは残差ではなく
    //   【既読を理由に落とした投稿が1件も無い】という事実である(選別そのものを行っていない)。
    //   「本番なら既読として飛ばしていた件数」は別に probeReExaminedCount として数える。
    const picked = pickNewPostsWithStats(posts, probe ? null : prev && prev.lastPostedAt);
    const newPosts = picked.posts;
    if (probe) {
      const lastMs = prev && prev.lastPostedAt ? Date.parse(prev.lastPostedAt) : NaN;
      summary.probeReExaminedCount = Number.isNaN(lastMs)
        ? 0
        : newPosts.filter((p) => Date.parse(p.postedAt) <= lastMs).length;
    }
    // 取込みの最上流から数える。Apifyが返した生の件数が分からない実装では
    // 「1件も捨てていない」とみなす(誤って残余を出さないため)。
    summary.apifyRawCount = typeof fetchStats.rawCount === 'number' ? fetchStats.rawCount : posts.length;
    summary.malformedCount = typeof fetchStats.malformed === 'number' ? fetchStats.malformed : 0;
    summary.invalidPostedAtCount = picked.invalidPostedAt;
    summary.alreadySeenCount = picked.alreadySeen;
    summary.newPostCount = newPosts.length;

    if (newPosts.length === 0) {
      summaries.push(summary);
      continue;
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
    let notATournamentPosts = 0; // 全行が「大会ではない」だった投稿の数(異常ではない)
    let humanEditedPosts = 0; // 全行が「人が訂正した既存と衝突」だった投稿の数(異常ではない)
    let importedPosts = 0; // 1件以上採用できた投稿の数
    let visionFailedPosts = 0; // Vision抽出が例外で終わった投稿の数(内容は失われる)
    let imageFailedPosts = 0; // 画像ダウンロードが失敗した投稿の数(内容は失われる)
    let emptyResultPosts = 0; // Visionが0行を返した投稿の数(誤検知なら正常)
    let visionRows = 0; // Visionが返した行の総数(行レベルの突き合わせの左辺)
    let notCalendarPosts = 0; // カレンダーではないので対象外にした投稿の数
    let pastCalendarPosts = 0; // 過去月のカレンダーだったので採用しなかった投稿の数
    // 【採用しなかった投稿の行数】走査フェーズでは「採用しない投稿」の行もVisionから返ってくる。
    // それを数えないと、行レベルの保存則の左辺(visionRows)だけが増えて右辺に行き先が無く、
    // 【正常な実行で毎回「行の集計が合わない」と誤報する】(新方式では大半の投稿が不採用のため)。
    // 【★残差で出さないこと★】`visionRows - 採用した行` にすると保存則が恒等式になり、
    // 採用した投稿の行が消えても、この項に吸い込まれて表に出なくなる。
    // 不採用と判断したその場で rows.length を足す(= 正の述語で数える)。
    let notAdoptedRows = 0;

    // 【キーワード判定は廃止した(2026-08-04)】理由は calendarShape のコメント参照。
    // 取得できた新着はすべて判定の対象になる(= 取込みレベルの保存則では filteredOut は常に0)。
    summary.scheduleLikeCount = newPosts.length;
    summary.filteredOutCount = 0;

    // ============================================================
    // 走査フェーズ: 新しい順に見て「当月以降のカレンダー」を1枚だけ採用する
    // ============================================================
    // 【打ち切りの条件は「カレンダーを見つけたら」ではない】
    // 店が当月のカレンダーを出した後に前月分の訂正版を出すことが現実にありうる
    // (dry-run #5 に月をまたぐ投稿が実在: v18 の 05-31〜07-03、v34 の 03-02〜04-04)。
    // 「最初のカレンダーで打ち切る」と、訂正版に隠れて当月分を取り逃がす。
    // そこで【支配月が当月以降のカレンダーを見つけたときだけ打ち切る】。
    // 過去月のカレンダーは記録だけして走査を続ける。
    const currentMonth = today.slice(0, 7);
    const newestFirst = [...newPosts].reverse(); // pickNewPosts は古い順に返す
    const checkedPosts = { ...((prev && prev.checkedPosts) || {}) };
    let accepted = null; // { post, rows }
    let latestPastCalendar = null; // 当月以降が見つからなかったときの説明用
    let examinedCount = 0; // 【Vision呼び出し地点で独立に加算する】残差で出さない
    let cacheHitCount = 0;
    let stoppedAtIndex = newestFirst.length; // 打ち切り位置(未確認の投稿を正の述語で数えるため)
    // 【探索モード専用】走査の並び(新しい順)の【位置】つきで、投稿1件ごとの判定を残す。
    // #13 が問うているのは「どんな形の投稿が、本物のどちら側に何件並んでいるか」なので、
    // 件数だけでなく位置が要る。判定は文面ではなく kind で持つ(文言を直すと壊れる形にしない)。
    const probeVerdicts = [];
    let probeCalendarPosts = 0; // 当月以降のカレンダーだが、探索なので採用しなかった投稿

    for (let i = 0; i < newestFirst.length; i++) {
      const post = newestFirst[i];
      const detail = {
        venueId: store.venueId,
        permalink: post.permalink,
        postedAt: post.postedAt,
        rowCount: 0,
        dateMin: null,
        dateMax: null,
        addedCount: 0,
        protectedCount: 0,
        outcome: '不明',
      };
      postDetails.push(detail);
      // 探索モードでは、この投稿がどう判定されたかを位置つきで必ず1件記録する。
      const recordProbe = (kind, shape) => {
        if (!probe) return;
        probeVerdicts[i] = {
          index: i,
          permalink: post.permalink,
          postedAt: post.postedAt,
          kind,
          dominantMonth: shape ? shape.dominantMonth : null,
          distinctDates: shape ? shape.distinctDates : 0,
          spanDays: shape ? shape.spanDays : 0,
        };
      };

      // 【一度判定した投稿は二度と Vision に渡さない】
      // キーワード判定を廃止したぶん、初回は window 全体を舐めることになる。
      // 判定結果を状態ファイルに残せば、以降の費用は【本当に新しい投稿の数】に比例する。
      //
      // 【★探索モードはキャッシュを使わない★】測定に必要なのは判定の結果(calendar か否か)
      // だけでなく【支配月・異なる日付・広がり】の3つの数値で、キャッシュはそれを持っていない。
      // 使うと「前回 not-calendar だった投稿」の形が測れず、標本に穴が空く。
      // そのぶん Vision の呼び出しは取得窓の全件になる(費用は探索を回す人が引き受ける)。
      const cached = probe ? null : checkedPosts[post.permalink];
      if (cached && cached !== 'calendar') {
        cacheHitCount += 1;
        detail.outcome = `判定済み(${cached})`;
        continue;
      }

      let imageBuffer;
      try {
        imageBuffer = await download(post.imageUrl);
      } catch (e) {
        // 【判定できていないのでキャッシュしない】次回やり直せるようにする。
        imageFailedPosts += 1;
        recordProbe('image-failed', null);
        detail.outcome = '画像DL失敗';
        lostPosts.push({ store, permalink: post.permalink, postedAt: post.postedAt, kind: 'image-failed', detail: e.message });
        console.warn(
          `[monitor-instagram-apify] ${store.label}: 画像ダウンロード失敗、この投稿はスキップ (${post.permalink}): ${e.message}`
        );
        continue;
      }

      let raw;
      try {
        examinedCount += 1;
        raw = await visionLib.extractTournaments(imageBuffer, { postedDateHint: post.postedAt.slice(0, 10) });
      } catch (e) {
        // 【判定できていないのでキャッシュしない】
        visionFailedPosts += 1;
        recordProbe('vision-failed', null);
        detail.outcome = 'Vision抽出失敗';
        lostPosts.push({ store, permalink: post.permalink, postedAt: post.postedAt, kind: 'vision-failed', detail: e.message });
        console.warn(
          `[monitor-instagram-apify] ${store.label}: Vision抽出失敗、この投稿はスキップ (${post.permalink}): ${e.message}`
        );
        continue;
      }

      const rows = Array.isArray(raw) ? raw : [];
      visionRows += rows.length;
      detail.rowCount = rows.length;
      const shape = calendarShape(rows);
      {
        const dates = rows.map((t) => t && t.date).filter((d) => typeof d === 'string' && VALID_DATE.test(d));
        detail.dateMin = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
        detail.dateMax = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
      }

      if (rows.length === 0) {
        emptyResultPosts += 1;
        notAdoptedRows += rows.length; // 0件だが、行の保存則の形を全経路でそろえておく
        recordProbe('empty', shape);
        detail.outcome = 'Vision抽出0件';
        checkedPosts[post.permalink] = 'empty';
        emptyResults.push({ store, permalink: post.permalink, postedAt: post.postedAt });
        console.log(formatCalendarVerdict(store, post, shape, 'Visionが0件(カレンダーではない)'));
        continue;
      }

      if (!shape.isCalendar) {
        notCalendarPosts += 1;
        notAdoptedRows += rows.length;
        recordProbe('not-calendar', shape);
        detail.outcome = 'カレンダーでない';
        checkedPosts[post.permalink] = 'not-calendar';
        console.log(formatCalendarVerdict(store, post, shape, 'カレンダーではない(対象外)'));
        continue;
      }

      if (shape.dominantMonth < currentMonth) {
        // 過去月のカレンダー。採用はしないが【走査は続ける】(上のコメント参照)。
        pastCalendarPosts += 1;
        notAdoptedRows += rows.length;
        recordProbe('calendar-past', shape);
        detail.outcome = `過去月のカレンダー(${shape.dominantMonth})`;
        checkedPosts[post.permalink] = 'past-calendar';
        if (!latestPastCalendar) latestPastCalendar = { month: shape.dominantMonth, permalink: post.permalink };
        console.log(formatCalendarVerdict(store, post, shape, `過去月のカレンダー(${shape.dominantMonth})なので採用しない`));
        continue;
      }

      // 【探索モードはここで打ち切らない】当月以降のカレンダーだと記録して、走査を続ける。
      // 採用もマージもしないので data.js は1バイトも動かない(採用の判断は本番と同じ位置で
      // 記録だけしてある = 「本番ならここで打ち切っていた」が後から分かる)。
      if (probe) {
        probeCalendarPosts += 1;
        notAdoptedRows += rows.length;
        recordProbe('calendar-current', shape);
        const first = !probeVerdicts.some((v, j) => v && j < i && v.kind === 'calendar-current');
        detail.outcome = `当月以降のカレンダー(${shape.dominantMonth}・探索なので採用しない)`;
        console.log(
          formatCalendarVerdict(
            store,
            post,
            shape,
            `当月以降のカレンダー(${shape.dominantMonth})${first ? ' ★本番ならここで採用して打ち切っていた' : ''} — 探索モードなので採用しない`
          )
        );
        continue;
      }

      // 当月以降のカレンダー。これを採用して打ち切る。
      accepted = { post, rows, shape, detail };
      detail.outcome = `採用(${shape.dominantMonth}のカレンダー)`;
      checkedPosts[post.permalink] = 'calendar';
      console.log(formatCalendarVerdict(store, post, shape, `★採用(${shape.dominantMonth}のカレンダー)`));
      stoppedAtIndex = i + 1;
      break;
    }

    // 【未確認の投稿は正の述語で数える】`総数 - 確認済み` にすると保存則が恒等式になる。
    const unexamined = newestFirst.slice(stoppedAtIndex);
    for (const p of unexamined) {
      postDetails.push({
        venueId: store.venueId,
        permalink: p.permalink,
        postedAt: p.postedAt,
        rowCount: 0,
        dateMin: null,
        dateMax: null,
        addedCount: 0,
        protectedCount: 0,
        outcome: '未確認(採用後に打ち切り)',
      });
    }
    summary.unexaminedPostCount = unexamined.length;
    summary.examinedPostCount = examinedCount;
    summary.cacheHitCount = cacheHitCount;
    summary.probeCalendarPostCount = probeCalendarPosts;
    // 【探索モードの判定一覧】位置(新しい順)ごとに1件。穴が開いていたら測定が壊れているので、
    // `filter(Boolean)` で詰めずにそのまま渡す(checkProbeAccounting が残余として表に出す)。
    summary.probeVerdicts = probe ? probeVerdicts : null;
    // 【探索モードでは「採用した」と言わない】見つけたのは事実なので記録するが、
    // 実際に採用したのは本番モードだけ。呼び出し側はこの区別を表示に反映する。
    summary.currentMonthCalendar = accepted
      ? { month: accepted.shape.dominantMonth, permalink: accepted.post.permalink }
      : probe
        ? (() => {
            const first = probeVerdicts.find((v) => v && v.kind === 'calendar-current');
            return first ? { month: first.dominantMonth, permalink: first.permalink } : null;
          })()
        : null;
    summary.latestPastCalendar = latestPastCalendar;
    summary.checkedPosts = checkedPosts;

    for (const { post, rows } of accepted ? [accepted] : []) {
      // 【ここに来るのは採用したカレンダー1枚だけ】画像の取得・Vision抽出・カレンダー判定は
      // 走査フェーズで済んでいる。ここは「その1枚の行を1行ずつ検査して取り込む」だけ。
      const detail = accepted.detail;
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
        // 【何も失われていない「採用0件」は異常にしない】
        // 唯一の赤いチャネル(::error::)が空振りで埋まると、本物の異常が読めなくなる。
        // 判定は【理由の文面ではなく kind】で行う(文言を直した瞬間に静かに壊れるため)。
        // また `every` を使うこと — 混在(例: リングゲーム + 本物の不正行)は
        // 失われた行があるので従来どおり異常として上げる。
        const allDroppedFor = (kind) => droppedFromPost.length > 0 && droppedFromPost.every((d) => d.kind === kind);
        // (a) 店が同じ画像を再投稿しただけ。内容は1件目から取り込めている。
        const allAlreadyImported = allDroppedFor('duplicate-in-run');
        // (b) そもそも大会が1件も写っていない投稿(定休日だけの月・リングゲームの案内など)。
        //     2026-08-01 の dry-run #5 で、v34 の19行がすべてリングゲームの投稿で赤くなった。
        //     PR #30 でリングゲーム判定が先に効くようになり、以前は duplicate-in-run として
        //     再投稿に分類されていたものが異常に変わったもの。【失われた大会は1件も無い】。
        const allNotATournament = allDroppedFor('not-a-tournament');
        // (c) 人が admin.html で日時を訂正した投稿。id は日時から作るのでスロットがズレて衝突する。
        //     【人の訂正は正しく守られている】のに、その投稿がApifyの取得窓に残る限り毎日赤くなる。
        //     id が日時を含む以上、この kind は「人が日時を訂正した」以外の原因では発生しない。
        const allHumanEdited = allDroppedFor('existing-slot-conflict');
        if (allAlreadyImported || allNotATournament || allHumanEdited) {
          const label = allAlreadyImported
            ? '再投稿と判断しました'
            : allNotATournament
              ? '大会が含まれない投稿と判断しました'
              : '人が日時を訂正した投稿と判断しました';
          if (allAlreadyImported) {
            repostedPosts += 1;
            detail.outcome = '再投稿';
          } else if (allNotATournament) {
            notATournamentPosts += 1;
            detail.outcome = '大会なし';
          } else {
            humanEditedPosts += 1;
            detail.outcome = '人の訂正と衝突';
          }
          console.log(
            `[monitor-instagram-apify] ${label}(異常ではありません): 店=${store.label}(${store.venueId})` +
              ` / 投稿=${post.permalink}(${post.postedAt}) / 抽出${rows.length}件はすべて` +
              `${allAlreadyImported ? '既に取込み済みの行と同一' : allNotATournament ? '大会ではない行' : '人が訂正した既存と衝突'}のため、` +
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
    // 【この2本を summary に写し忘れると保存則が NaN になる】checkPostAccounting は
    // 内訳を足し算するので、1つでも undefined があれば合計が NaN になり、
    // `NaN === scheduleLikeCount` は常に false = 【毎回「集計が合わない」と誤報する】。
    // 誤報が常態化すると本物の不整合が読めなくなるので、走査フェーズで数えた値は必ずここで写す。
    summary.notCalendarPostCount = notCalendarPosts;
    summary.pastCalendarPostCount = pastCalendarPosts;
    summary.unusablePostCount = unusablePosts;
    summary.repostedPostCount = repostedPosts;
    summary.notATournamentPostCount = notATournamentPosts;
    summary.humanEditedPostCount = humanEditedPosts;
    summary.importedPostCount = importedPosts;
    summary.visionFailedCount = visionFailedPosts;
    summary.imageFailedCount = imageFailedPosts;
    summary.emptyResultCount = emptyResultPosts;
    summary.visionRowCount = visionRows;
    summary.notAdoptedRowCount = notAdoptedRows;

    // ============================================================
    // 【★探索モードは状態を1バイトも動かさない★】
    // ============================================================
    // ここから下(確認済み投稿日時の前進・判定キャッシュ・lastExtraction・マージ)は
    // 【探索では一切行わない】。理由は2つ:
    //   1. lastPostedAt を進めるとバックログを消費する。探索は「測るだけ」なので消費してはいけない
    //   2. 判定キャッシュを書くと、次の本番実行が探索の判定を再利用してしまう。
    //      探索は【本番とは違う判断(打ち切らない)】をしているので、その結果を本番に持ち込まない
    // 呼び出し側の dry-run 分岐(状態ファイルを書かない)と合わせて二重に効かせてある。
    // この関数が返す state は、渡された state と【ビット単位で同じ】であること(テストで固定)。
    if (probe) {
      // 【投稿別の明細はここでも必ず埋める】埋め忘れると呼び出し側の M-4 検査
      // (明細の行数 === 対象投稿数)が毎回 ::error:: を出す = 空振りの赤になる。
      summary.posts = postDetails;
      summaries.push(summary);
      continue;
    }

    // 新着の確認記録は、Vision抽出の成否に関わらずこの店で確認できた最新投稿まで進める
    // (同じ投稿を毎回「新着」として拾い直し続けないため)。
    const newest = newPosts[newPosts.length - 1];
    nextState[store.venueId] = { handle: store.handle, lastPostedAt: newest.postedAt, lastPermalink: newest.permalink };
    // 【投稿ごとの判定結果を残す】キーワード判定を廃止したぶん初回は window 全体を舐めるが、
    // ここに残せば以降の Vision 呼び出しは【本当に新しい投稿の数】に比例する。
    // 画像DL失敗・Vision失敗の投稿は【判定できていないので載せない】(次回やり直せるように)。
    if (summary.checkedPosts && Object.keys(summary.checkedPosts).length > 0) {
      nextState[store.venueId].checkedPosts = summary.checkedPosts;
    } else if (prev && prev.checkedPosts) {
      nextState[store.venueId].checkedPosts = prev.checkedPosts;
    }

    // 【マージを先に行う】行レベルの内訳(added/updated/unchanged/pastDated)は mergeStore が
    // 返すので、これを lastExtraction に書くにはマージが先に済んでいる必要がある。
    if (extracted.length > 0) {
      // 【mergeStore には手を入れない】「実際に増えた行」はマージ前後のidの差分で求める。
      // 共有モジュール(import-venue-image.js / Waitinglist取込みとの関係)に触らずに済み、
      // かつ「追加」の定義がマージの実装ではなく観測結果になる。
      const beforeIds = new Set(arr.map((t) => t.id));
      // ★突き合わせの左辺はマージ前のディープコピー。arr と next が同じ要素オブジェクトを
      //   共有していると、in-place で書き換えるバグが両辺に同じように映って素通りする。
      const beforeSnapshot = JSON.parse(JSON.stringify(arr));
      const { next, stats, written } = mergeLib.mergeStore(arr, store.venueId, extracted, today, {
        records: writeRecords,
        // ★seed は渡さない。この経路が書くのは source:'semi' で、人が admin.html で
        //   入れた行と同じ source。seed を足すと手入力572件が機械のものに化ける。
      });
      // 【★この2本は店単位の隔離を受けない★】(README リスク台帳 #20・実測で確認)
      //   上の Apify取得失敗は try/catch で店ごとにスキップされるが、この2本は catch の外にある。
      //   2店目で鳴ると例外が runMonitor の外まで飛び、呼び出し側が fail() → exit(1) するので、
      //   【1店目までの取込みごと捨てられる】。「1店の障害で全店を止めない」という
      //   このツールの柱は、取得失敗にしか掛かっていない。
      //   ★それでよい面もある(自分のバグを検出したのだから書き進めない方が正しい)が、
      //     非対称が文書化されていなかったので記録した。挙動は変えていない。
      mergeLib.assertOnlyTargetChanged(beforeSnapshot, next, store.venueId, today);
      // 人の行・人が直した項目が1つも壊れていないことの突き合わせ。
      // ★stats を一切参照しない(集計を潰す変異が入っても独立に生き残る)。
      mergeLib.assertHumanEditsPreserved(beforeSnapshot, next, { records: writeRecords });
      arr = next;
      changed = true;
      summary.stats = stats;
      Object.assign(writtenAll, written);
      // 【M-1】人の行を守って書かなかった行を、その理由になった人の行ごと明細に出す。
      // 【★2026-08-04に意味が反転した】以前ここは「人の入力を置き換えた行」に
      // `★既存の手入力(id=…)を置き換え` と印を付けていた。いまは置き換えないので
      // その印は永久に発火しない = 鳴らない警報になるため削除した。
      // 代わりに【書かなかった行】を出す。⑤にとってはこちらの方が情報量が多い —
      // 人の値と機械の読み値がずれているなら、そのずれ自体が確認対象になる。
      summary.protectedRows = stats.protectedRows.map(({ incoming, existing }) => ({
        incoming,
        existing,
        permalink: sourceByEntryId.get(incoming.id) || null,
      }));
      summary.addedRows = next
        .filter((t) => t.venueId === store.venueId && !beforeIds.has(t.id))
        .map((entry) => ({
          entry,
          permalink: sourceByEntryId.get(entry.id) || null,
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
      // 【投稿別の「追加0」に理由を与える】人の行を守って見送った行を投稿ごとに数える。
      // これが無いと ⑤ は「抽出28行なのに追加0」を日付レンジでしか説明できず、
      // 「人の行を守ったから0」なのか「別の経路で消えたのか」を区別できない。
      for (const row of summary.protectedRows) {
        const d = postDetails.find((x) => x.permalink === row.permalink);
        if (d) d.protectedCount += 1;
      }
    }
    summary.posts = postDetails;

    // 【取込みが成立した日を控える】= data.js に1行でも書けた日。
    // 「静かな停止」(#22 に限らず、Apifyが常に空を返す・カレンダーが一度も一致しない等)を
    // 人が見つけられるようにするための【測定】で、警報ではない。
    // ★成立の定義は「採用したカレンダーから data.js の行が増えた/変わった」。
    //   unchanged(同じ内容を読み直しただけ)は含めない — 含めると、同じカレンダーが
    //   取得窓に残っている限り毎日「成立」になり、止まっていることが見えなくなる。
    const importedRows = summary.stats ? summary.stats.added + summary.stats.updated : 0;
    if (importedRows > 0) summary.lastImportedAt = today;
    // 状態ファイルにも残す(runログは既定90日で消えるので、日数はここからしか復元できない)。
    // ★毎回変わる値ではないので、無意味な日次差分にはならない(成立した日だけ動く)。
    if (nextState[store.venueId] && summary.lastImportedAt) {
      nextState[store.venueId].lastImportedAt = summary.lastImportedAt;
    }

    // 抽出品質を【記録として残す】。GitHub Actions の注記は緑のrunでは通知が飛ばず、
    // runログも既定90日で消えるため、注記だけでは「Visionの抽出品質を人が測れる」を満たせない。
    // この状態ファイルは元から毎回コミットされるので、ここに書けばgit履歴に差分として残り、
    // ダッシュボードからも読める。Vision抽出を実際に行った店だけ更新し、行っていない店は
    // 前回値をそのまま持ち越す(毎回変わる値を足して無意味な日次差分を増やさないため)。
    // 【M-2】キーワード不一致で全部落ちた店(折尾の「新着12件→対象0件」がまさにこれ)でも記録する。
    // ここを `scheduleLike.length > 0` だけにしていると、【このカウンタが最も必要な場面】で
    // lastExtraction 自体が書かれず、状態ファイルに lastPostedAt しか残らない。
    // 「runログは90日で消えるので永続カウンタが要る」という理屈がそこだけ破れてしまう。
    if (summary.newPostCount > 0) {
      nextState[store.venueId].lastExtraction = {
        checkedAt: today,
        posts: summary.scheduleLikeCount,
        kept: extracted.length,
        dropped: summary.droppedCount,
        // 正規化した行数と再投稿と判断した投稿数も残す。これが無いと
        // 「dropped が多いのに unusablePosts が 0」の理由(=再投稿)が状態ファイルから読めず、
        // Visionの出力形式がどれだけ揺れているか(normalized)も測れない。
        normalized: summary.normalizedCount,
        unusablePosts,
        reposts: repostedPosts,
        notATournamentPosts,
        humanEditedPosts,
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
        filteredOut: summary.filteredOutCount, // キーワード判定の廃止により常に0(保存則の形は残す)
        importedPosts,
        visionFailed: visionFailedPosts,
        imageFailed: imageFailedPosts,
        emptyResult: emptyResultPosts,
        // 【走査フェーズの行き先も残す】これが無いと状態ファイルには「新着12件・取込み0件」しか
        // 残らず、「カレンダーを1枚も出していない店」なのか「カレンダーはあるが過去月ばかり」
        // なのかが git履歴から読めない(runログは90日で消える)。
        notCalendar: notCalendarPosts,
        pastCalendar: pastCalendarPosts,
        unexamined: summary.unexaminedPostCount,
        cacheHit: summary.cacheHitCount,
        // 行レベルの突き合わせ用(抽出 = 不採用の投稿の行+追加+更新+変更なし+過去日+破棄)
        visionRows,
        notAdoptedRows,
        pastDated: summary.stats ? summary.stats.pastDated : 0,
        added: summary.stats ? summary.stats.added : 0,
        updated: summary.stats ? summary.stats.updated : 0,
        unchanged: summary.stats ? summary.stats.unchanged : 0,
        // 【人の行を守って書かなかった行数】runログは既定90日で消えるので、
        // 「なぜ追加が少ないのか」を後から git履歴で追えるようにここに残す。
        protectedRows: summary.stats ? summary.stats.protected : 0,
        protectedFields: summary.stats ? summary.stats.fieldsProtected : 0,
      };
    } else if (prev && prev.lastExtraction) {
      nextState[store.venueId].lastExtraction = prev.lastExtraction;
    }

    summaries.push(summary);
  }

  return {
    arr,
    state: nextState,
    written: writtenAll,
    changed,
    summaries,
    anomalies,
    lostPosts,
    emptyResults,
    storeFailures,
    storeCount: stores.length,
  };
}

/**
 * 店1つぶんのサマリの初期値。
 *
 * 【fetch より前に作れること】が要件。取得に失敗した店も「対象だったのに観測できなかった」
 * という1行を残さないと、店レベルの保存則が成り立たず「新着0件」と見分けが付かなくなる。
 */
function makeStoreSummary(store) {
  return {
    store,
    // 取込みレベル(取得に成功してから埋める)
    apifyRawCount: 0,
    malformedCount: 0,
    invalidPostedAtCount: 0,
    alreadySeenCount: 0,
    newPostCount: 0,
    scheduleLikeCount: 0,
    filteredOutCount: 0,
    extractedCount: 0,
    droppedCount: 0,
    dropped: [],
    normalizedCount: 0,
    normalized: [],
    // 投稿レベルの内訳。新着の1投稿は必ずこのどれか1つに入る。
    // 【0で初期化しておくこと】取得に失敗した店・新着0件の店はこの下の処理へ進まないので、
    // ここで初期化していないと undefined のまま checkPostAccounting に渡り、合計が NaN になる
    // (NaN === 0 は false なので、何も観測していない店が毎回「集計が合わない」と誤報される)。
    importedPostCount: 0,
    repostedPostCount: 0,
    notATournamentPostCount: 0,
    humanEditedPostCount: 0,
    unusablePostCount: 0,
    visionFailedCount: 0,
    imageFailedCount: 0,
    emptyResultCount: 0,
    notCalendarPostCount: 0,
    pastCalendarPostCount: 0,
    unexaminedPostCount: 0,
    cacheHitCount: 0,
    examinedPostCount: 0,
    // 【探索モード(--probe)専用】当月以降のカレンダーだと判定したが、採用しなかった投稿。
    // 本番では走査がそこで打ち切られて `importedPostCount` 側に入るので【常に0】。
    // 0のまま動かない項をわざわざ保存則に入れてあるのは、探索モードで投稿が
    // どのバケツにも入らなくなる(=測定が静かに壊れる)ことを防ぐため。
    probeCalendarPostCount: 0,
    // 本番なら「既読」として飛ばしていた投稿を、探索では何件やり直したか。
    probeReExaminedCount: 0,
    // 位置(新しい順)ごとの判定一覧。探索モードでだけ配列になる。
    probeVerdicts: null,
    // 【矛盾の検出(#22)】確認済み投稿日時が未来 = その店の取込みが静かに止まっている。
    impossibleLastPostedAt: null,
    // 【静かな停止の測定】最後に取込みが成立した日(YYYY-MM-DD)。一度も無ければ null。
    lastImportedAt: null,
    // 当月カレンダーの有無(店ごとに「あり/なし」を出すための材料)
    currentMonthCalendar: null,
    latestPastCalendar: null,
    checkedPosts: null,
    // 行レベル。visionRowCount = Visionが返した行の総数。
    visionRowCount: 0,
    notAdoptedRowCount: 0,
    stats: null,
    // 取得そのものに失敗した店(この店は1件も観測できていない)。
    fetchFailed: false,
    fetchError: null,
    fetchElapsedMs: null,
    // 手順⑤(採用行の全件照合)のための明細。
    addedRows: [],
    // 【★バケツを1つ増やしたら初期値も必ず足すこと】足し忘れると checkRowAccounting の
    //   合計が NaN になり、`NaN === visionRowCount` は常に偽なので毎回誤報する。
    protectedRows: [],
    posts: [],
  };
}

/**
 * 【店レベルの保存則】対象の店は、必ず「観測できた」か「取得に失敗した」かのどちらかに入る。
 *
 * 【なぜ要るか】店舗単位で隔離すると、失敗した店は取込み・投稿・行のどの保存則からも
 * 「0件」として素通りする(何も観測していないので 0 = 0 で成立してしまう)。
 * それ自体は正しいが、**「取得に失敗した店」と「新着が無かった店」が同じ0に見える**のは
 * この案件が繰り返し潰してきた誤報の形そのもの。店の単位でも数え、必ず表に出す。
 *
 * @returns {{ ok: boolean, expected: number, observed: number, failed: number }}
 */
function checkStoreAccounting(summaries, storeCount) {
  // 【★summaries.length と比べてはいけない★】observed を `summaries.length - failed` で
  // 出して `observed + failed === summaries.length` を見ると【恒等式】になり、何も検査しない。
  // R-1 で潰したのとまったく同じ罠(各項を残差で定義すると保存則が自明になる)。
  // 比べる相手は【対象店舗の数】。こうすると「summaries.push を忘れた店」が残余として出る。
  const failed = summaries.filter((s) => s.fetchFailed).length;
  const observed = summaries.filter((s) => !s.fetchFailed).length;
  const expected = typeof storeCount === 'number' ? storeCount : summaries.length;
  return { ok: observed + failed === expected, expected, observed, failed, missing: expected - (observed + failed) };
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
    // 探索モードで「当月以降のカレンダーだが採用しない」と判断した投稿(本番では常に0)。
    summary.probeCalendarPostCount +
    summary.notCalendarPostCount +
    summary.pastCalendarPostCount +
    summary.unexaminedPostCount +
    summary.cacheHitCount +
    summary.repostedPostCount +
    summary.notATournamentPostCount +
    summary.humanEditedPostCount +
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
 *   Visionが返した行 = 不採用の投稿の行 + 破棄 + 過去日 + 追加 + 更新 + 変更なし + 人の行を守って見送り
 *
 * 2026-07-31 の dry-run では「久留米: 抽出20 / 破棄0 / 追加0」のように、
 * 抽出した行がどこへ消えたのか誰も説明できない数字が並んでいた(正常に全部過去日だったのか、
 * 別の経路で消えたのかが区別できない)。残余が出るなら、それが未知の消失経路そのもの。
 *
 * 【notAdopted を足した理由(2026-08-04)】走査フェーズでは「カレンダーではない」
 * 「過去月のカレンダー」と判断した投稿の行もVisionから返ってくる。新方式では大半の投稿が
 * これに当たるため、数えないと【正常な実行で毎回この保存則が破れて誤報になる】。
 * なお notAdopted は不採用と判断したその場で加算する(残差ではない)ので、この式は恒等式にならない。
 *
 * 【protected を足した理由(2026-08-04)】人が入力した行と同じ枠に来た行は
 * 【書かずに見送る】ようになった(人の行を機械が置き換えないため)。以前はこれが
 * `updated` に入っていたので式は成り立っていたが、見送りは更新ではないので項を分ける。
 * ★これも「書かないと決めたその場で +1」する。`rawFuture.length - 書いた数` にすると
 *   保存則が恒等式になり、別の理由で行が消えてもこの項に吸い込まれて表に出なくなる。
 *
 * @returns {{ ok: boolean, rows: number, notAdopted: number, dropped: number, pastDated: number,
 *             added: number, updated: number, unchanged: number, protected: number, residual: number }}
 */
function checkRowAccounting(summary) {
  const s = summary.stats || { pastDated: 0, added: 0, updated: 0, unchanged: 0, protected: 0 };
  const notAdopted = summary.notAdoptedRowCount || 0;
  const protectedRows = s.protected || 0;
  const accounted =
    notAdopted + summary.droppedCount + s.pastDated + s.added + s.updated + s.unchanged + protectedRows;
  return {
    ok: accounted === summary.visionRowCount,
    rows: summary.visionRowCount,
    notAdopted,
    dropped: summary.droppedCount,
    pastDated: s.pastDated,
    added: s.added,
    updated: s.updated,
    unchanged: s.unchanged,
    protected: protectedRows,
    residual: summary.visionRowCount - accounted,
  };
}

// ============================================================
// 探索専用モード(--probe)の測定 — リスク台帳 #13
// ============================================================
/**
 * 【この測定が答える問い】
 *   「採用したカレンダーより【新しい位置】にある投稿のうち、カレンダー判定を満たすものは何件か」
 *
 * 【なぜ「偽陽性が何件あるか」ではないのか(レビュー部の指定)】
 *   偽陽性かどうかは、正解(その店の本物の当月カレンダー)を知らないと判定できず、
 *   正解は画像の中にしか無い。機械が数えられるのは【形】と【位置】だけである。
 *   #13 の危険は「本物より新しい位置に、形だけカレンダーに見える投稿が居ること」なので、
 *   数えるべきは **その位置にその形の投稿が何件あるか**。
 *   ここが 0 なら、少なくとも今の取得窓では【追い越せる位置に候補が存在しない】と言える。
 *
 * 【★この数は「偽陽性が起きない」ことの証明ではない★】
 *   ・0 でも、それは【この run の取得窓での観測】にすぎない(将来の投稿には何も言えない)
 *   ・採用した1枚そのものが偽陽性である可能性は、この数では否定できない。
 *     そちらは `behindCurrentMonth`(採用より【古い位置】にある当月以降のカレンダー)を見る —
 *     本番の走査は打ち切りでそこに到達しないので、【この数は探索でしか観測できない】
 *   ・画像DL失敗 / Vision抽出失敗 / Vision 0件 の投稿は【形が確定していない】。
 *     `aheadUndetermined` / `aheadEmpty` が 0 でない限り、`aheadCalendars` の 0 は
 *     「候補が無い」ではなく「見えた範囲に候補が無い」である。必ず併記すること
 *
 * 【aheadCurrentMonth が構造的に 0 になることについて】
 *   採用位置は「新しい順で最初の当月以降のカレンダー」なので、それより新しい位置に
 *   当月以降のカレンダーは定義上存在しない。**0 と分かっていても出す** —
 *   0 でない値が出たらこの前提(=採用位置の決め方)が壊れているという意味になるため。
 */
/**
 * 【形が確定した判定】= Visionの応答から支配月・異なる日付・広がりを計算できたもの。
 * 画像DL失敗 / Vision抽出失敗は形が分からないので【比較の対象にしない】。
 */
const SHAPE_DETERMINED_KINDS = new Set(['calendar-current', 'calendar-past', 'not-calendar', 'empty']);

function probeMetrics(summary) {
  const verdicts = Array.isArray(summary.probeVerdicts) ? summary.probeVerdicts : [];
  const adoptedIndex = verdicts.findIndex((v) => v && v.kind === 'calendar-current');
  const ahead = adoptedIndex < 0 ? [] : verdicts.slice(0, adoptedIndex);
  const behind = adoptedIndex < 0 ? [] : verdicts.slice(adoptedIndex + 1);
  // 【残差で数えない】どの群も「その kind であること」を正の述語で数える。
  // 引き算で出すと、kind が増えたときに黙って別の群へ吸い込まれる。
  const count = (list, kind) => list.filter((v) => v && v.kind === kind).length;
  const calendars = (list) => list.filter((v) => v && (v.kind === 'calendar-current' || v.kind === 'calendar-past'));
  return {
    total: verdicts.length,
    adoptedIndex,
    adopted: adoptedIndex < 0 ? null : verdicts[adoptedIndex],
    aheadTotal: ahead.length,
    // ★レビュー部が指定した数字。位置=採用より新しい / 形=カレンダー判定を満たす
    aheadCalendars: calendars(ahead).length,
    aheadCurrentMonth: count(ahead, 'calendar-current'),
    aheadPastMonth: count(ahead, 'calendar-past'),
    aheadNotCalendar: count(ahead, 'not-calendar'),
    aheadEmpty: count(ahead, 'empty'),
    aheadUndetermined: count(ahead, 'image-failed') + count(ahead, 'vision-failed'),
    behindTotal: behind.length,
    // 本番の走査は打ち切りでここへ到達しない = 探索でしか見えない数
    behindCurrentMonth: count(behind, 'calendar-current'),
    behindPastMonth: count(behind, 'calendar-past'),
    behindNotCalendar: count(behind, 'not-calendar'),
    behindEmpty: count(behind, 'empty'),
    behindUndetermined: count(behind, 'image-failed') + count(behind, 'vision-failed'),
    // 採用が1枚も無かった店(=当月以降のカレンダーが取得窓に存在しない)でも
    // 形の分布は測りたいので、全体の内訳も返す。
    allCalendars: calendars(verdicts).length,
    ...shapeComparison(verdicts, adoptedIndex),
  };
}

/**
 * 【#13 の署名 = 採用した投稿が、その店の窓内で最もカレンダーらしい投稿ではないこと】
 *
 * 【なぜ分類ではなく「形」を比べるのか(2026-08-05・レビュー部の指示)】
 *   上の ahead/behind の数は【分類】(カレンダーか否か・当月か過去月か)に依存しているので、
 *   **採用が偽陽性 かつ 後ろの本物も偽陰性**だと、後ろの本物が数えられず
 *   `behindCurrentMonth` は **0のまま実害が起きる**。両方の誤りが同時に必要なので確率は低いが、
 *   cron の可否を決める証拠としては残しておきたくない盲点だった。
 *   **形(異なる日付)の比較は分類を経由しない**ので、後ろの本物が偽陰性でも効く。
 *
 *   レビュー部の再現がそのまま例になる —
 *   偽陽性は `異なる日付=5`、本物は `20`。「**採用が5、窓内に20が居る**」は直接の異常サイン。
 *
 * 【比較の母集団は「形が確定した全投稿」】カレンダーと判定されたものに限らない。
 *   限ると、まさに拾いたい偽陰性(本物なのに not-calendar / 支配月を読み違えて past)が
 *   母集団から抜ける。
 *
 * 【★この指標が拾えないもの】本物のカレンダーから Vision が【少ししか日付を読めなかった】
 *   場合は、その投稿の `異なる日付` 自体が小さいので比較でも浮かばない。
 *   「形が確定していない投稿」の件数と併せて読むこと(README の実走の読み方)。
 *
 * 【同点は「採用が最強」に倒す】同じ `異なる日付` の投稿が他にあっても、
 *   採用が【より弱い】わけではない。比較で「小さい」と言うのは厳密に小さいときだけ
 *   (同点を小さい扱いにすると、同じカレンダーの再投稿がある店で毎回そう出る)。
 *
 * 【★「採用が最大でない」ことと「★印を出す」ことは別★(2026-08-05・実測で分離した)】
 *   比較そのもの(adoptedIsStrongest)は全店・全投稿に対して今までどおり行い、行にも出す。
 *   ★印と `::warning::` を出すのは、そのうち `shapeSignature` の条件を満たしたものだけ。
 *   理由は `shapeSignature` のコメントを参照。
 */
function shapeComparison(verdicts, adoptedIndex) {
  const shaped = verdicts.filter((v) => v && SHAPE_DETERMINED_KINDS.has(v.kind));
  let strongest = null;
  for (const v of shaped) {
    if (!strongest || v.distinctDates > strongest.distinctDates) strongest = v;
    // 同点なら採用した投稿を代表にする(表示が「採用そのもの」になり、読み違えを防ぐ)
    else if (v.distinctDates === strongest.distinctDates && v.index === adoptedIndex) strongest = v;
  }
  const adopted = adoptedIndex >= 0 ? verdicts[adoptedIndex] : null;
  return {
    shapedCount: shaped.length,
    strongest: strongest
      ? {
          index: strongest.index,
          permalink: strongest.permalink,
          kind: strongest.kind,
          dominantMonth: strongest.dominantMonth === undefined ? null : strongest.dominantMonth,
          distinctDates: strongest.distinctDates,
          spanDays: strongest.spanDays,
        }
      : null,
    maxDistinctDates: strongest ? strongest.distinctDates : 0,
    // 採用が無い / 形が1件も確定していない店では判定できない(false にはしない)
    adoptedIsStrongest: adopted && strongest ? adopted.distinctDates >= strongest.distinctDates : null,
    strongestPosition:
      !adopted || !strongest
        ? null
        : strongest.index === adoptedIndex
          ? 'adopted'
          : strongest.index < adoptedIndex
            ? 'ahead'
            : 'behind',
    ...shapeSignature(adopted, strongest),
  };
}

/**
 * 【★印(#13 の署名)を出す条件】— 2026-08-05 の実走(run 30963380537)で絞り込んだ。
 *
 * 【なぜ絞ったか — 「採用が窓内の最大でない」だけでは誤警報が構造的に出る】
 *   実走で ★ は **6店中4店**で点灯し、**4件すべてが誤警報**だった(画像で確認済み)。
 *   4件とも `窓内の最大` は【過去月のカレンダー】で、当月ぶんより日付が多かっただけである:
 *
 *     v40 採用29 / 最大30(past)   v20 採用17 / 最大23(past)
 *     v18 採用26 / 最大30(past)   v35 採用29 / 最大30(past)
 *
 *   1店あたり過去月のカレンダーが窓内に4〜5枚あり、各月25〜31日付でばらつくので、
 *   **当月ぶんがその最大になる確率はおよそ 1/5**。つまり ★ は放っておいても改善せず、
 *   **80%の誤警報率が既知の警報を、人は開かなくなる**(2026-08-05・レビュー部)。
 *
 * 【★母集団は絞っていない★】比較する相手は今までどおり「形が確定した全投稿」で、
 *   `adoptedIsStrongest` / `strongest` も全店で今までどおり出す。**絞ったのは印だけ。**
 *   母集団を絞ると、まさに拾いたい偽陰性(本物が not-calendar / past と誤読)が抜ける。
 *   印が付かない比較は【参考行】として1行要約に残るので、**比較そのものは消えていない**。
 *
 * 【条件は2つの OR。片方だけでは要件を満たさない】
 *   (1) **窓内の最大の支配月が、採用の支配月以上**(レビュー部の提案)
 *       — 当月以降を名乗る投稿が採用より大きい = 分類が正しい前提での #13 そのもの。
 *   (2) **採用の異なる日付が、窓内の最大の【半分以下】**
 *       — (1) だけだと、レビュー部自身が指摘した盲点(**本物が支配月を誤読されて past 扱い**)に
 *         印が付かない。その形は (1) を満たさないまま実害が起きるので、(1) だけでは足りない。
 *
 * 【なぜ「半分以下」か — 両方向の値で挟んである】
 *   ・**鳴らない側は実測**: 上の4件の比は **17/23=0.74 〜 29/30=0.97**。最小でも 0.74 で、
 *     同じ店の月間カレンダーどうしが半分になることは、営業日数が半減しない限り起きない
 *     (月の長さだけなら比は最大でも 31/28=1.11)
 *   ・**鳴る側はレビュー部が構成した再現シナリオ**(実測ではない): 偽陽性のシリーズ告知は
 *     `異なる日付=5`、本物は `20` で **5/20=0.25**
 *   ・0.74 と 0.25 の間を取って **1/2**。どちら側にも 1.5倍以上の余裕がある
 *   ★この 1/2 は「鳴る側の実データ」を持たない閾値である(#13 の実害は一度も観測されていない)。
 *     **緩めるにせよ厳しくするにせよ、上の4件と再現シナリオの両方を測り直してから動かすこと。**
 *
 * 【この絞りで何を捨てたか(正直に)】採用が最大の 0.5〜1.0 倍に収まる偽陽性には印が付かない。
 *   その形は【参考行】としてログに残るので、**比較を読む人には見える**。消えるのは注意喚起だけ。
 */
function shapeSignature(adopted, strongest) {
  // 採用が無い / 形が1件も確定していない店では判定できない(false にはしない)
  if (!adopted || !strongest) return { signature: null, signatureReasons: [] };
  // 採用が窓内の最大そのもの(同点を含む)なら、そもそも比較で負けていない
  if (adopted.distinctDates >= strongest.distinctDates) return { signature: false, signatureReasons: [] };
  const reasons = [];
  // (1) 支配月が読めていない投稿(日付0件)は最大になれないので、ここに来る時点で両方ある想定。
  //     それでも欠けていたら【この条件は判定しない】— 欠損を「鳴る」側にも「鳴らない」側にも倒さない。
  if (adopted.dominantMonth && strongest.dominantMonth && strongest.dominantMonth >= adopted.dominantMonth) {
    reasons.push('month');
  }
  // (2) 整数のまま比べる(0.5 を浮動小数で作らない)
  if (adopted.distinctDates * 2 <= strongest.distinctDates) reasons.push('half');
  return { signature: reasons.length > 0, signatureReasons: reasons };
}

/**
 * 形状比較の【店ごとの1行要約】。
 *
 * 【1行にする理由】生ログ(投稿ごとの判定行)を人が突き合わせる形にすると、
 * cron 後には誰もやらない。判断に要る3つ(採用の形 / 窓内の最大 / その位置)を1行に載せる。
 *
 * 【★採用側の permalink も必ずこの行に載せること(2026-08-05・品質管理部の指摘)★】
 * 印が付くのは異常時で、そのとき担当がすることは【2枚の画像を見比べる】ことしかない。
 * 片方のURLしか無いと、同じ店のブロックの別の行(「本番ならここで採用して打ち切っていた投稿」)を
 * 探しに行くことになり、**1行に集約した意味が薄れる**。
 * ★この行だけで2枚に到達できることをテストで固定してある(URLを1つに減らす変異で落ちる)。
 *
 * 【★印が付かない比較も必ずこの行に残す(2026-08-05)★】
 * ★の条件を絞った(`shapeSignature`)結果、「採用は窓内の最大ではないが署名ではない」行が出る。
 * その行を消すと**母集団を絞ったのと同じ**になり、支配月を誤読された本物が見えなくなる。
 * だから **参考: …** として、何が理由で印を付けなかったかまで書いて残す。
 */
function formatProbeShapeComparison(store, m) {
  const head = `[monitor-instagram-apify] 形状比較: 店=${store.label}(${store.venueId})`;
  if (!m.strongest) return `${head} / 形が確定した投稿がありません(比較できません)`;
  const pos =
    m.strongestPosition === 'adopted'
      ? '採用した投稿そのもの'
      : m.strongestPosition === 'ahead'
        ? '採用より【新しい位置】'
        : m.strongestPosition === 'behind'
          ? '採用より【古い位置】'
          : '採用なし';
  const strongest =
    `窓内の最大=異なる日付${m.strongest.distinctDates}・広がり${m.strongest.spanDays}日` +
    `(${pos} / 判定=${m.strongest.kind} / ${m.strongest.permalink})`;
  if (!m.adopted) {
    return `${head} / 採用=なし(当月以降のカレンダーが無い) / ${strongest}`;
  }
  const adopted =
    `採用=異なる日付${m.adopted.distinctDates}・広がり${m.adopted.spanDays}日` +
    `(${m.adopted.permalink})`;
  return `${head} / ${adopted} / ${strongest} / ${formatShapeMark(m)}`;
}

/** 1行要約の末尾。★署名 / 参考(印を付けない理由つき) / 採用が最大、の3通り。 */
function formatShapeMark(m) {
  if (m.adoptedIsStrongest) return '採用が窓内で最もカレンダーらしい投稿';
  if (m.signature) {
    return `★採用は窓内で最もカレンダーらしい投稿ではない(#13 の署名: ${formatSignatureReasons(m)})`;
  }
  // 【参考行】比較では負けているが署名の条件を満たさない。**なぜ印を付けないかまで書く** —
  // 理由が無いと「警報が出ていない」と「比較していない」の区別が読み手に付かない。
  const month =
    m.strongest.dominantMonth && m.adopted.dominantMonth
      ? `支配月が採用より古く(${m.strongest.dominantMonth} < ${m.adopted.dominantMonth})`
      : '支配月を比べられず';
  return (
    `参考: 窓内の最大は採用より大きい(${m.adopted.distinctDates}→${m.maxDistinctDates})が、` +
    `${month}、採用は最大の半分を超えている → #13 の署名ではない(★は付けない)`
  );
}

/** どちらの条件で署名が立ったかを日本語にする(両方立つこともある)。 */
function formatSignatureReasons(m) {
  const list = (m.signatureReasons || []).map((r) =>
    r === 'month'
      ? `窓内の最大の支配月(${m.strongest.dominantMonth})が採用(${m.adopted.dominantMonth})以上`
      : `採用${m.adopted.distinctDates}は窓内の最大${m.maxDistinctDates}の半分以下`
  );
  return list.join(' / ') || '条件不明';
}

/**
 * 【探索の保存則】判定した1投稿は、採用位置の前か後ろかに分かれ、そこで必ず1つの kind に入る。
 *
 * これが破れる = 判定一覧に穴が空いている(recordProbe を呼ばない経路が増えた)か、
 * 未知の kind が増えたということ。どちらも「測定結果が静かに小さく出る」形の壊れ方なので、
 * 件数を読む前にここで止める。★残差ではなく、正の述語で数えた各群の合計と比べる。
 */
function checkProbeAccounting(m) {
  const aheadSum =
    m.aheadCurrentMonth + m.aheadPastMonth + m.aheadNotCalendar + m.aheadEmpty + m.aheadUndetermined;
  const behindSum =
    m.behindCurrentMonth + m.behindPastMonth + m.behindNotCalendar + m.behindEmpty + m.behindUndetermined;
  // 採用が無い店は ahead/behind とも0件なので、比べる相手は「採用の有無で決まる期待値」。
  const expectedTotal = m.adoptedIndex < 0 ? 0 : m.aheadTotal + m.behindTotal + 1;
  return {
    ok: aheadSum === m.aheadTotal && behindSum === m.behindTotal,
    aheadSum,
    aheadTotal: m.aheadTotal,
    behindSum,
    behindTotal: m.behindTotal,
    expectedTotal,
    residual: m.aheadTotal - aheadSum + (m.behindTotal - behindSum),
  };
}

/**
 * 探索モードの結果を報告する。
 * 【この関数は data.js にも状態ファイルにも触らない】— 表示だけを行う。
 */
function reportProbe(summaries, storeCount) {
  console.log('');
  console.log('[monitor-instagram-apify] === 探索(--probe)の結果: リスク台帳 #13 の測定 ===');
  console.log('  この実行では【何も採用していません】。data.js も状態ファイルも書き換えていません。');
  console.log('  数えているのは「本物を追い越せる位置に、カレンダーの形をした投稿が何件あるか」です。');
  let totalAheadCalendars = 0;
  let totalBehindCurrent = 0;
  let totalAheadUndetermined = 0;
  let signatureStores = 0;
  let referenceStores = 0; // 採用が窓内の最大ではないが、署名の条件は満たさない店(参考行)
  for (const s of summaries) {
    if (s.fetchFailed) {
      console.log(`[monitor-instagram-apify] 探索: ${s.store.label}(${s.store.venueId}) … 取得失敗のため測定できていません`);
      continue;
    }
    if (!Array.isArray(s.probeVerdicts)) continue;
    const m = probeMetrics(s);
    const acc = checkProbeAccounting(m);
    console.log('');
    console.log(`[monitor-instagram-apify] 探索: ${s.store.label}(${s.store.venueId}) / 判定した投稿 ${m.total}件`);
    if (s.probeReExaminedCount > 0) {
      console.log(`  うち ${s.probeReExaminedCount}件は、本番なら「既読」として飛ばしていた投稿です(探索では判定し直しています)。`);
    }
    if (!acc.ok) {
      console.log(
        `::error title=Instagram監視 - 探索の集計が合わない::${s.store.label}(${s.store.venueId}): ` +
          `採用より新しい${acc.aheadTotal}件に対し内訳の合計が${acc.aheadSum}件、` +
          `古い${acc.behindTotal}件に対し${acc.behindSum}件です。判定一覧に穴があります(バグ)。`
      );
    }
    // 【★店ごとの1行要約(形状比較)は、採用の有無に関わらず必ず出す★】
    // これが #13 の署名(採用が窓内で最もカレンダーらしい投稿ではない)を直接指す行で、
    // 分類を経由しないので「後ろの本物が偽陰性」でも効く(shapeComparison のコメント参照)。
    console.log(formatProbeShapeComparison(s.store, m));
    if (m.signature === true) {
      signatureStores += 1;
      console.log(
        `::warning title=Instagram監視 - 採用が最もカレンダーらしい投稿ではない::` +
          `${s.store.label}(${s.store.venueId}): 採用した投稿は異なる日付${m.adopted.distinctDates}件ですが、` +
          `窓内には異なる日付${m.maxDistinctDates}件の投稿があります` +
          `(${m.strongestPosition === 'behind' ? '採用より古い位置' : '採用より新しい位置'} / ${m.strongest.permalink})。` +
          `条件: ${formatSignatureReasons(m)}。` +
          '**これが #13 の署名です** — 採用した1枚が偽陽性で、より完全なカレンダーを追い越している可能性があります。' +
          '画像を開いて、どちらが本物の月間カレンダーかを人が確かめてください。'
      );
    } else if (m.adoptedIsStrongest === false) {
      // 【★ここで ::warning:: を出さないのが今回の変更点★】比較では負けているが、
      // 過去月のカレンダーが大きかっただけ = 実走で6店中4店に出た形。上の1行要約に
      // 「参考: …」として残るので、比較そのものは消えていない。
      referenceStores += 1;
    }
    if (!m.adopted) {
      console.log(
        `  本番なら採用していた投稿: ありません(取得窓に当月以降のカレンダーが無い)。` +
          `カレンダーの形をした投稿は全体で ${m.allCalendars}件です。`
      );
      continue;
    }
    console.log(
      `  本番ならここで採用して打ち切っていた投稿: ${m.adopted.permalink}` +
        `(支配月=${m.adopted.dominantMonth} / 異なる日付=${m.adopted.distinctDates} / 広がり=${m.adopted.spanDays}日` +
        ` / 新しい順で${m.adoptedIndex + 1}件目)`
    );
    console.log(
      `  ★採用より【新しい位置】にあり、カレンダー判定を満たす投稿: ${m.aheadCalendars}件` +
        `(支配月が当月以降 ${m.aheadCurrentMonth}件 / 過去月 ${m.aheadPastMonth}件)` +
        ` ← 形だけなら追い越せた投稿の数(月の判定だけが止めている)`
    );
    // 【★この0を「安全」と読ませない★】採用位置は「新しい順で最初の当月以降のカレンダー」
    // なので、それより新しい位置に当月以降のカレンダーは【定義上存在しない】。
    // つまり上の行は #13 の「採用した1枚自身が偽陽性」という形を検出できない。
    // その形は必ず下の【古い位置】の行に現れるので、両方を並べて出す。
    console.log(
      '    ※上の「支配月が当月以降」は採用位置の決め方から常に0になります。' +
        '【採用した1枚そのものが偽陽性】かどうかは、この数では分かりません(下の行を見てください)。'
    );
    console.log(
      `    同じ位置のその他: カレンダーでない ${m.aheadNotCalendar}件 / Vision抽出0件 ${m.aheadEmpty}件 / ` +
        `形が確定していない ${m.aheadUndetermined}件(画像DL・Vision失敗)` +
        `${m.aheadUndetermined + m.aheadEmpty > 0 ? ' ← この件数がある限り、上の数は「見えた範囲での候補数」です' : ''}`
    );
    console.log(
      `  採用より【古い位置】にある当月以降のカレンダー: ${m.behindCurrentMonth}件` +
        ` ← 本番の走査は打ち切りでここに到達しません(採用した1枚が偽陽性なら、本物はこの中に居ます)`
    );
    console.log(
      `    同じ位置のその他: 過去月のカレンダー ${m.behindPastMonth}件 / カレンダーでない ${m.behindNotCalendar}件 / ` +
        `Vision抽出0件 ${m.behindEmpty}件 / 形が確定していない ${m.behindUndetermined}件`
    );
    totalAheadCalendars += m.aheadCalendars;
    totalBehindCurrent += m.behindCurrentMonth;
    totalAheadUndetermined += m.aheadUndetermined + m.aheadEmpty;
  }
  console.log('');
  console.log(
    `[monitor-instagram-apify] 探索の合計: 本物を追い越せる位置のカレンダー ${totalAheadCalendars}件 / ` +
      `打ち切りの後ろに隠れた当月以降のカレンダー ${totalBehindCurrent}件 / ` +
      `追い越せる位置で形が確定しなかった投稿 ${totalAheadUndetermined}件 / ` +
      `★#13 の署名が出た店 ${signatureStores}店(参考: 採用が窓内の最大でない店 ${referenceStores}店)`
  );
  console.log(
    '  【読み方】1つ目が0でも「偽陽性は起きない」ではありません。この取得窓での観測であり、' +
      '3つ目が0でない限り「見えた範囲で0」です。2つ目が0でなければ、採用した1枚が本物かどうかを' +
      '人が画像で確かめてください(機械には正解がありません)。'
  );
  console.log(
    '  【4つ目が #13 の署名】1〜2つ目は【分類】に依存するので、採用が偽陽性 かつ 後ろの本物も' +
      '偽陰性(カレンダーでない/過去月と判定)だと 0 のまま実害が起きます。4つ目は【形】だけを' +
      '比べるのでその場合も効きます。0でなければ、その店の画像を人が確かめてください。'
  );
  console.log(
    '  【括弧の「参考」は警報ではありません】採用が窓内の最大ではないが、相手が過去月のカレンダーで' +
      '採用の半分より多い場合です(2026-08-05 の実走では6店中4店がこれで、全件が誤警報でした)。' +
      '比較は各店の「形状比較:」の行に残してあるので、疑わしいときはその行を読んでください。'
  );
  // 【★この行が最後に出る = 探索が最後まで走った証拠★】理由は formatProbeCompletion 参照。
  console.log(formatProbeCompletion(probeCompletion(summaries, storeCount)));
}

/**
 * 【探索が最後まで走ったか】を、投稿数の突き合わせで判定する。
 *
 * 【なぜ要るか — 部分的な分布はいちばん危ない読み違えを生む】
 *   探索は打ち切らないので、取得窓の全投稿(実測で71件)が Vision に渡る。途中で
 *   ジョブが打ち切られる(タイムアウト)と【一部の店・一部の投稿だけを見た分布】が
 *   ログに残る。それを「全投稿を見た」と読むと、**#13 を誤った根拠で閉じる**ことになる。
 *   この案件が繰り返してきた「ゼロを安全と読む」の最も高くつく形。
 *
 * 【2通りの「不完全」を1つの式で見る】
 *   1. 取得に失敗した店がある … その店は1投稿も見ていない(タイムアウトでなくても起きる)
 *   2. 判定した投稿数が判定対象に足りない … 走査の途中で終わった/記録漏れ
 *   ★どちらも【正の述語】で数え、残差で出さない(残差にすると恒等式になり何も検査しない)。
 *
 * 【★タイムアウトで殺された場合はこの関数自体が呼ばれない★】
 *   そのときログにこの行が【出ない】ことが唯一の合図になる。だから
 *   「出るはずのものが出ない」を検知の合図にできるよう、**必ず最後に・必ず1行だけ**出す。
 *   ワークフロー側はこの行の有無を検査する(`.github/workflows/monitor-instagram-apify.yml`)。
 */
function probeCompletion(summaries, storeCount) {
  const observed = summaries.filter((s) => !s.fetchFailed);
  const failed = summaries.filter((s) => s.fetchFailed).length;
  const expected = typeof storeCount === 'number' ? storeCount : summaries.length;
  // 判定対象(走査するはずだった投稿)と、実際に判定を記録できた投稿。
  const targeted = observed.reduce((a, s) => a + s.scheduleLikeCount, 0);
  const judged = observed.reduce(
    (a, s) => a + (Array.isArray(s.probeVerdicts) ? s.probeVerdicts.filter(Boolean).length : 0),
    0
  );
  const missingStores = expected - (observed.length + failed);
  const complete = failed === 0 && missingStores === 0 && judged === targeted;
  return { complete, expected, observed: observed.length, failed, missingStores, targeted, judged };
}

/** 完走判定の1行。★文言ではなく `探索の完了状態:` の【有無】が機械可読の合図。 */
function formatProbeCompletion(c) {
  const head =
    `[monitor-instagram-apify] 探索の完了状態: 対象${c.expected}店 = 観測できた${c.observed}店 + 取得失敗${c.failed}店` +
    ` / 判定した投稿 ${c.judged}件(判定対象 ${c.targeted}件)`;
  if (c.complete) {
    return `${head} → ★完走(全店・全投稿を判定しました。この分布は取得窓の全体です)`;
  }
  const reasons = [];
  if (c.failed > 0) reasons.push(`取得に失敗した店 ${c.failed}店(その店は1投稿も見ていません)`);
  if (c.missingStores !== 0) reasons.push(`記録が無い店 ${c.missingStores}店`);
  if (c.judged !== c.targeted) reasons.push(`判定できていない投稿 ${c.targeted - c.judged}件`);
  return (
    `${head} → ★不完全(${reasons.join(' / ')})。` +
    'この実行の分布は【部分的】です。#13 の判断に使わないでください。'
  );
}

/**
 * 【矛盾の報告(#22)】確認済み投稿日時が未来になっている店を ::error:: で報告する。
 *
 * 【★ジョブは落とさない】#19 とまったく同じ理由 — 非ゼロ終了すると後続のコミット・pushが
 *   走らず、他店の取込みも状態の前進もリポジトリに残らない。赤い注記だけで人に見せる。
 *
 * 【★自動では戻さない】`lastPostedAt` を機械が消す/巻き戻すと、その店は取得窓を丸ごと
 *   読み直す。すると【人が admin.html で消した行が復活する】(リスク台帳 #15)。
 *   どちらが軽いかは中身を見ないと決められないので、機械は判断しない。
 *   直し方(と、直すと何が起きるか)をログに書いて人に渡す。
 */
function reportImpossibleState(summaries, statePath) {
  const hits = summaries.filter((s) => s.impossibleLastPostedAt);
  if (hits.length === 0) return;
  const name = path.basename(statePath);
  console.log('');
  console.log(
    `::error title=Instagram監視 - 確認済み投稿日時が未来になっています::` +
      `${hits.length}店の記録が【ありえない値】になっています。` +
      'この状態では取得できた投稿がすべて「既読」と判定されるため、' +
      '**その店の取込みは静かに止まったまま**になります(ログ上は「新着0件」= 平常日と区別が付きません)。' +
      'ジョブは止めません。機械は値を戻しません — 戻すと取得窓を読み直すので、' +
      '【人が消した行が復活する】可能性があるためです(リスク台帳 #15)。'
  );
  for (const s of hits) {
    console.log(
      `[monitor-instagram-apify] 未来の確認済み投稿日時: 店=${s.store.label}(${s.store.venueId})` +
        ` / 記録=${s.impossibleLastPostedAt.value} / ありえる上限=${s.impossibleLastPostedAt.boundary}` +
        ` / この店の新着として拾えた投稿=${s.newPostCount}件`
    );
  }
  console.log(
    `[monitor-instagram-apify] 直し方: ${name} の該当店の lastPostedAt を、実在する投稿の日時に直してください。` +
      'その店の記録ごと消せば取得窓を読み直しますが、【人が消した行が復活しうる】点に注意してください。'
  );
}

/**
 * 【静かな停止の測定(警報ではない)】店ごとに「最後に取込みが成立してから何日か」を毎回出す。
 *
 * 【なぜ警報にしないか】店が月に1度しかカレンダーを出さない以上、30日近い値は【平常】である。
 * 閾値を置けば毎月点灯し、この案件が繰り返し潰してきた「常時点灯する警報」になる。
 * そこで `EXPECTED_NO_START_PCT` と同じ扱いにする — **値を必ず出し、判断は人がする**。
 *
 * 【なぜ #22 の検知と別に要るか】#22 の検知は【原因を1つ名指しする】もので、
 * 未来日以外の理由(Apifyが常に空を返す / カレンダーが一度も一致しない / 店が投稿をやめた)では
 * 鳴らない。こちらは原因を問わず【結果】だけを測るので、まだ想像できていない停止も見える。
 * 逆にこちらは「何日か経たないと気づけない」ので、即座に分かる #22 の検知を置き換えはしない。
 */
function formatImportAges(summaries, today) {
  const parts = summaries.map((s) => {
    const days = daysBetween(today, s.lastImportedAt);
    return `${s.store.venueId}=${s.lastImportedAt ? `${days}日` : '未成立'}`;
  });
  return (
    `[monitor-instagram-apify] 取込みが成立してからの日数: ${parts.join(' / ')}` +
    ' 【警報ではなく測定】月1回しかカレンダーを出さない店では30日前後が平常です。' +
    '止まっているかどうかは、この値が【その店の投稿頻度に対して長すぎるか】で人が判断してください' +
    '(「未成立」= この記録を始めてから一度も取り込めていない)。'
  );
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
 * 「開始時刻が読めなかった行」の平常値(%)と、警告を出す許容幅。
 *
 * 【なぜ定数として持つか】この値は【画像に時刻が書かれていない】という確認済みの事実を表す
 * (2026-08-01 の⑤で人が画像を確認済み。v20=月間カレンダーに大会名のみ / v18=大会名と日付のみ)。
 * 「95%が異常」ではなく「95%が平常」なので、値そのもので警告を出すと
 * **毎回点灯して意味を失う警報**になる。値の【変化】だけを見る。
 *
 * 【店が時刻を書き始めたら下がる】その場合はこの定数を更新すること(警告文にも書いてある)。
 *
 * 【★この警告で捕まえられるのは【下振れ】だけ(2026-08-04・レビュー部の指摘で訂正)】
 * 現在の値で実際に発火するのは `pct < 70`(= 店が時刻を書き始めた方向)のみ。
 * 上振れ側の発火には `pct > 120` が要るが、割合の定義域は [0,100] なので**到達不能**。
 * これは閾値の付け方のミスではなく【指標の天井効果】で、平常95% + 上限100% =
 * **上方向の可動域が5ポイントしかない**。許容幅を5未満まで詰めれば形式上は発火するが、
 * 44行の実行では1行 = 約2.3ポイントなので、その閾値は**通常のゆらぎと区別できない**。
 * したがって【Visionが時刻を読めなくなったことは、この指標では検知できない】。
 * 「Visionの劣化は警告が拾う」という前提でcron解除を判断しないこと。
 * (指標を反転させて「時刻が【読めた】行」を数えれば可動域は95ポイントになり検知できるが、
 *  指標の入れ替えはロジック変更なので別PRで扱う。README「常時点灯する警報を作らない」参照)
 *
 * 【★EXPECTED_NO_START_PCT を大きく下げるときは、この前提も引き直すこと】
 * 上の「下振れ専用」は平常値が100%に近いことに依存している。平常値が下がれば
 * 上振れ側も発火しうるようになるので、警告文の文面も併せて見直す。
 */
const EXPECTED_NO_START_PCT = 95;
const NO_START_PCT_TOLERANCE = 25;

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
  if (total > 0) {
    // 【常時点灯する警報にしない】当初は「割合が高い=Visionが読めていない可能性」として
    // ::warning:: を出していたが、2026-08-01 の⑤で【画像に時刻が書かれていない】ことが
    // 人の目で確認された(v20は月間カレンダーに大会名のみ、v18は大会名と日付のみ)。
    // つまりこの割合は今後も毎回95%前後で点灯し続ける = 意味を失った警報になる。
    // この案件で繰り返し潰してきた形なので、【値そのもの】ではなく【値の変化】を見る。
    const pct = Math.round((noStart / total) * 100);
    console.log(
      `[monitor-instagram-apify] 開始時刻が読めなかった行: ${total}行中${noStart}行(${pct}%)。` +
        'サイトには「—」と表示されます(00:00 とは表示しません)。' +
        `【${EXPECTED_NO_START_PCT}%前後が平常】— 対象店の画像には時刻が書かれていないことを2026-08-01に確認済み。` +
        'この割合が大きく動いたときだけ、画像の形式かVision側の変化を疑ってください。' +
        '【自動の警告が出るのは下振れ側だけ】なので、上振れ(Visionが時刻を読めなくなった方向)は' +
        'この数字を人が見て気づくしかありません。'
    );
    if (Math.abs(pct - EXPECTED_NO_START_PCT) > NO_START_PCT_TOLERANCE) {
      console.log(
        `::warning title=Instagram監視 - 開始時刻が読めない行の割合が平常から外れた::` +
          `今回${pct}%(平常${EXPECTED_NO_START_PCT}%±${NO_START_PCT_TOLERANCE})。` +
          'この警告が検知しているのは【下振れ】= 店が時刻を書き始めた可能性(良い変化)だけです。' +
          `上振れ(Visionが時刻を読めなくなった方向)はこの警告の対象外 — 平常${EXPECTED_NO_START_PCT}%に対し` +
          `割合の上限は100%で、上方向の可動域が${100 - EXPECTED_NO_START_PCT}ポイントしか無いためです。` +
          '投稿画像を1枚確認してください。平常値が変わったなら ' +
          'tools/monitor-instagram-apify.js の EXPECTED_NO_START_PCT を更新すること。'
      );
    }
    // 【⚠ 要確認 が何行付いたかを必ず出す】この印は【参加費が大会名から推測された疑い】
    // だけを指す(2026-08-04に判定を作り直した。buyinMayComeFromName のコメント参照)。
    // 平常は0行なので、**0が続くのが正常**。
    // 【::warning:: にしない理由】該当行にはサイト側に⚠バッジが出て、下の明細にも印が付く。
    // 別チャネルを増やすより、⑤がこの数字と明細を見る方が確実で、
    // 0行の日に何も鳴らないのは「常時点灯しない」という設計どおり。
    const lowConf = withRows.reduce((a, s) => a + s.addedRows.filter((r) => r.entry.lowConfidence).length, 0);
    console.log(
      `[monitor-instagram-apify] ⚠ 要確認(参加費が大会名から推測された疑い)の行: ${total}行中${lowConf}行。` +
        '0行が平常です。付いた行は【参加費だけ】を画像と突き合わせてください' +
        '(値は消していないので、そのまま公開されます)。'
    );
  }
  if (total === 0) {
    console.log('  (data.js に増える行はありません)');
  }
  for (const s of withRows) {
    for (const { entry, permalink } of s.addedRows) {
      // 【data.js に書かれるとおりの値を出す】読み取れなかった項目は `不明`。
      // 0 は「無料」という読み取れた値なので `不明` と区別する。
      const num = (v) => (v == null ? '不明' : String(v));
      const reentry = entry.reentry === 'late' ? 'レイトのみ' : entry.reentry ? 'あり' : 'なし';
      const tags = entry.tags && entry.tags.length ? entry.tags.join('・') : 'なし';
      // ⚠ が付いた行はこの明細でも分かるようにする(⑤が「どの行の参加費を見ればいいか」を
      // 一覧から拾えるようにするため。サイトのバッジと同じ意味)。
      const lowConf = entry.lowConfidence ? ' / ★⚠要確認(参加費が大会名から推測された疑い)' : '';
      console.log(
        `[monitor-instagram-apify] 追加行: ${entry.venueId} / ${entry.date} / ${entry.start || '開始時刻不明'} / ${entry.name}` +
          ` / 参加費${num(entry.buyin)} / アドオン${num(entry.addon)} / スタック${num(entry.stack)}` +
          ` / GTD${num(entry.guarantee)} / 再入場${reentry} / 賞品${entry.prize == null ? '不明' : entry.prize}` +
          ` / タグ${tags} / ${permalink || '出所不明'}${lowConf}`
      );
    }
  }

  // 【人の行を守って書かなかった行】の明細。
  //
  // 【::error:: / ::warning:: にはしない】人が入力した行がある限り毎回同じ件数が出る性質の
  // ものなので、警告チャネルに載せると常時点灯になり、本物の異常が読めなくなる。
  // 事実として明細に出し、⑤が見る。
  //
  // 【人の値と読み取った値を必ず並べて出す】⑤にとってはここがいちばん情報量が多い —
  // 両者がずれているなら、そのずれ自体が「店が日程を変えた」「人の入力が古い」の合図になる。
  // 【キャプションは1文字も出さない】出すのは data.js に載る値と permalink だけ。
  const protectedAll = summaries.flatMap((s) => s.protectedRows || []);
  if (protectedAll.length) {
    console.log('');
    console.log(`[monitor-instagram-apify] === 人の行を守り、読み取った行を書きませんでした(計${protectedAll.length}行) ===`);
    console.log('  同じ日時に人が入力した行があるため、そちらを正として残しています(⚠ 要確認 の印もそのまま)。');
    for (const { incoming, existing, permalink } of protectedAll) {
      const num = (v) => (v == null ? '不明' : String(v));
      console.log(
        `[monitor-instagram-apify] 見送り: ${incoming.venueId} / ${incoming.date} / ` +
          `${incoming.start || '開始時刻不明'} / 読み取った値: ${incoming.name}` +
          ` / 参加費${num(incoming.buyin)} / スタック${num(incoming.stack)} / ${permalink || '出所不明'}`
      );
      for (const e of existing) {
        console.log(
          `    残した人の行: ${e.name} / 参加費${num(e.buyin)} / スタック${num(e.stack)}` +
            ` / GTD${num(e.guarantee)} (${e.id}, source=${e.source})`
        );
      }
    }
    console.log('  ※ 読み取った側を採用したい行は、admin.html でその人の行を消してください(削除 = 機械への引き渡し)。');
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
        // 【「追加0」の理由に「人の行を守った」を足す】これが無いと、⑤は追加0を
        // 日付レンジでしか説明できず、「守ったから0」と「別の経路で消えた」を区別できない。
        ` / 日付レンジ ${range} / 追加${p.addedCount} / 人の行を守って見送り${p.protectedCount} / ${p.outcome}`
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
 * 取得に失敗した店を ::error:: で報告する。
 *
 * 【ジョブは非ゼロ終了させる】これまでの「ジョブは緑のまま通す」判断は
 * 「取り込めた他店のデータと状態の前進をリポジトリに残すため」だった。
 * 取得失敗はそれとは性質が違い、**その店は今日1日ぶん丸ごと観測できていない**。
 * 成功した店のデータは書き込んだうえで、Actions は赤くして人に見せる。
 */
function reportStoreFailures(storeFailures, summaries, storeCount) {
  const acc = checkStoreAccounting(summaries, storeCount);
  if (!acc.ok) {
    console.log(
      `::error title=Instagram監視 - 店の集計が合わない::対象${acc.expected}店に対し` +
        `観測${acc.observed}店+失敗${acc.failed}店で合いません(バグ)。`
    );
  }
  if (!storeFailures || storeFailures.length === 0) return;
  console.log('');
  console.log(
    `::error title=Instagram監視 - 取得に失敗した店::${storeFailures.length}店の投稿を取得できませんでした` +
      `(対象${acc.expected}店中)。**この店は今日1日ぶん丸ごと観測できていません**。` +
      '確認済み投稿日時は前進させていないので、次回の実行でやり直せます。' +
      '他店の取り込みは完了しています。'
  );
  for (const f of storeFailures) {
    const sec = f.elapsedMs != null ? `${Math.round(f.elapsedMs / 1000)}秒` : '不明';
    console.log(
      `[monitor-instagram-apify] 取得失敗: 店=${f.store.label}(${f.store.venueId}) / @${f.store.handle}` +
        ` / 所要=${sec} / 理由=${f.error}`
    );
  }
}

/**
 * 全店の合計を1ブロックで出す。
 *
 * 【dry-run でもカウンタを観測できるようにするため必要】dry-run は状態ファイルを書かないので、
 * lastExtraction に入れた永続カウンタはディスクに残らない。dry-run の判断材料は
 * このログだけなので、店ごとの内訳とは別に合計をここで出す。
 */
function reportTotals(summaries, storeCount) {
  const sum = (f) => summaries.reduce((a, s) => a + f(s), 0);
  const lost = sum((s) => s.imageFailedCount + s.visionFailedCount + s.unusablePostCount);
  const intakeResidual = sum((s) => checkIntakeAccounting(s).missing);
  const postResidual = sum((s) => checkPostAccounting(s).missing);
  console.log('');
  console.log('[monitor-instagram-apify] === 全店合計 ===');
  const stores = checkStoreAccounting(summaries, storeCount);
  const elapsed = summaries.filter((s) => s.fetchElapsedMs != null).map((s) => s.fetchElapsedMs);
  console.log(
    `  対象 ${stores.expected}店 = 観測できた ${stores.observed}店 + 【取得失敗 ${stores.failed}店】` +
      (elapsed.length
        ? ` / Apify取得の所要: 最短${Math.round(Math.min(...elapsed) / 1000)}秒 ` +
          `最長${Math.round(Math.max(...elapsed) / 1000)}秒(タイムアウトの調整はこの実測に基づいて行う)`
        : '')
  );
  console.log(
    `  Apify取得 ${sum((s) => s.apifyRawCount)}件 → 新着 ${sum((s) => s.newPostCount)}件 ` +
      `(形式不正 ${sum((s) => s.malformedCount)} / 投稿日時が読めない ${sum((s) => s.invalidPostedAtCount)} / ` +
      `既読 ${sum((s) => s.alreadySeenCount)})` +
      `${intakeResidual === 0 ? '' : ` ← 残余 ${intakeResidual}件`}`
  );
  console.log(
    `  新着投稿 ${sum((s) => s.newPostCount)}件 → 判定対象 ${sum((s) => s.scheduleLikeCount)}件` +
      (sum((s) => s.filteredOutCount) > 0 ? ` / 画像を見ずに対象外 ${sum((s) => s.filteredOutCount)}件` : '')
  );
  // 【当月カレンダーを見つけられた店の数】これがこの監視の目的そのものなので合計にも出す。
  // 「取り込めた0件」だけだと、新着が無かったのかカレンダーが無かったのかが区別できない。
  const observed = summaries.filter((s) => !s.fetchFailed);
  // 【新着0件の店を「なし」に混ぜない】混ぜると「6店中5店でカレンダーが見つからない」に見えるが、
  // 実際は3店が新着なしで1枚も判定していない、ということが起こる(較正の判断を誤る)。
  const judged = observed.filter((s) => s.newPostCount > 0);
  console.log(
    `  当月カレンダー: あり ${judged.filter((s) => s.currentMonthCalendar).length}店 / ` +
      `なし ${judged.filter((s) => !s.currentMonthCalendar).length}店 / ` +
      `新着なしで未判定 ${observed.length - judged.length}店(観測できた ${observed.length}店中)`
  );
  // 【M-5】行側だけでなく投稿側にも残余マーカーを出す(片方だけ出ていると、
  // 「投稿側は常に合っている」と誤読される)。
  console.log(
    `  投稿の行き先: 取り込めた ${sum((s) => s.importedPostCount)}件 / ` +
      // 探索モードでだけ動く項。本番では常に0なので、0のときは出さない。
      (sum((s) => s.probeCalendarPostCount) > 0
        ? `当月以降のカレンダー(探索・採用せず) ${sum((s) => s.probeCalendarPostCount)}件 / `
        : '') +
      `カレンダーでない ${sum((s) => s.notCalendarPostCount)}件 / ` +
      `過去月のカレンダー ${sum((s) => s.pastCalendarPostCount)}件 / ` +
      `判定済み ${sum((s) => s.cacheHitCount)}件 / 未確認 ${sum((s) => s.unexaminedPostCount)}件 / ` +
      `再投稿 ${sum((s) => s.repostedPostCount)}件 / ` +
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
      `過去日 ${rsum((r) => r.pastDated)} + 破棄 ${rsum((r) => r.dropped)} + ` +
      `不採用の投稿の行 ${rsum((r) => r.notAdopted)}` +
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
function reportLostPosts(lostPosts, opts) {
  if (!lostPosts || lostPosts.length === 0) return;
  const probe = Boolean(opts && opts.probe);
  const byKind = (k) => lostPosts.filter((p) => p.kind === k).length;
  console.log('');
  console.log(
    `::error title=Instagram監視 - 内容が失われた投稿::` +
      `${lostPosts.length}件の投稿を処理できませんでした` +
      `(画像ダウンロード失敗 ${byKind('image-failed')}件 / Vision抽出失敗 ${byKind('vision-failed')}件)。` +
      // 【探索モードでは「失われた」も「再試行されない」も事実に反する】確認済み投稿日時を
      // 前進させないので、次の実行で同じ投稿をもう一度処理できる。文面を分ける。
      (probe
        ? '探索モードなので確認済み投稿日時は前進しておらず、次の実行でやり直せます。' +
          'ただし【この探索の測定からは抜けています】(形が確定していない投稿として数えます)。'
        : 'これらの投稿の内容はサイトに一切入らず、確認済み投稿日時が進むため【再試行されません】。' +
          'ジョブは継続しています(取り込めた他の投稿は反映済み)。人の確認が必要です。')
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
 * 【赤(::error::)にしない理由】キーワード判定を廃止して【新着の全投稿を画像で判定する】
 * ようになった(2026-08-04)ので、日程と無関係な投稿(店内の写真・お礼など)も必ず1回は
 * Vision に渡る。それらは正常に0件で返る = 0件は日常的に発生する。
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

/**
 * 探索モードで書き込み関数が呼ばれたら、書かずに落とす【構造的な安全弁】。
 *
 * 【なぜ「dry-run と同じ経路で return するから大丈夫」で済ませないか】
 *   その保証は「return が書き込みより前にある」という【並び】だけに依存していて、
 *   1行の移動で静かに消える。書き込みの手段そのものを取り上げておけば、
 *   仮に到達しても【書かずに落ちる】= 事故が事故として見える。
 */
function forbidWrite(what) {
  return () => {
    throw new Error(
      `探索モード(--probe)では ${what} を書き換えません。この関数に到達したこと自体が退行です。`
    );
  };
}

async function main() {
  // 【★引数の検査は何よりも先に★】知らない引数を無視すると、`--dry-run` の打ち間違いが
  // そのまま【本番実行】になる(この経路の本番は不可逆)。1バイトも書かずにここで止める。
  if (UNKNOWN_ARGS.length > 0) {
    fail(
      `知らない引数です: ${UNKNOWN_ARGS.map((a) => JSON.stringify(a)).join(', ')}。` +
        `使えるのは ${KNOWN_FLAGS.join(' / ')} だけです。` +
        '(打ち間違いをそのまま本番実行にしないため、ここで止めています)'
    );
    return;
  }

  const today = todayJst();
  const modeLabel = PROBE
    ? ' / PROBE(探索専用: 打ち切らずに全投稿を判定・採用なし・書き込みなし)'
    : DRY_RUN
      ? ' / DRY-RUN'
      : '';
  console.log(`[monitor-instagram-apify] 基準日(JST): ${today}${modeLabel}`);

  if (!process.env.APIFY_API_TOKEN) {
    fail('APIFY_API_TOKEN が未設定です。Apify呼び出しをスキップし、data.js / 状態ファイルは書き換えません。');
  }

  const fetchLib = require('./fetch-venue-posts-apify');
  const visionLib = require('./venue-schedule-vision');
  const mergeLib = require('./tournament-merge');
  const guardLib = require('./schedule-write-guard');

  // 【探索モードでは書き込みの手段そのものを取り上げる】(forbidWrite のコメント参照)
  const writeDataJs = PROBE ? forbidWrite('data.js') : mergeLib.writeDataJs;
  const persistMonitorState = PROBE ? forbidWrite(path.basename(STATE_PATH)) : saveState;
  const persistWriteState = PROBE ? forbidWrite(path.basename(WRITE_STATE_PATH)) : machineState.writeState;

  const file = mergeLib.readDataJs(DATA_JS);
  const before = file.arr;
  // 最終自己チェックの左辺。before は arr と要素オブジェクトを共有するので、ここで一度だけ
  // 深く写しておく(理由は下の checkNothingElseChanged 呼び出し箇所のコメント)。
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  // 【確認済み投稿日時の記録が読めなくても止めない】理由と代償は loadState のヘッダ参照。
  const loaded = loadState(STATE_PATH);
  const state = loaded.state;
  if (loaded.broken) reportBrokenState(STATE_PATH, loaded.reason, { dryRun: DRY_RUN });

  // 機械が最後に書いた値の控え。読めない/壊れているときは【空として続行する】—
  // ここで落とすと状態ファイル1つでこの経路が永久に止まる。空でも人の行は守られる側に倒れる。
  const writeState = machineState.readState(WRITE_STATE_PATH);
  if (writeState.broken) {
    console.warn(
      `[monitor-instagram-apify] ⚠ ${path.basename(WRITE_STATE_PATH)} を読めませんでした(壊れている?)。` +
        '控えなしで続行します。人の行は守られますが、【この経路が前回書いた行は更新できません】(新しい枠に足すだけになります)。'
    );
  } else if (!writeState.missing) {
    console.log(`[monitor-instagram-apify] 機械が書いた値の控え: ${Object.keys(writeState.entries).length}件`);
  }

  let result;
  try {
    result = await runMonitor(
      { stores: STORES, before, today, state, writeRecords: writeState.entries, probe: PROBE },
      { fetchLib, visionLib, mergeLib, downloadImage }
    );
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
    return;
  }

  const {
    arr,
    state: nextState,
    written,
    changed,
    summaries,
    anomalies,
    lostPosts,
    emptyResults,
    storeFailures,
    storeCount,
  } = result;

  for (const s of summaries) {
    console.log('');
    console.log(`[${s.store.label} / ${s.store.venueId} / @${s.store.handle}]`);
    if (s.fetchFailed) {
      // 【「新着0件」と見分けが付く形にする】0が並ぶだけだと正常運転に見える。
      console.log(`  ★取得失敗のためスキップしました: ${s.fetchError}`);
      console.log('  確認済み投稿日時は前進していません(次回もう一度取得できます)。');
      continue;
    }
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
    // 【キーワード判定を廃止したので「対象 = 新着」になる(2026-08-04)】
    // 毎回「キーワード不一致で対象外 0件」と出すと、まだキーワードで絞っているように読める。
    // filteredOut は取込みレベルの保存則の【形】を保つために残しているだけなので、
    // 0でないときだけ出す(将来また前段の絞り込みが増えたら、そのときだけ表に出る)。
    console.log(
      `  新着投稿 ${s.newPostCount}件 → 判定対象 ${s.scheduleLikeCount}件` +
        (s.filteredOutCount > 0 ? ` / 画像を見ずに対象外 ${s.filteredOutCount}件` : '')
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
    // 【判断3】当月カレンダーの有無を必ず出す。0件を静かに返さない。
    // 「新着が無かった0件」と「カレンダーを見つけられなかった0件」は意味が違う。
    // 月初に店がまだ出していないのは正常なので【赤にはしない】が、要約には必ず出す。
    if (s.currentMonthCalendar) {
      console.log(
        `  当月カレンダー: あり (${s.currentMonthCalendar.month} / ${s.currentMonthCalendar.permalink})` +
          // 【探索では「あり」と「採用した」を同じ文にしない】見つけたのは事実だが採用はしていない。
          (PROBE ? ' ※探索モードなので採用していません(本番ならここで打ち切っていた投稿)' : '')
      );
    } else if (s.newPostCount === 0) {
      // 【「新着が無かった」と「カレンダーが見つからなかった」を同じ文言にしない】
      // 新着0件の店は今回1枚も判定していない。「なし」と書くと
      // 「投稿はあるのにカレンダーが無い店」と区別が付かず、較正の判断を誤る。
      console.log('  当月カレンダー: 今回は判定していません(新着なし)');
    } else if (s.latestPastCalendar) {
      console.log(
        `  当月カレンダー: なし (最新のカレンダーは ${s.latestPastCalendar.month} / ${s.latestPastCalendar.permalink})`
      );
    } else {
      console.log('  当月カレンダー: なし (取得できた投稿の中にカレンダーが見つかりませんでした)');
    }
    console.log(
      `  走査: Vision実行 ${s.examinedPostCount}件 / 判定済みで再実行せず ${s.cacheHitCount}件 / ` +
        `カレンダーでない ${s.notCalendarPostCount}件 / 過去月のカレンダー ${s.pastCalendarPostCount}件 / ` +
        `未確認(採用後に打ち切り) ${s.unexaminedPostCount}件` +
        // 探索でしか動かない項なので、0のときは出さない(本番のログに常時0を並べない)。
        (s.probeCalendarPostCount > 0 ? ` / 当月以降のカレンダー(探索・採用せず) ${s.probeCalendarPostCount}件` : '')
    );
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
        `変更なし ${row.unchanged} + 過去日 ${row.pastDated} + 破棄 ${row.dropped} + ` +
        `不採用の投稿の行 ${row.notAdopted} + 人の行を守って見送り ${row.protected}` +
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
          `人の行を守って見送り ${s.stats.protected}件 / ` +
          `人が直した項目を残した ${s.stats.fieldsProtected}項目 / ` +
          `投稿未掲載の手入力 ${s.stats.keptManual.length}件`
      );
    }
  }

  // 【静かな停止】原因を名指しする検知(#22)と、原因を問わない測定(日数)を両方出す。
  // 片方だけでは、それぞれ「未来日以外の停止が見えない」「気づくのが遅れる」という穴が残る。
  reportImpossibleState(summaries, STATE_PATH);
  console.log('');
  console.log(formatImportAges(summaries, today));

  reportStoreFailures(storeFailures, summaries, storeCount);
  reportAcceptedRows(summaries);
  reportTotals(summaries, storeCount);
  reportLostPosts(lostPosts, { probe: PROBE });
  reportEmptyResults(emptyResults);
  reportAnomalies(anomalies);
  if (PROBE) reportProbe(summaries, storeCount);

  // 対象外店舗・過去日が変化していないことの最終自己チェック(店舗ごとのassertOnlyTargetChangedに加えた二重チェック)。
  // 【★左辺はマージ前のディープコピー★】before と arr は past の要素オブジェクトを共有しているので、
  //   before をそのまま渡すと「エントリを in-place で書き換えるバグ」が両辺に同じように映って素通りする
  //   (Waitinglist取込みが先に同じ手当てをしている。理由はそちらの beforeSnapshot のコメントに詳しい)。
  // 【★過去日は順序を見ない★】理由と、その代わりに何を厳密に見ているかは
  //   tools/schedule-write-guard.js のヘッダに書いてある。ここを読む前にあちらを読むこと。
  const verdict = guardLib.checkNothingElseChanged(beforeSnapshot, arr, {
    targets: new Set(STORES.map((s) => s.venueId)),
    today,
  });
  // 並びが変わった行数は【0でも必ず出す】。変化したときだけ出す形にすると、
  // 出力そのものが壊れたときに静かに何も出なくなる(鳴らない警報)。
  for (const line of guardLib.formatReorderReport(verdict, '[monitor-instagram-apify]')) {
    console.log(line);
  }
  if (!verdict.ok) {
    fail(verdict.message);
    return;
  }

  console.log('');
  // 【終了コードの使い分け】
  //   0 … 全店を観測できた(正常)
  //   1 … 何も書いていない(知らない引数・トークン未設定・自己チェック失敗。fail() が使う)
  //        ★確認済み投稿日時の記録が壊れていても【1にはしない】(記録なしとして続行し、
  //          この実行の最後に書き直す)。理由は reportBrokenState のコメント。
  //   2 … 一部の店の取得に失敗した。【成功した店ぶんは書き込み済み】で、失敗店の
  //        確認済み投稿日時は前進していないので次回やり直せる。Actions は赤くする
  // 2 を 1 と区別するのは、「何も書いていない」と「一部だけ書いた」では
  // 人がとるべき次の行動が違うため(前者は再実行、後者は失敗店だけの確認)。
  const PARTIAL_FAILURE = 2;
  const partial = storeFailures.length > 0;

  // 次の控え。今回この経路が触った店の記録は入れ替え、触っていない店の記録は残す。
  // 過去日と data.js から消えた行は刈る(控える意味が無く、放っておくと際限なく膨らむ)。
  // ★控えるのは【人の値を戻す前】の機械の候補行(runMonitor が written で返す)。
  //   戻した後を控えると、翌日は控えといまの値が一致して食い違いが消え、人の修正が上書きされる。
  const nextWriteEntries = machineState.buildNextEntries(writeState.entries, written, {
    today,
    replacedVenueIds: summaries.filter((s) => s.stats).map((s) => s.store.venueId),
    liveIds: new Set(arr.map((t) => t.id)),
  });

  if (DRY_RUN) {
    console.log(
      PROBE
        ? '[monitor-instagram-apify] --probe のため data.js / 状態ファイルは書き換えません(確認済み投稿日時も前進していません)。'
        : '[monitor-instagram-apify] --dry-run のため data.js / 状態ファイルは書き換えません。'
    );
    // 【dry-run でも終了コードは同じにする】そうしないと dry-run が緑のまま通り、
    // 本番で初めて赤くなる。dry-run は本番の予行なので挙動を揃える。
    if (partial) process.exitCode = PARTIAL_FAILURE;
    return;
  }

  if (!changed) {
    console.log('[monitor-instagram-apify] スケジュール告知の新着は無かったため data.js は書き換えません。');
    // 【★壊れていた記録は、新着が無い日でも必ず書き直す★】差分だけを見て保存すると、
    // 全店で新着0件の日は nextState が(空の)state と一致し、【壊れたファイルが残り続ける】。
    // それでは「続行して自分で直る」という loadState の前提が成り立たない。
    if (loaded.broken || JSON.stringify(nextState) !== JSON.stringify(state)) {
      persistMonitorState(STATE_PATH, nextState);
      console.log(
        loaded.broken
          ? `[monitor-instagram-apify] 読めなかった ${path.basename(STATE_PATH)} を書き直しました(記録${Object.keys(nextState).length}店ぶん)。`
          : '[monitor-instagram-apify] 確認済みの投稿日時のみ apify-monitor-state.json に記録しました。'
      );
    }
    // 控えは data.js の差分と無関係に整合させる(過去日の刈り込みだけの日もある)。
    if (persistWriteState(WRITE_STATE_PATH, nextWriteEntries, { writtenBy: 'tools/monitor-instagram-apify.js' })) {
      console.log(`[monitor-instagram-apify] ${path.basename(WRITE_STATE_PATH)} を更新しました。`);
    }
    if (partial) process.exitCode = PARTIAL_FAILURE;
    return;
  }

  writeDataJs(DATA_JS, file, arr);
  persistMonitorState(STATE_PATH, nextState);
  persistWriteState(WRITE_STATE_PATH, nextWriteEntries, { writtenBy: 'tools/monitor-instagram-apify.js' });
  console.log(
    `[monitor-instagram-apify] data.js / apify-monitor-state.json / ${path.basename(WRITE_STATE_PATH)} を更新しました。`
  );
  console.log('[monitor-instagram-apify] 忘れずに `node tools/gen-venue-pages.js .` を実行し、店舗静的ページを再生成してください。');
  // 【書き込みの後に立てる】ここより前で throw すると成功店のデータが失われるため、
  // 「書き込みは完了した / ただし一部の店は観測できていない」の順で伝える。
  if (partial) {
    console.log(
      `[monitor-instagram-apify] ${storeFailures.length}店の取得に失敗したため、終了コード ${PARTIAL_FAILURE} で終わります` +
        '(書き込みは完了しています)。'
    );
    process.exitCode = PARTIAL_FAILURE;
  }
}

if (require.main === module) {
  main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
}

module.exports = {
  STORES,
  pickNewPosts,
  slugify,
  toTournament,
  formatDroppedRow,
  formatNormalizedRow,
  canonicalTag,
  canonicalTags,
  droppedTags,
  nameContainsMoneyToken,
  // 【`hasTournamentEvidence` / `tournamentEvidence` は削除した(2026-08-04)】
  // 「トーナメントである証拠」という概念はもう何も判定していない(行を落とすのは語の判定、
  // ⚠を付けるのは buyinMayComeFromName)。名前だけ残すと、廃止した規則が
  // 再び使われる入口になるので export ごと消してある。
  buyinMayComeFromName,
  isClosureRow,
  isHeadingRow,
  normalizeName,
  isNonTournamentFormat,
  calendarShape,
  formatCalendarVerdict,
  MIN_CALENDAR_DATES,
  MIN_CALENDAR_SPAN_DAYS,
  emptyCaveat,
  pickNewPostsWithStats,
  checkIntakeAccounting,
  checkStoreAccounting,
  EXPECTED_NO_START_PCT,
  NO_START_PCT_TOLERANCE,
  reportAnomalies,
  reportLostPosts,
  reportEmptyResults,
  reportTotals,
  reportAcceptedRows,
  checkPostAccounting,
  checkRowAccounting,
  probeMetrics,
  checkProbeAccounting,
  shapeComparison,
  shapeSignature,
  formatProbeShapeComparison,
  reportProbe,
  probeCompletion,
  formatProbeCompletion,
  impossibleLastPostedAt,
  reportImpossibleState,
  formatImportAges,
  daysBetween,
  forbidWrite,
  runMonitor,
  loadState,
  reportBrokenState,
  saveState,
  todayJst,
};
