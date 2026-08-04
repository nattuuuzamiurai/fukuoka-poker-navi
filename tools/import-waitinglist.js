#!/usr/bin/env node
/**
 * import-waitinglist.js
 *
 * Waitinglist(DMMポーカーのイベントカレンダーの裏側)の公開APIから、
 * 対象店舗のトーナメント日程を取得して `data.js` の TOURNAMENTS に upsert する。
 *
 * 認証不要の公開JSON APIで、そのまま叩くだけで取れる:
 *   GET https://api.waitinglist-poker.com/v1/game-schedules/tournament?storeId=<displayId>&limit=100&page=1
 *   → { totalRecords: number, tournaments: [...] }
 *
 * リクエストは USER_AGENT で当サイトのボットとして名乗る(ブラウザを詐称しない)。
 * ページ間は1秒あけ、1日1回だけ実行する。
 *
 * 使い方:
 *   node tools/import-waitinglist.js               … data.js を書き換える
 *   node tools/import-waitinglist.js --dry-run     … 書き込まず、差分サマリだけ出す
 *   node tools/import-waitinglist.js --allow-shrink… 件数の急減ガードを外して実行する
 *                                                    (閉店・長期休業など正当な大幅減のとき人が明示的に通す)
 *
 * 対象店舗を増やすときは下の STORES に1行足すだけでよい。
 *
 * 【人が直した値は上書きしない(2026-08-04)】
 *   auto エントリは毎朝作り直すので、以前は【人が直した内容が翌朝の実行で機械の値に戻っていた】。
 *   いまは機械が書いた値そのものを waitinglist-write-state.json に控え、いまの data.js と
 *   1項目ずつ突き合わせる。食い違う項目は人が直したものとして【その項目だけ】残す
 *   (行ごと凍結しない — 大会名を1つ直したせいで開始時刻の更新が止まるのは、
 *    「プレイヤーが違う時間に店へ行く」という最も重い実害を招くため)。
 *   控えが無い行は【人のもの】として一切触らない。同じ(date,start)に API の行が来ても書かない。
 *   詳しい規則・状態ファイルが壊れたときの縮退は tools/machine-write-state.js のヘッダを見ること。
 *
 * 【副産物】リポジトリ直下に auto-import-stores.json を書き出す。
 *   掲載管理コンソール(別リポジトリ fukuoka-poker-admin・ローカル専用)が読んで
 *   「この店は自動取得なので手入力不要」を出すための機械可読リスト。
 *   中身は STORES から作るだけで、APIの応答にも実行時刻にも依存しない
 *   (タイムスタンプを入れると日次実行のたびに差分が出てコミットが増える)。
 *
 * 【安全弁】外部APIの一時障害でサイトのデータが消えるのを防ぐため、次のいずれかが起きたら
 * その店舗のデータを一切書き換えない。「HTTP 200だが中身が壊れている」部分障害も止める:
 *   1. fetch失敗 / HTTP 200以外 / レスポンス形状が想定外
 *   2. ある店舗の取得件数が0件
 *   3. ページング不整合(totalRecords に対して「重複排除後の」実取得件数が足りない = 途中で切れている)
 *   4. store.displayId が無い / 要求した storeId と違う(別店舗のデータ混入)
 *   5. 今日以降の件数の急減(前回の半分未満、または一度に MAX_ABS_DROP 件以上の減少。--allow-shrink で解除)
 *   6. 書き込み直前の自己チェック(取得に成功した店以外・過去日エントリが変化していないか)
 *
 * 【失敗の隔離は店舗単位】1〜5 はその店の中で完結する異常なので、失敗した店だけをスキップし、
 * 他店は通常どおり取り込む。6 だけは自分のバグを疑う検査なので全体を止める。
 *
 *   ★ もともとは「全店そろって成功しなければ1文字も書かない」という設計だった。狙いは
 *     【中途半端な書き込みを残さないこと】で、それ自体は今も正しい。ただし店ごとのデータは
 *     互いに独立していて、A店の取込が失敗してもB店の結果は完全に整合しているため、
 *     「B店を書かない」ことが安全性に寄与していなかった。むしろ弊害のほうが大きく、
 *     たとえば毎月1日にAPIが翌月ぶんを返さない店が1つあるだけで
 *     【正常な他店の取込まで丸ごと止まる】(=社長の手入力を消している v3 の自動化が、
 *     他店のAPI登録状況に人質に取られる)。そこで隔離の単位を「全店」から「1店」に変えた。
 *     店をまたいで中途半端になることは無い(店ごとに全件そろってから mergeStore に渡す)。
 *
 * 【終了コード】
 *   0 … 全店成功
 *   2 … 一部の店だけ失敗。【成功した店のぶんは書き込み済み】。ワークフローは
 *       コミット・pushまで進めたうえで、最後にジョブを失敗させて Actions を赤くする
 *   1 … 何も書いていない(全店失敗 / data.js を読めない / 自己チェックでバグを検出)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 「機械が最後に書いた値」の控えと、そこから導く所有の判定。
// ★このモジュールは tools/tournament-merge.js(Instagram監視・画像取込み)とも共有している。
//   規則を2箇所に書くと必ず片方が古くなるので、判定の所有者はあちら1つに寄せてある。
const state = require('./machine-write-state');

// 書き込み直前の最終自己チェック。
// ★このモジュールも tools/monitor-instagram-apify.js と共有している。
//   同じ検査を2箇所に書くと必ず片方が古くなる(実際 2026-08-05 まで、まったく同じ欠陥が
//   この2つのツールに同居していた)。検査の所有者はあちら1つに寄せてある。
const guard = require('./schedule-write-guard');

// ============================================================
// 店舗設定 — 1行足せば対象店舗を増やせる
//   venueId : data.js の VENUES における店舗ID
//   displayId: Waitinglist の storeId
//
// 【有効化するとき必ず見ること 1/2 — RECURRING との重なり】
//   その店に data.js の RECURRING(毎週固定の定期開催)がある場合、APIが同じ枠を返すと
//   同じ大会が2行に見える。これは recurring-dedupe.js が
//   【(venueId, date, 開始時刻)が完全一致する RECURRING の展開行を出さない】ことで解消済み
//   (残すのは自動取込のほう。店自身の予約システムが正)。
//   ★ 抑止の条件は【開始時刻まで完全一致】。APIとRECURRINGで開始時刻が1分でもズレていると
//     抑止されず2行のまま出る。有効化したら生成後の店舗ページを実際に見て確認すること。
//     v19 の実測: 8月は 28行 → 23行 になり、重なっていた5枠がすべて1行になった。
//   ★ RECURRING を消して解決してはいけない。APIが返すのは【当月1日〜約25日先】だけなので、
//     消すとその外側の日程が丸ごと欠ける。v19 で実測すると 8月の28行が9行まで落ち、
//     APIが1件も返していない土曜 Deep Stack 5回・月曜 Free Roll 5回が全滅する。
//     抑止されるのは一致した行だけなので、APIに登録が無い日のRECURRINGはちゃんと残る
//     (v19 実測: 8/13・8/20・8/27 の木 Freeze Out と 8/30 の日 Turbo は残る)。
//
// 【有効化するとき必ず見ること 2/2 — 月初に0件でスキップされうる】
//   APIは【当月1日以降のレコードしか返さない】(2026-07-31に v3/v19/v22/v27/v33 の5店を
//   確認したところ、いずれも6月以前が0件)。したがって月が変わった朝、その店が翌月ぶんを
//   まだ登録していないと totalRecords=0 になり、下の【0件ガード】に掛かる。
//   ★ このとき止まるのは【その店だけ】。他店は通常どおり取り込まれ、その内容は push される
//     (上記【失敗の隔離は店舗単位】)。たとえば v19 が0件の朝でも v3 は正常に更新される。
//     ジョブは rc=2 で赤くなるが、赤い = 全部止まった ではないので、
//     当番は ::error:: 注記が挙げている店だけを見ればよい。
//     ※ 2026-07-31以前は全店が巻き添えで止まっていた。古い障害メモにその前提が残っていたら疑うこと。
//   ★ 【急減ガードは無関係】。prevFuture(data.js)と nextFuture(API)は同じ today で
//     数えるため、開催日が過ぎるだけなら両方が同時に減って drop=0 にしかならない
//     (v19 の登録内容で 8/1〜8/31 の全日を通しても1度も発火しない)。急減ガードが実際に鳴るのは
//     「店が未来の大会を取り消した」ケースだけ。月初に赤くなったら急減ではなく0件を疑うこと。
//   参考(v19の登録の癖): ULIDの時刻を復号すると 7/9 に木Freeze Out×5(7/9〜8/6)、
//     7/15 に日Turbo×5(7/26〜8/23)、7/27 に火FST Satellite×5(7/28〜8/25)。
//     【同一シリーズ5回ぶんを約5週おきにまとめ登録】する運用で、常時25日前後の残量しか持たない。
//     v27(THE DOJO)は2026-07-31時点で既に未来分が0件(最新7/30)で、この状態が現に起きている。
// ============================================================
const STORES = [
  { venueId: 'v3', displayId: '4018492', label: "m HOLD'EM 中洲" },
  // 住所・Instagramアカウント・緯度経度(国土地理院で逆引きした実測距離12m)の3点で
  // data.js の v19 と同一店であることを確認済み。他店の住所とは最低54km離れており取り違えは起きない。
  { venueId: 'v19', displayId: '4039056', label: 'CASINO Arrows 小倉店' },
  //
  // 将来の候補(APIに掲載があることは確認済み)。有効化は「data.jsの店名 = APIの店名」を
  // 目視で確かめてから行うこと。venueIdを取り違えるとよその店の日程を掲載してしまう。
  // 有効化は【1店ずつ】行う。まとめて足すと、差分が出たときにどの店の取込が原因か切り分けられない。
  //
  // ★有効化した初回だけ data.js の差分が大きくなることがある(2026-08-05)。
  //   その店の行が data.js 内で2ブロックに分かれていると、mergeStore が1か所にまとめるため
  //   【中身は1件も変わらないのに数百行が移動する】。実測: v27 で952行 / v22 で832行。
  //   店ごとに一度きりで、2回目以降は0行。動いた行数は実行ログに必ず出る
  //   (「過去日の並び: N行の位置が変わりました」)。理由は tools/schedule-write-guard.js を参照。
  //   ⚠ 2026-08-05 より前のコードでは、これが「過去日が変化しています(バグ)」と判定されて
  //      【毎朝 exit 1 で永久に止まる】状態だった(v27 で再現。v22 では起きない)。
  //
  //   [店名が一致・そのまま有効化してよい]
  //   { venueId: 'v22', displayId: '4012445', label: 'CRownCLown' },
  //   { venueId: 'v27', displayId: '4069478', label: 'THE DOJO' },
  //   { venueId: 'v33', displayId: '4091897', label: 'Poker room SKY' },
  //
  //   [要確認・店名が一致しないので人の確認が必要]
  //   v26 / 4009265 … data.jsは「JOKER♠️ 福岡大橋」、API店名は "POKER HOUSE JOKER"。同一店か未確認
  //   v30 / 4050814 … data.jsは「ARIA 中洲」、API店名は "Aria" で登録1件のみ。同一店か未確認
];

const API_BASE = 'https://api.waitinglist-poker.com/v1/game-schedules/tournament';

// 名乗り。ブラウザのふりをせず「当サイトのボット」であることと連絡先を示す。
// 相手が正体を確認して遮断・連絡の判断ができる状態にしておくため。
const USER_AGENT = 'fukuokapoker.com-bot/1.0 (+https://fukuokapoker.com/contact.html)';

const PAGE_LIMIT = 100;          // APIのlimit上限
const PAGE_INTERVAL_MS = 1000;   // ページ間の待ち時間(礼儀)
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;          // 一時的な失敗のリトライ回数
const RETRY_BASE_MS = 3000;      // リトライ間隔(3秒 → 6秒)
const DATA_JS = path.join(__dirname, '..', 'data.js');
// 掲載管理コンソール向けの「自動取得している店」のリスト(下記 writeStoreList)
const STORES_JSON = path.join(__dirname, '..', 'auto-import-stores.json');
// 機械が最後に書いた値の控え。これといまの data.js を突き合わせて「人が直したか」を判定する。
// ★書き手ごとにファイルを分けてある。Instagram監視(07:10 JST)と時刻が近く、
//   同じJSONを両方が触ると `git pull --rebase` が衝突してジョブが落ちるため。
const WRITE_STATE_JSON = path.join(__dirname, '..', 'waitinglist-write-state.json');

// 状態ファイル導入(2026-08-04)より前に機械が書いた行の引き継ぎ規則。
// ★`wl-<ULID>` の ULID は API が発行した値で【人が発明できない】。`source: 'auto'` を書くのも
//   このスクリプトだけ(recurring-dedupe.js のヘッダも同じ事実に依存している)。
//   したがって「控えは無いが wl- で始まる auto 行」は機械が書いたものだと断定できる。
// ★効くのは各行につき1回だけ。以後は控えが付くので自然に解消する。
// ★★ここを `source: 'semi'` に広げてはいけない。手入力572件と同じ source なので、
//   広げた瞬間に社長の入力が「機械のもの」に化けて静かに上書きされる
//   (machine-write-state.js の assertSeedSpec が例外にして止める)。
const WRITE_STATE_SEED = { source: 'auto', idPrefix: 'wl-' };

// 一部の店だけ失敗したときの終了コード。0(全店成功)とも 1(何も書いていない)とも
// 区別できる値にしてある。ワークフローはこれを見て「コミットは進めるが最後に赤くする」を選ぶ。
const EXIT_PARTIAL = 2;

const DRY_RUN = process.argv.includes('--dry-run');
// 件数の急減ガードを人の判断で外すためのフラグ(閉店・長期休業など正当な減少のとき)
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');
const SHRINK_RATIO = 0.5; // 今日以降の件数が「前回 × この比率」を下回ったら止める
const MAX_ABS_DROP = 10;  // 比率に収まっていても、1回でこの件数以上減ったら止める(比率ガードの穴埋め)

// ---------- 小道具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

/** UTCのISO文字列 → JSTの { date: 'YYYY-MM-DD', start: 'HH:MM' }。実行環境のTZに依存しない。 */
function toJst(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return {
    date: `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`,
    start: `${pad2(j.getUTCHours())}:${pad2(j.getUTCMinutes())}`,
  };
}

/** 今日(JST)の YYYY-MM-DD */
function todayJst() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

/**
 * GitHub Actions のワークフローコマンド(::error::)に載せる文字列の百分率符号化。
 * `%` と改行をそのまま書くと、注記が壊れる・改行以降が切れる。
 *   - ghMsg  … 本文用。急減ガードの文面に「前回の50%未満」と生の % が入る
 *   - ghProp … title= などのプロパティ用。区切り文字の : と , も逃がす必要がある
 * GitHub 側が復号するので、画面には元の文字が出る。
 */
const ghMsg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s) => ghMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function fail(msg) {
  console.error(`[import-waitinglist] ERROR: ${msg}`);
  console.error('[import-waitinglist] data.js は書き換えていません。');
  process.exit(1);
}

// ---------- 取得 ----------

async function fetchPageOnce(displayId, page) {
  const url = `${API_BASE}?storeId=${encodeURIComponent(displayId)}&limit=${PAGE_LIMIT}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // ★ ブラウザを詐称しない。実体は GitHub Actions から毎日1回動く当サイトのボットなので、
      //   そのとおりに名乗り、問い合わせ先も添える。
      //   相手側が「これは何者か」を確認して、遮断したい・連絡したいと思ったときに
      //   それができる状態にしておくのが筋であるため
      //   (調査時は Origin/Referer を付けたブラウザのふりをして叩いていたが、
      //    外さなくても同じ 200 と同じ件数が返ることを確認したうえで削除した)。
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (page ${page})`);
  const json = await res.json();
  if (!json || !Array.isArray(json.tournaments)) throw new Error(`想定外のレスポンス形式 (page ${page})`);
  return json;
}

/** 一時的なネットワークエラー・レート制限で日次実行が落ちないよう、数回だけリトライする。 */
async function fetchPage(displayId, page) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchPageOnce(displayId, page);
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = RETRY_BASE_MS * attempt;
      console.warn(`[import-waitinglist] 取得失敗 (${attempt}/${MAX_ATTEMPTS}): ${e.message} — ${wait / 1000}秒後に再試行`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * 1店舗ぶんの全トーナメントを取得(ページング)。失敗は例外を投げる。
 *
 * 「HTTP 200だが中身が足りない」部分障害を通さないため、最後に totalRecords と
 * 実際の取得件数を突き合わせる。2ページ目が空で返るケース(=途中で切れる)も
 * ここで検出され、黙って件数が減ることはない。
 */
async function fetchStore(store) {
  const first = await fetchPage(store.displayId, 1);
  const total = Number(first.totalRecords) || first.tournaments.length;
  const all = [...first.tournaments];
  const pages = Math.ceil(total / PAGE_LIMIT);
  for (let p = 2; p <= pages; p++) {
    await sleep(PAGE_INTERVAL_MS);
    const res = await fetchPage(store.displayId, p);
    if (res.tournaments.length === 0) break;
    all.push(...res.tournaments);
  }
  // 念のためidで重複排除
  const seen = new Set();
  const uniq = all.filter((t) => {
    if (!t || !t.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // ページング不整合(=部分障害)の検出。宣言された総件数に届いていなければ信用しない。
  // ★ 必ず「重複排除“後”」の件数で判定する。排除前の all.length で見ると、
  //   同じidを水増しした応答や、ページング中のレコード挿入で同一レコードが
  //   2ページに跨った場合に、実データが静かに欠けたまま通ってしまう。
  if (uniq.length < total) {
    throw new Error(`ページング不整合: totalRecords=${total} に対し ${uniq.length}件(重複排除後)しか取得できませんでした`);
  }
  return uniq;
}

// ---------- 変換 ----------

/**
 * APIのトーナメント1件 → data.js の Tournament スキーマ。
 * guarantee / prize はAPIに該当フィールドが無く、notesからの推測は誤りの温床なので常に null。
 * 「大型」タグは人間の判断が要るため自動付与しない。
 */
function toTournament(t, venueId) {
  const jst = toJst(t.startAt);
  if (!jst) return null;

  const tags = [];
  if (t.feature === 'ターボ') tags.push('ターボ');
  else if (t.feature === 'ディープ') tags.push('ディープ');
  if (t.gameRule === 'plo') tags.push('PLO');
  else if (t.gameRule === 'mix') tags.push('ミックス');

  // addons[] は「アドオン」専用の配列ではなく、リバイや参加費違いの枠も入っている。
  // 例: m GLORY の addons[0] は addonName:"リバイ"/price 2000 で、そのまま使うとサイトに
  //     「+AO ¥2,000」と誤表示される。addonName が明示的にアドオンのものだけを採用する。
  const addonEntry = (Array.isArray(t.addons) ? t.addons : [])
    .find((a) => a && a.price != null && /アドオン|add[- ]?on/i.test(a.addonName || ''));
  const addon = addonEntry ? Number(addonEntry.price) : null;

  const reentry = Array.isArray(t.entries) && t.entries.some((e) => e && e.entryType === 'reEntry');

  return {
    id: `wl-${t.id}`,
    venueId,
    name: String(t.name || '').trim(),
    date: jst.date,
    start: jst.start,
    buyin: Number(t.registrationFee) || 0,
    addon,
    stack: Number(t.startingStack) || 0,
    guarantee: null,
    reentry,
    prize: null,
    tags,
    source: 'auto',
    verified: false,
  };
}

// ---------- data.js の読み書き ----------

const BLOCK_PREFIX = 'const TOURNAMENTS = ';

function readDataJs() {
  const src = fs.readFileSync(DATA_JS, 'utf8');
  const startIdx = src.indexOf(`${BLOCK_PREFIX}[`);
  if (startIdx < 0) fail('data.js に `const TOURNAMENTS = [` が見つかりません。');
  const endIdx = src.indexOf('\n];', startIdx);
  if (endIdx < 0) fail('data.js の TOURNAMENTS 配列の終端が見つかりません。');
  const jsonStart = startIdx + BLOCK_PREFIX.length;
  const jsonEnd = endIdx + 2; // '\n]' まで
  let arr;
  try {
    arr = JSON.parse(src.slice(jsonStart, jsonEnd));
  } catch (e) {
    fail(`TOURNAMENTS 配列をJSONとして解釈できません: ${e.message}`);
  }
  if (!Array.isArray(arr)) fail('TOURNAMENTS が配列ではありません。');
  return { src, arr, jsonStart, jsonEnd };
}

function writeDataJs(file, tournaments) {
  const out = file.src.slice(0, file.jsonStart) + JSON.stringify(tournaments, null, 2) + file.src.slice(file.jsonEnd);
  fs.writeFileSync(DATA_JS, out);
}

// ---------- 自動取得の対象店リスト(掲載管理コンソール向け) ----------

/**
 * 有効な STORES の内容を auto-import-stores.json に書き出す。
 *
 * 【何のためか】掲載管理コンソール(別リポジトリ fukuoka-poker-admin・ローカル専用)に
 *   「この店は自動取得なので手入力不要」を出すため。コンソールがこのスクリプトの
 *   STORES 配列をパースするのは壊れやすいので、機械可読な形で公開サイト側に置く。
 *
 * 【毎回同じ内容になること】入れるのは STORES から取れる値だけ。生成日時・取得件数などの
 *   「実行するたびに変わる値」は入れない。入れると、日程に変化が無い日でもこのファイルだけが
 *   差分になり、日次実行のたびに無意味なコミットが増える(ワークフローの差分判定は
 *   git status --porcelain なので、1バイトでも変われば必ずコミットされる)。
 *   → STORES を書き換えたときだけ差分が出る。
 *
 * 内容が変わらないときは書き込み自体を行わない(mtimeも動かさない)。
 *
 * 【書くのは実行が最後まで通ったときだけ】このスクリプトは「途中で異常を見つけたら何も書き換えない」
 *   を通している。ワークフローでは途中で落ちればコミット自体が走らないので、
 *   早く書いても遅く書いても結果は同じ。それなら人がローカルで失敗させたときに
 *   作業ツリーが汚れないほうがよいので、成功時にだけ書く。
 *   dryRun=true では書かずに「ズレているか」だけを返す。
 */
function writeStoreList(dryRun) {
  const json = JSON.stringify({
    generatedBy: 'tools/import-waitinglist.js',
    stores: STORES.map((s) => ({
      venueId: s.venueId,
      displayId: s.displayId,
      label: s.label,
      source: 'waitinglist',
    })),
  }, null, 2) + '\n';

  let cur = null;
  try { cur = fs.readFileSync(STORES_JSON, 'utf8'); } catch (e) { /* 未生成 */ }
  if (cur === json) return false;
  if (!dryRun) fs.writeFileSync(STORES_JSON, json);
  return true;
}

// ---------- upsert ----------

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 文字列の単純比較(ロケール非依存)。date/start はどちらも辞書順=時系列順になる書式。 */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDateStart = (a, b) => cmp(String(a.date), String(b.date)) || cmp(String(a.start), String(b.start));

/**
 * APIが供給できる(=毎回上書きしてよい)タグ語彙。
 * これ以外のタグ(バウンティ / 特別開催 / サテライト / 大型 など)は人間が付けたものなので、
 * 置き換え時に消さずに引き継ぐ。
 */
const API_OWNED_TAGS = ['ターボ', 'ディープ', 'PLO', 'ミックス'];

/**
 * APIから作った新エントリに、既存エントリが持っていた「APIが供給できない情報」を引き継ぐ。
 * 対象は guarantee(GTD) / prize / pinnedTags / 人間が付けたタグ。
 * 引き継ぎ元は【機械が所有する同じidの既存】1件だけ(2026-08-04)。
 * 以前は「同じ(date,start)の手入力」も引き継ぎ元にしていたが、いまは人の行の枠に
 * APIの行を書かないので渡す相手が存在しない。人の行の GTD/タグは
 * 【その行がそのまま残る】ことで守られる。
 *
 * これが無いと、初回の置き換えでGTDやバウンティ等が消え、さらに毎日の再生成で
 * 人が後から足した情報も翌朝には消えてしまう(冪等性のためにも必須)。
 *
 * 【pinnedTags】人間が明示的に固定したタグ。API_OWNED_TAGS(ターボ/ディープ/PLO/ミックス)であっても
 * 上書きされずに毎回 tags に合流する。APIの `feature` は単一値なので「ターボかつディープ」を
 * 表現できず、さらに欠測もある(m WTB Turbo は feature が無い)。スタック点数からの推測は
 * ノーマルとディープで 40000 が重複するため誤判定を生む。そこで自動判定を増やすのではなく、
 * 人が付けたことがデータ上わかる形で残す。
 */
function carryOver(next, prevs) {
  let guarantee = null;
  let prize = null;
  const humanTags = [];
  const pinnedTags = [];
  for (const p of prevs) {
    if (!p) continue;
    if (guarantee == null && p.guarantee != null) guarantee = p.guarantee;
    if (prize == null && p.prize != null) prize = p.prize;
    for (const tag of p.pinnedTags || []) pinnedTags.push(tag);
    for (const tag of p.tags || []) {
      if (!API_OWNED_TAGS.includes(tag)) humanTags.push(tag);
    }
  }
  const pinned = [...new Set(pinnedTags)];
  const entry = {
    ...next,
    // 【優先順: 人の値 > 今回取得した値 > null】(2026-08-04修正。tools/tournament-merge.js と同じ)
    // ★このスクリプトの toTournament は guarantee/prize を【定数 null で返す】(APIに該当
    //   フィールドが無く、notes からの推測は誤りの温床なので入れていない)。したがって
    //   このフォールバックが実際に効くことは無く、【出力はビット単位で変わらない】。
    //   それでも同じ式にしてあるのは、2つの mergeStore が同じ upsert規則の別実装であり、
    //   片方だけ違う形にすると次に読む人が「どちらが正しいのか」を判断できなくなるため
    //   (共通化そのものは、両方の取込み経路を同時に壊しうる変更なので単独のPRで行う)。
    guarantee: guarantee != null ? guarantee : next.guarantee != null ? next.guarantee : null,
    prize: prize != null ? prize : next.prize != null ? next.prize : null,
    tags: [...new Set([...next.tags, ...humanTags, ...pinned])],
  };
  // 空のときはキーごと出さない(既存の lowConfidence と同じく任意フィールド扱い。差分を汚さない)
  if (pinned.length) entry.pinnedTags = pinned;
  return entry;
}

/**
 * 1店舗ぶんのマージ。既存配列を破壊せず、新しい配列と統計を返す。
 *
 * ルール:
 *   - 過去日(today未満)のエントリは内容を一切変更しない
 *   - today以降: 【機械が所有する】source==='auto' は作り直す(carryOver で人手情報は温存)
 *   - today以降: 機械が所有する行のうち【人が直した項目】は、その項目だけ人の値を残す
 *   - today以降: 【機械が所有しない行】(人が作った行・人が直した行)には一切触らない。
 *                同じ(date,start)にAPIの行が来ても【APIの行を書かない】
 *   - today以降: APIに対応が無い既存の手入力は残す(件数と内訳をログに出す)
 *
 * 【★「同じ枠なら手入力を置き換える」を 2026-08-04 にやめた理由】
 *   置き換えは値の交換ではなく【情報量の低下】だった。Instagram監視の dry-run #5 では
 *   人の39件が Vision の読み取りに置き換わり、しかも39件はすべて `lowConfidence: true`
 *   (表示は ⚠ 要確認)なので、置き換えると【誰も確認していないのに ⚠ が外れる】。
 *   Waitinglist側でも同じ規則を使っていたため、v22 のような
 *   「社長が DMM公式と突き合わせて直した手入力」を持つ店を有効化した瞬間に同じことが起きる。
 *   規則の所有者は tools/tournament-merge.js のヘッダ(そちらに詳しい経緯がある)。
 *
 * @param {object} [opts] opts.records(控え) / opts.seed(導入前の行の引き継ぎ規則)
 * @returns {{ next: Array, stats: object, written: object }}
 *   written … 今回機械が書いた【人の値を戻す前の候補行】。★状態ファイルにはこれを控える。
 */
function mergeStore(all, store, apiEntries, today, opts = {}) {
  const slotOf = (t) => `${t.date} ${t.start}`;
  const records = opts.records || {};
  const seed = state.assertSeedSpec(opts.seed || null);
  const recordOf = (t) => (Object.prototype.hasOwnProperty.call(records, t.id) ? records[t.id] : null);

  const existing = all.filter((t) => t.venueId === store.venueId);
  const past = existing.filter((t) => t.date < today);
  const future = existing.filter((t) => !(t.date < today));

  const rawFuture = apiEntries.filter((t) => t.date >= today).sort(byDateStart);

  // 既存の未来行の所有をここで1回だけ判定する(以降はこの結果だけを見る)。
  const own = new Map();
  for (const t of future) own.set(t.id, state.ownership(t, recordOf(t), seed));
  const existingById = new Map(future.map((t) => [t.id, t]));

  // 【人のもの】を (date,start) で引けるようにする。APIの行はこの枠に入れない。
  const humanBySlot = new Map();
  for (const t of future) {
    if (own.get(t.id).owned) continue;
    const k = slotOf(t);
    if (!humanBySlot.has(k)) humanBySlot.set(k, []);
    humanBySlot.get(k).push(t);
  }

  const stats = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    carried: 0,
    // 【★残差で作らないこと★】書かないと決めたその場で +1 する。
    // `rawFuture.length - 書いた数` にすると、別の理由で行が消えてもこの項に吸い込まれる。
    protected: 0,
    protectedRows: [],
    fieldsProtected: 0,
    protectedFields: [],
    removedHumanEdited: [],
    keptManual: [],
  };

  // API側を1件ずつ確定させる(既存の情報を引き継ぎながら)
  const future$ = [];
  const written = {};
  const blockedIds = new Set();
  const protectedIncomingIds = new Set();

  for (const raw of rawFuture) {
    const prev = existingById.get(raw.id) || null;
    const o = prev ? own.get(prev.id) : null;

    // (1) 同じidの既存が【人のもの】= 控えが無い。行ごと守る。
    if (prev && !o.owned) {
      stats.protected += 1;
      stats.protectedRows.push({ incoming: raw, existing: [prev] });
      blockedIds.add(prev.id);
      protectedIncomingIds.add(raw.id);
      continue;
    }

    // (2) 別idの人の行が同じ枠を占めている。APIの行を書かない。
    //     ★項目単位で守れないのは、id が違う行同士は項目を対応づける根拠が無いため。
    //       旧実装の「名前が一致しない手入力のGTDは引き継がない」判断(欠落 > 誤情報)は
    //       否定されていない — 引き継ぎを見送るのではなく行そのものを書かないことで包含された。
    const blockers = (humanBySlot.get(slotOf(raw)) || []).filter((t) => t.id !== raw.id);
    if (blockers.length) {
      stats.protected += 1;
      stats.protectedRows.push({ incoming: raw, existing: blockers });
      for (const b of blockers) blockedIds.add(b.id);
      protectedIncomingIds.add(raw.id);
      continue;
    }

    // (3) 通常経路。APIの候補を作り、人が直した項目【だけ】を戻す。
    const prevOwned = prev && o.owned ? prev : null;
    const machineValue = carryOver(raw, [prevOwned]);
    written[raw.id] = machineValue;
    if (!sameEntry(machineValue, raw)) stats.carried++;

    const fields = prevOwned ? o.humanFields : [];
    if (fields.length) {
      stats.fieldsProtected += fields.length;
      stats.protectedFields.push({ entry: prevOwned, fields });
    }
    const entry = state.preserveHumanFields(machineValue, prevOwned, fields);
    future$.push(entry);

    if (prev) {
      if (sameEntry(prev, entry)) stats.unchanged++;
      else stats.updated++;
    } else {
      stats.added++;
    }
  }

  // 既存の未来ぶんの後始末。
  const writtenIds = new Set(future$.map((e) => e.id));
  const kept = [];
  for (const t of future) {
    if (writtenIds.has(t.id)) continue; // 作り直した行(future$ 側に入っている)
    const o = own.get(t.id);
    // 機械が所有する auto 行は「APIの応答=その時点の全件」が前提なので、
    // 応答に無い = APIから消えた(中止/削除)とみなして削除する(従来どおり)。
    // ★ただし今回【書かなかった】行は消しもしない(守った行に手を出さない)。
    if (t.source === 'auto' && o.owned && !protectedIncomingIds.has(t.id)) {
      stats.removed++;
      if (o.humanFields.length) stats.removedHumanEdited.push({ entry: t, fields: o.humanFields });
      continue;
    }
    kept.push(t);
    // 枠を守って APIの行を止めた行は protectedRows で数えているので、ここには入れない(二重計上を防ぐ)。
    if (!o.owned && !blockedIds.has(t.id)) stats.keptManual.push(t);
  }

  // 店舗ブロックを再構成(date → start 昇順)。過去日の中身は触らない。
  const block = [...past, ...kept, ...future$].sort(byDateStart);

  // 元の位置(その店の最初のエントリ位置)に差し込む。無ければ末尾。
  const firstIdx = all.findIndex((t) => t.venueId === store.venueId);
  const rest = all.filter((t) => t.venueId !== store.venueId);
  const insertAt = firstIdx < 0 ? rest.length : all.slice(0, firstIdx).filter((t) => t.venueId !== store.venueId).length;
  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];

  return { next, stats, written };
}

// ---------- 1店舗ぶんの取得と検査 ----------

/**
 * 1店舗ぶんを取得し、その店だけで完結する検査をすべて通す。
 *
 * 【throw する。process.exit しない】ここで落ちてよいのはその店だけで、
 * 他店の取込まで道連れにしてはいけない(呼び出し側が catch してスキップする)。
 * 呼び出し側が店名を添えるので、メッセージに店名は入れない。
 */
async function loadStore(store, before, today) {
  let raw;
  try {
    raw = await fetchStore(store);
  } catch (e) {
    throw new Error(`取得に失敗: ${e.message}`);
  }
  if (raw.length === 0) {
    // 月初に出やすい。APIは当月1日以降しか返さないので、その店が翌月ぶんを
    // まだ登録していない朝は 0件 になる(店が潰れたわけではない)。
    throw new Error('トーナメントが0件でした。API側の異常か、翌月ぶんが未登録の可能性があります。');
  }

  // 店舗の同一性検証。storeIdが無視されて別店舗が返ってきた場合に、
  // よその店のトーナメントをこの店として書き込んでしまうのを防ぐ。
  // ★ store フィールドが「無い」応答を素通りさせないため、存在自体を必須にする
  //   (フィールドが落ちているだけで検証がスキップされては検証の意味がない)。
  const noStore = raw.find((t) => !t.store || !t.store.displayId);
  if (noStore) {
    throw new Error(`store.displayId を持たないレコードがあります(id=${noStore.id})。店舗の同一性を確認できません。`);
  }
  const wrong = raw.find((t) => String(t.store.displayId) !== String(store.displayId));
  if (wrong) {
    throw new Error(`別店舗(displayId=${wrong.store.displayId} / ${wrong.store.name})のデータが混入しています。`);
  }

  const mapped = raw.map((t) => toTournament(t, store.venueId)).filter(Boolean);
  if (mapped.length === 0) {
    throw new Error('変換結果が0件でした(startAtが不正?)。');
  }

  // 「今日以降の件数が急に減った」= API側の部分障害を疑う。
  // HTTP 200で中身だけ欠けている応答(件数が足りない / 過去日しか返らない 等)はここで止まる。
  // 比率(半分未満)だけだと、件数が多い店ほど「しきい値ちょうど」で大量に消せてしまうため、
  // 「1回で MAX_ABS_DROP 件以上減ったら止める」絶対値の上限も併用する。
  // 閉店・長期休業など正当な大幅減のときは --allow-shrink で人が明示的に通す。
  // ★ 開催日が過ぎるだけでは発火しない。prevFuture と nextFuture は同じ today で数えるので
  //   両方が同時に減り、差は0にしかならない。ここが鳴るのは店が未来の大会を取り消したとき。
  const prevFuture = before.filter((t) => t.venueId === store.venueId && t.date >= today).length;
  const nextFuture = mapped.filter((t) => t.date >= today).length;
  const drop = prevFuture - nextFuture;
  if (!ALLOW_SHRINK && prevFuture > 0 && nextFuture < Math.ceil(prevFuture * SHRINK_RATIO)) {
    throw new Error(
      `今日以降の件数が ${prevFuture}件 → ${nextFuture}件 と急減(前回の${Math.round(SHRINK_RATIO * 100)}%未満)。` +
        'API側の部分障害の可能性があります(意図した減少なら --allow-shrink)。'
    );
  }
  if (!ALLOW_SHRINK && drop >= MAX_ABS_DROP) {
    throw new Error(
      `今日以降の件数が ${prevFuture}件 → ${nextFuture}件 と一度に${drop}件減っています(上限${MAX_ABS_DROP}件)。` +
        'API側の部分障害の可能性があります(意図した減少なら --allow-shrink)。'
    );
  }

  return { mapped, raw, prevFuture, nextFuture };
}

// ---------- main ----------

async function main() {
  const today = todayJst();
  console.log(`[import-waitinglist] 基準日(JST): ${today}${DRY_RUN ? ' / DRY-RUN' : ''}`);

  const file = readDataJs();
  const before = file.arr;
  const beforeJson = JSON.stringify(before);

  // 0) 機械が最後に書いた値の控えを読む。
  //    読めない/壊れているときは【空として続行する】— ここで落とすと状態ファイル1つで
  //    日次の取込みが永久に止まる。空でも人の行は守られる側に倒れる(既定値が「人のもの」)。
  const writeState = state.readState(WRITE_STATE_JSON);
  if (writeState.broken) {
    console.warn(
      `[import-waitinglist] ⚠ ${path.basename(WRITE_STATE_JSON)} を読めませんでした(壊れている?)。` +
        '控えなしで続行します。人の行は守られますが、【auto行に対する人の修正は今回だけ守れません】。'
    );
  } else if (writeState.missing) {
    console.log(
      `[import-waitinglist] ${path.basename(WRITE_STATE_JSON)} はまだありません。` +
        `今回 ${WRITE_STATE_SEED.idPrefix} で始まる auto 行を機械のものとして控え直します。`
    );
  } else {
    console.log(`[import-waitinglist] 機械が書いた値の控え: ${Object.keys(writeState.entries).length}件`);
  }

  // 1) 先に全店ぶん取得しきる。
  //    店ごとに独立して成否を判定し、【失敗した店だけを落として他店は通す】。
  //    失敗は StoreError として捨てずに集め、最後にまとめて報告する。
  const fetched = [];
  const failures = [];
  for (const store of STORES) {
    try {
      const { mapped, raw, prevFuture, nextFuture } = await loadStore(store, before, today);
      console.log(`[import-waitinglist] ${store.label}: API ${raw.length}件 取得 / 変換 ${mapped.length}件 / うち ${today} 以降 ${nextFuture}件(前回 ${prevFuture}件)`);
      fetched.push({ store, mapped });
    } catch (e) {
      failures.push({ store, message: e.message });
      // 当番が最初に見る情報なので、その場で目立たせる。GitHub Actions では
      // ::error:: 注記が実行サマリの先頭に出るため、ログを遡らなくても店名が分かる。
      console.error(`[import-waitinglist] ✗ ${store.label} (storeId=${store.displayId}) をスキップ: ${e.message}`);
      console.error(`::error title=${ghProp(`Waitinglist取込に失敗 (${store.label})`)}::${ghMsg(e.message)}`);
    }
  }

  // 失敗した店を先頭付近でまとめて出す(1店ずつのログは他店の出力に埋もれるため)。
  if (failures.length) {
    console.error('');
    console.error(`[import-waitinglist] ===== 取得に失敗した店舗 ${failures.length}/${STORES.length}件 =====`);
    for (const f of failures) console.error(`  ✗ ${f.store.label} (${f.store.venueId} / storeId=${f.store.displayId}): ${f.message}`);
    console.error('[import-waitinglist] ※ この店のデータは今回いっさい変更しません(前回の内容がそのまま残ります)。');
    console.error('');
  }

  // 全店だめだったときは書くものが無い。従来どおり何も触らずに終了コード1。
  if (!fetched.length) {
    fail(`対象 ${STORES.length}店すべての取得に失敗しました。data.js は書き換えていません。`);
  }

  // 2) マージ
  let arr = before;
  const allStats = [];
  const writtenAll = {}; // id → 機械が書いた候補値(人の値を戻す前)。状態ファイルに控える
  for (const { store, mapped } of fetched) {
    const { next, stats, written } = mergeStore(arr, store, mapped, today, {
      records: writeState.entries,
      seed: WRITE_STATE_SEED,
    });
    arr = next;
    Object.assign(writtenAll, written);
    allStats.push({ store, stats });
  }

  // 3) サマリ
  for (const { store, stats } of allStats) {
    console.log('');
    console.log(`[${store.label} / ${store.venueId}]`);
    console.log(
      `  追加 ${stats.added}件 / 更新 ${stats.updated}件 / 変更なし ${stats.unchanged}件 / ` +
        `削除(APIから消滅) ${stats.removed}件 / 人の行を守って見送り ${stats.protected}件 / ` +
        `API未掲載の手入力 ${stats.keptManual.length}件`
    );
    console.log(`  うち人手情報(GTD/プライズ/pinnedTags/人手タグ)を引き継いだもの ${stats.carried}件`);
    if (stats.protectedRows.length) {
      // 【::error:: にはしない】人の行がある限り毎日同じ件数が出る性質のものなので、
      // 警告チャネルに載せると常時点灯になり、本物の異常が読めなくなる。事実として明細に出す。
      console.log(`  人の行を守り、APIの行を書きませんでした ${stats.protectedRows.length}件:`);
      for (const { incoming, existing } of stats.protectedRows) {
        console.log(`    - ${incoming.date} ${incoming.start} 人の行: ${existing.map((e) => `${e.name} (${e.id})`).join(' / ')}`);
        // ★機械の読み値も並べて出す。両者がずれているなら、そのずれ自体が人の確認対象。
        console.log(`      APIの読み値: ${incoming.name} / 参加費 ${incoming.buyin} / スタック ${incoming.stack} (${incoming.id})`);
      }
    }
    if (stats.protectedFields.length) {
      console.log(`  人が直した項目を残しました ${stats.fieldsProtected}項目 / ${stats.protectedFields.length}行:`);
      for (const { entry, fields } of stats.protectedFields) {
        console.log(`    - ${entry.date} ${entry.start} ${entry.name} (${entry.id}): ${fields.join(', ')}`);
      }
    }
    if (stats.removedHumanEdited.length) {
      // 人が直した行がAPIから消えた = その行は削除される。存在の有無はAPIが正なので削除するが、
      // 黙って消すと人の作業が理由不明に消えるので必ず出す。
      console.log(`  ⚠ 人が直した行がAPIから消えたため削除しました ${stats.removedHumanEdited.length}件:`);
      for (const { entry, fields } of stats.removedHumanEdited) {
        console.log(`    - ${entry.date} ${entry.start} ${entry.name} (${entry.id}): 直していた項目 ${fields.join(', ')}`);
      }
    }
    if (stats.keptManual.length) {
      console.log('  API未掲載のため残した手入力(APIに未登録か、中止された可能性。要目視確認):');
      for (const t of stats.keptManual) console.log(`    - ${t.date} ${t.start} ${t.name} (${t.id}, source=${t.source})`);
    }
  }

  // 4) 他店に影響が出ていないことの自己チェック
  //    ★ 基準は STORES 全体ではなく【今回取得に成功した店だけ】。こうすると
  //      「スキップした店のデータが変わっていないこと」まで同時に検査できる
  //      (スキップした店は others 側に入るため)。
  //
  //    ★ 比較の左辺には【マージ前に取っておいたディープコピー】を使う。
  //      before と arr は同じ要素オブジェクトを共有しているので、左辺に before を渡すと
  //      「エントリを in-place で書き換えるバグ」が両辺に同じように映って素通りする
  //      (品質管理部の変異試験で実証済み: 構造的な差し替えは検知できるが in-place は抜ける)。
  //      beforeJson は冒頭で取得済みなので、そこから復元すれば実行時のコストもほぼ無い。
  //      現在の mergeStore / carryOver は常に新しいオブジェクトを作るので今のところ実害は無いが、
  //      将来 in-place な実装が紛れ込んでも検査が効くようにしておく。
  //
  //    ★ 過去日は【順序を見ない】。理由(実データでは1店が2ブロックに分かれており、
  //      mergeStore がそれを1か所にまとめると別の店の過去日を追い越す)と、
  //      その代わりに何を厳密に見ているかは tools/schedule-write-guard.js のヘッダに書いてある。
  //      ★この検査は書き込みの【前】にあるので、落ちると data.js が書き換わらず、
  //        翌朝も同じ配置で同じように落ちる = 自分では回復しない。あちらのヘッダを必ず読むこと。
  const beforeSnapshot = JSON.parse(beforeJson);
  const targets = new Set(fetched.map(({ store }) => store.venueId));
  const verdict = guard.checkNothingElseChanged(beforeSnapshot, arr, {
    targets,
    today,
    othersLabel: '取得に成功した店舗以外',
  });
  // 並びが変わった行数は【0でも必ず出す】(変化時だけ出す形にすると壊れても気付けない)。
  for (const line of guard.formatReorderReport(verdict, '[import-waitinglist]')) console.log(line);
  if (!verdict.ok) {
    fail(verdict.message);
  }

  // 4.5) 人の行・人が直した項目が1つも壊れていないことの突き合わせ。
  //   ★上の stats(protected / fieldsProtected)を一切参照しない。
  //     マージ前のディープコピーと、マージ後の配列と、控えだけで判定するので、
  //     集計を潰す変異が入ってもこの検査は独立に生き残る。
  //     カウンタで検算する形にすると同じ材料どうしの比較=恒等式になり、何も検査しない。
  try {
    const recordOf = (t) =>
      Object.prototype.hasOwnProperty.call(writeState.entries, t.id) ? writeState.entries[t.id] : null;
    const isOwned = (t) => state.ownership(t, recordOf(t), WRITE_STATE_SEED).owned;
    const rowProblem = state.findUnownedRowChange(beforeSnapshot, arr, isOwned);
    if (rowProblem) throw new Error(rowProblem);
    const fieldProblem = state.findHumanFieldChange(beforeSnapshot, arr, recordOf);
    if (fieldProblem) throw new Error(fieldProblem);
    // 破壊だけでなく【重複】の向きも見る(理由は machine-write-state.js の同関数のコメント)。
    const slotProblem = state.findMachineRowInHumanSlot(beforeSnapshot, arr, isOwned);
    if (slotProblem) throw new Error(slotProblem);
  } catch (e) {
    fail(`${e.message}(バグ)。書き込みを中止します。`);
  }

  const changed = JSON.stringify(arr) !== beforeJson;
  console.log('');
  console.log(`[import-waitinglist] TOURNAMENTS 全体: ${before.length}件 → ${arr.length}件 / 変更${changed ? 'あり' : 'なし'}`);

  // 次の控え。今回マージした店の記録は入れ替え、取得に失敗してスキップした店の記録は残す
  // (その店の data.js は1バイトも変えていないので、控えも変えてはいけない)。
  // 過去日と、data.js から消えた行は刈る(控える意味が無く、放っておくと際限なく膨らむ)。
  const nextStateEntries = state.buildNextEntries(writeState.entries, writtenAll, {
    today,
    replacedVenueIds: fetched.map(({ store }) => store.venueId),
    liveIds: new Set(arr.map((t) => t.id)),
  });

  if (DRY_RUN) {
    console.log('[import-waitinglist] --dry-run のため data.js は書き換えていません。');
    if (writeStoreList(true)) {
      console.log('[import-waitinglist] auto-import-stores.json は STORES とズレています（--dry-run 無しで実行すると更新されます）。');
    }
    if (state.writeState(WRITE_STATE_JSON, nextStateEntries, { writtenBy: 'tools/import-waitinglist.js', dryRun: true })) {
      console.log(`[import-waitinglist] ${path.basename(WRITE_STATE_JSON)} も更新対象です（--dry-run のため書いていません）。`);
    }
    return failures.length ? EXIT_PARTIAL : 0;
  }

  // 5) 掲載管理コンソール向けの対象店リスト。
  //    data.js に差分があるかどうかとは無関係に、常に STORES と一致させる
  //    (下の「変更が無いため書き換えていません」で早期returnする前に処理すること)。
  //    ★ 中身は STORES(設定)であって「今回成功した店」ではない。取得に失敗した日でも
  //      その店が自動取得対象であることに変わりはないため、失敗の有無で内容を変えない
  //      (変えると失敗した日だけこのファイルが差分になり、無意味なコミットが増える)。
  const storeListChanged = writeStoreList(false);
  console.log(`[import-waitinglist] auto-import-stores.json: ${storeListChanged ? '更新しました' : '変更なし'}（対象 ${STORES.length}店）`);

  if (!changed) {
    console.log('[import-waitinglist] 変更が無いため data.js は書き換えていません。');
  } else {
    writeDataJs(file, arr);
    console.log('[import-waitinglist] data.js を更新しました。');
  }

  // 6) 機械が書いた値の控えを更新する。
  //    ★data.js に差分が無くても書く。控えは「機械が最後に書いた値」であって
  //      「data.js が変わったか」ではない(過去日の刈り込みだけの日もある)。
  //    ★控えるのは【人の値を戻す前】の候補行。戻した後を控えると、翌日は控えといまの値が
  //      一致して食い違いが消え、人の修正が翌々日に上書きされる。
  const stateChanged = state.writeState(WRITE_STATE_JSON, nextStateEntries, {
    writtenBy: 'tools/import-waitinglist.js',
  });
  console.log(
    `[import-waitinglist] ${path.basename(WRITE_STATE_JSON)}: ${stateChanged ? '更新しました' : '変更なし'}` +
      `（控え ${Object.keys(nextStateEntries).length}件）`
  );

  if (failures.length) {
    console.error(
      `[import-waitinglist] 成功 ${fetched.length}店 / 失敗 ${failures.length}店。` +
        `成功したぶんは書き込み済みです。終了コード ${EXIT_PARTIAL} で終わります(ワークフローは赤くなります)。`
    );
    return EXIT_PARTIAL;
  }
  return 0;
}

// 終了コードは main() の戻り値で決める(0 = 全店成功 / EXIT_PARTIAL = 一部失敗・成功分は書込済 /
// 1 = 何も書いていない致命的な失敗)。呼び出し側のワークフローは EXIT_PARTIAL を
// 「コミットは進めるが最後にジョブを失敗させる」として扱う。
main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((e) => fail(e && e.stack ? e.stack : String(e)));
