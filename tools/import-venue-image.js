#!/usr/bin/env node
/**
 * import-venue-image.js
 *
 * 店舗から直接(LINE/メール等で)届いたトーナメント月間スケジュール画像を取り込み、
 * Visionモデルで抽出したうえで `data.js` に安全にupsertするCLIツール。
 *
 * 【経緯】PR #13で実装したInstagram自動巡回(セッションCookie注入+検知回避を伴う設計)は
 * 経営管理オフィスの判断で中止した。代わりに「各店舗にスケジュール画像を当社のLINE/メールへ
 * 直接送ってもらう」運用に切り替え、届いた画像をこのツールで取り込む。
 * メール/LINE受信の自動化(画像を自動で取ってくる部分)は今回のスコープ外— 届いた画像は
 * 人が保存し、このツールにファイルパスを渡して実行する。
 *
 * 【処理の流れ】
 *   1. 画像(ファイル、または任意で --instagram-url 経由のサムネイル)を用意する
 *   2. Visionモデルに渡し、Tournamentスキーマの配列に正規化する
 *      (tools/venue-schedule-vision.js。PR #13の instagram-vision.js を引き継いだロジック)
 *   3. `source: 'semi', verified: false` を付ける(店舗から届いた写真はWaitinglist API
 *      のような構造化データではなく人力の読み取りのため、確度フラグを立てる。
 *      admin.html 経由の手動登録と同じ扱い)
 *   4. 安全なupsert(tools/tournament-merge.js。対象venue以外・過去日は一切触らない、
 *      書き込み前に自己チェック、失敗時は書き換えない)で `data.js` に反映する
 *
 * 【人が入力した行は上書きしない(2026-08-04)】
 * 以前は「同じ(date,start)の手入力は取込み結果で置き換える」規則だった。いまは
 * 【機械が最後に書いた値の控え】(venue-image-write-state.json)を持ち、控えがある行だけを
 * 更新する。控えの無い行 — 人が admin.html で入れた行 — は同じ枠でも一切触らない。
 * ★このツール自身が前回書いた行(`photo-` 接頭辞)は控えがあるので、再取込みで更新される。
 *   控えを消した場合・このPRより前に書いた `photo-` 行は「人のもの」として扱われ、
 *   再取込みでは更新されず並存する。その場合は admin.html で古い行を消してから取り込むこと
 *   (削除 = 機械への引き渡し)。
 *
 * 【★seed を足さないこと】Waitinglist取込みには「控えが無くても `wl-` + `source:'auto'` なら
 * 機械のもの」という引き継ぎ規則があるが、このツールが書くのは `source: 'semi'` で、
 * これは人が admin.html で入れた行と同じ source である。同じ規則をここへ持ち込むと
 * 手入力が機械のものに化ける(tools/machine-write-state.js の assertSeedSpec が例外にする)。
 *
 * 使い方:
 *   node tools/import-venue-image.js --venue v40 --image ./inbox/orio-2026-09.jpg
 *   node tools/import-venue-image.js --venue v40 --image ./inbox/orio.jpg --dry-run
 *   node tools/import-venue-image.js --venue v40 --instagram-url https://www.instagram.com/p/XXXX/
 *
 * オプション:
 *   --venue <id>            必須。data.js の VENUES に存在するIDであること(誤入力で
 *                            別店舗のデータとして登録するのを防ぐため、存在チェックする)
 *   --image <path>           画像ファイル(--instagram-url と排他。どちらか一方が必須)
 *   --instagram-url <url>    投稿リンクからoEmbed経由でサムネイルを取得する(--image と排他)。
 *                            店舗が画像そのものではなく投稿リンクだけ送ってきた場合の代替経路。
 *                            ログイン・巡回は行わない(tools/instagram-oembed.js参照)
 *   --posted-date <YYYY-MM-DD>  年の判断に使うヒント(省略時は実行日=JST今日)
 *   --dry-run                data.js を書き換えず、抽出結果だけ表示する
 *
 * 必要な環境変数: ANTHROPIC_API_KEY(Vision抽出に必須。tools/venue-schedule-vision.js参照)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 「data.js に入れてよい行か」の判定は、コミット前ゲート(tools/validate-data.js)および
// Instagram監視(tools/monitor-instagram-apify.js)と同じものを使う。判定を書き分けない。
// normalizeExtractedRow は検査の前段(`9:00`→`09:00` 等、直せる逸脱を直す)、
// extractedRowProblem は1行だけの検査、duplicateIdProblem は行を跨ぐ検査(id重複)。
const { normalizeExtractedRow, extractedRowProblem, duplicateIdProblem } = require('./validate-data');

// 「機械が最後に書いた値」の控えと、そこから導く所有の判定。
const machineState = require('./machine-write-state');

// 【店ごとの掲載ルール】(社長指示)。Instagram監視(tools/monitor-instagram-apify.js)と
// 【同じものを使う】。このツールは Instagram監視が内容を取りこぼしたときの手動の代替経路
// (「内容が必要なら node tools/import-venue-image.js … で手動取込みしてください」)なので、
// ここで規則が効かないと【自動経路で消したはずの参加費・行が、手動経路から入ってくる】。
// 実害(利用者が持っていく金額を誤る)は経路によらず同じ。
const listingRules = require('./venue-listing-rules');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_JS = path.join(REPO_ROOT, 'data.js');
// 書き手ごとにファイルを分けてある(理由は tools/import-waitinglist.js の同名の定数を参照)。
// ★実際のパスは【書き込む data.js と同じディレクトリ】から導く(下記 importVenueImage)。
//   ここでファイル名だけを持つのは、定数を既定値にするとテストが本物のリポジトリに書いてしまうため。
const WRITE_STATE_BASENAME = 'venue-image-write-state.json';

function parseArgs(argv) {
  const args = { dryRun: argv.includes('--dry-run') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--venue') args.venue = argv[++i];
    else if (argv[i] === '--image') args.image = argv[++i];
    else if (argv[i] === '--instagram-url') args.instagramUrl = argv[++i];
    else if (argv[i] === '--posted-date') args.postedDate = argv[++i];
  }
  return args;
}

const pad2 = (n) => String(n).padStart(2, '0');
function todayJstIso() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'post';
}

/**
 * Vision抽出の素の結果1件 → Tournamentスキーマ。
 * 【必ず normalizeExtractedRow を通した行を渡すこと】— id は start から組み立てるので、
 * `9:00` のまま渡すと id が `-900-` になり、同日内の並び順(start の文字列比較)も狂う。
 * buyin/stack の既定値が 0 ではなく null なのは、0 が「0円=無料」という読み取れた値であり、
 * 「読み取れなかった」を表せるのは null だけだから(tools/monitor-instagram-apify.js と同じ)。
 */
function toTournament(t, venueId) {
  const start = t.start || '00:00';
  // 【店ごとの掲載ルール: 参加費を一切記録しない店】(社長指示)
  // Instagram監視側の toTournament と同じ扱いにする。この経路だけ参加費が残ると、
  // 同じ店の日程が「載っている行と載っていない行」に割れて、利用者にはどちらが正しいか分からない。
  const noBuyinRule = listingRules.buyinNotRecorded(venueId);
  return {
    id: `photo-${venueId}-${t.date}-${String(start).replace(':', '')}-${slugify(t.name)}`,
    venueId,
    name: String(t.name).trim(),
    date: t.date,
    start,
    buyin: noBuyinRule ? null : t.buyin != null ? Number(t.buyin) : null,
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
 * 中核ロジック(依存はすべて注入。ネットワーク/ファイルI/Oを行わないのでテストしやすい)。
 *
 * @param {{ venueId: string, imageBuffer: Buffer, mediaType?: string, postedDateHint?: string, dryRun?: boolean, dataJsPath: string, today?: string }} opts
 * @param {{ visionLib: object, mergeLib: object }} libs
 * @returns {Promise<{ tournaments: Array<object>, stats: object|null }>}
 */
async function importVenueImage(opts, libs) {
  const { visionLib, mergeLib } = libs;
  const today = opts.today || todayJstIso();

  const raw = await visionLib.extractTournaments(opts.imageBuffer, {
    postedDateHint: opts.postedDateHint || today,
    mediaType: opts.mediaType,
  });

  // 不正な行(日付が YYYY-MM-DD でない等)はその行だけを捨て、残りは取り込む。
  // 捨てた行は必ずログに出す(このCLIは人が見ながら実行するので、黙って減ると読み取り漏れに気づけない)。
  // id重複も捨てる — 同じidが2件入ると data.js の共通ゲート(tools/validate-data.js)が落ちる。
  // 既存 data.js 側との衝突までは見ない(このCLIは人が結果を見ながら実行し、直後に
  // `node tools/validate-data.js .` を回せる。無人の日次ジョブである Instagram監視側は
  // そこまで見ている — tools/monitor-instagram-apify.js の existingIdSlots)。
  const tournaments = [];
  const usedIds = new Set();
  // 【店ごとの掲載ルールの観測】0件でも下で必ず出す(鳴らない警報にしない)。
  // ★どちらも「その場で正の述語で数える」。残差で出すと、別の理由で消えた行がここへ
  //   吸い込まれて表に出なくなる(Instagram監視側と同じ規律)。
  let venueRuleExcluded = 0;
  let buyinSuppressed = 0;
  let buyinAbsent = 0;
  for (const t of Array.isArray(raw) ? raw : []) {
    // 検査の前に、直せる逸脱(`9:00`→`09:00` / 読めない金額はその項目だけ null)を直す。
    // 直した内容は【正規化前の値ごと】ログに出す(人が結果を見ながら実行するCLIなので、
    // 黙って値が変わると読み取り漏れと区別が付かない)。
    const { row, notes } = normalizeExtractedRow(t);
    for (const n of notes) {
      console.warn(
        `[import-venue-image] 抽出結果を正規化しました: ${n.field}: ${JSON.stringify(n.from)} → ` +
          `${JSON.stringify(n.to)}(${n.reason}) / venueId=${opts.venueId} / name=${JSON.stringify(row && row.name)}`
      );
    }
    let reason = extractedRowProblem(row);
    // 【店ごとの掲載ルールによる除外】(社長指示)。理由の文面は自動経路と同じものを使う。
    if (!reason) {
      const exclusion = listingRules.excludedByListingRule(opts.venueId, row && row.name);
      if (exclusion) {
        reason = listingRules.exclusionReasonText(exclusion);
        venueRuleExcluded += 1;
      }
    }
    let entry = null;
    if (!reason) {
      entry = toTournament(row, opts.venueId);
      const dup = duplicateIdProblem(entry, usedIds, null);
      if (dup) reason = dup.reason;
    }
    if (reason) {
      console.warn(
        `[import-venue-image] 抽出結果を1件破棄しました: ${reason}` +
          ` / venueId=${opts.venueId} / date=${JSON.stringify(row && row.date)} / name=${JSON.stringify(row && row.name)}`
      );
      continue;
    }
    // 【参加費を記録しない店で何件捨てたか】採用が確定したこの位置で数える
    // (上で数えると、この後 id重複で破棄された行まで数えてしまう)。
    if (listingRules.buyinNotRecorded(opts.venueId)) {
      if (row.buyin != null) buyinSuppressed += 1;
      else buyinAbsent += 1;
    }
    usedIds.add(entry.id);
    tournaments.push(entry);
  }

  // 【★0件でも必ず出す★】このCLIは人が結果を見ながら実行する。件数が出るときだけ出す形にすると、
  // 「今回は対象が無かった」と「規則を通らなくなった」が同じ無出力になって区別が付かない。
  // ★下の「0件でした」の throw より【前】に出すこと。全行が除外対象だった場合に、
  //   なぜ0件になったのかが分からないまま落ちるのを防ぐ。
  const noBuyinRule = listingRules.buyinNotRecorded(opts.venueId);
  console.log(
    `[import-venue-image] 店ごとの掲載ルール(tools/venue-listing-rules.js): ` +
      `除外した行 ${venueRuleExcluded}件 / ` +
      (noBuyinRule
        ? `参加費を記録しない店(${noBuyinRule.label}) — 採用${buyinSuppressed + buyinAbsent}行のうち` +
          `読み取れた参加費を捨てた ${buyinSuppressed}行 / 元から参加費が無かった ${buyinAbsent}行`
        : '参加費の非記録: 対象外の店')
  );
  // 【店ごとの掲載ルールの事後条件】規則を適用する場所とは別に、出来上がった物そのものを見る。
  // 良性の入力では鳴らない(自分のコードのバグ専用)。
  listingRules.assertListingRulesApplied(tournaments, `import-venue-image(${opts.venueId})`);

  if (!tournaments.length) {
    throw new Error('Vision抽出結果が0件でした(告知画像ではなかった、または抽出結果がすべて不正だった可能性があります)。');
  }

  if (opts.dryRun) {
    return { tournaments, stats: null };
  }

  const file = mergeLib.readDataJs(opts.dataJsPath);
  const before = file.arr;
  // ★突き合わせの左辺はマージ前のディープコピー。before と next が同じ要素オブジェクトを
  //   共有していると、in-place で書き換えるバグが両辺に同じように映って素通りする。
  const beforeSnapshot = JSON.parse(JSON.stringify(before));

  // 控え。読めなければ空(= 全行が人のもの)として続行する。安全側に倒れる。
  // ★パスは【書き込む data.js と同じディレクトリ】から導く。定数(WRITE_STATE_JSON)を既定値に
  //   すると、一時ディレクトリの data.js を渡すテストが【本物のリポジトリに控えを書いてしまう】
  //   (実際に踏んだ)。data.js と控えは必ず同じ場所で対になっている必要もある。
  const statePath = opts.writeStatePath || path.join(path.dirname(opts.dataJsPath), WRITE_STATE_BASENAME);
  const prevState = machineState.readState(statePath);

  const { next, stats, written } = mergeLib.mergeStore(before, opts.venueId, tournaments, today, {
    records: prevState.entries,
    // ★seed は渡さない。このツールが書くのは source:'semi' で、手入力と同じ source のため。
  });
  mergeLib.assertOnlyTargetChanged(beforeSnapshot, next, opts.venueId, today);
  mergeLib.assertHumanEditsPreserved(beforeSnapshot, next, { records: prevState.entries });
  mergeLib.writeDataJs(opts.dataJsPath, file, next);

  machineState.writeState(
    statePath,
    machineState.buildNextEntries(prevState.entries, written, {
      today,
      replacedVenueIds: [opts.venueId],
      liveIds: new Set(next.map((t) => t.id)),
    }),
    { writtenBy: 'tools/import-venue-image.js' }
  );

  return { tournaments, stats };
}

function fail(msg) {
  console.error(`[import-venue-image] ERROR: ${msg}`);
  console.error('[import-venue-image] data.js は書き換えていません。');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.venue) fail('--venue <id> を指定してください。');
  if (!args.image && !args.instagramUrl) fail('--image <path> か --instagram-url <url> のどちらかを指定してください。');
  if (args.image && args.instagramUrl) fail('--image と --instagram-url は同時に指定できません。');

  // venue存在チェック(別店舗のデータとして誤登録するのを防ぐ)
  let venues;
  try {
    ({ VENUES: venues } = require(DATA_JS));
  } catch (e) {
    fail(`data.js の読み込みに失敗しました: ${e.message}`);
  }
  const venue = venues.find((v) => v.id === args.venue);
  if (!venue) fail(`venueId '${args.venue}' は VENUES に存在しません(typoの可能性)。`);

  const visionLib = require('./venue-schedule-vision');
  const mergeLib = require('./tournament-merge');

  let imageBuffer;
  let mediaType = 'image/jpeg';
  if (args.image) {
    const imgPath = path.resolve(args.image);
    if (!fs.existsSync(imgPath)) fail(`画像ファイルが見つかりません: ${imgPath}`);
    imageBuffer = fs.readFileSync(imgPath);
    mediaType = visionLib.mediaTypeFromPath(imgPath);
  } else {
    const oembedLib = require('./instagram-oembed');
    try {
      imageBuffer = await oembedLib.fetchThumbnailImage(args.instagramUrl);
    } catch (e) {
      fail(e.message);
    }
  }

  let result;
  try {
    result = await importVenueImage(
      {
        venueId: venue.id,
        imageBuffer,
        mediaType,
        postedDateHint: args.postedDate,
        dryRun: args.dryRun,
        dataJsPath: DATA_JS,
      },
      { visionLib, mergeLib }
    );
  } catch (e) {
    fail(e.message);
  }

  const { tournaments, stats } = result;
  console.log(`[import-venue-image] ${venue.name}(${venue.id}): ${tournaments.length}件を抽出しました。`);

  if (args.dryRun) {
    console.log('[import-venue-image] --dry-run のため data.js は書き換えません。抽出結果:');
    console.log(JSON.stringify(tournaments, null, 2));
    return;
  }

  console.log(
    `[import-venue-image] data.js を更新しました(追加${stats.added}/更新${stats.updated}/` +
      `変更なし${stats.unchanged}/削除${stats.removed}/人の行を守って見送り${stats.protected}件/` +
      `残した手入力${stats.keptManual.length}件)。`
  );
  if (stats.protectedRows.length) {
    console.log('[import-venue-image] 人の行を守り、読み取った行を書きませんでした(人が入れた内容が正です):');
    for (const { incoming, existing } of stats.protectedRows) {
      console.log(`  - ${incoming.date} ${incoming.start} 人の行: ${existing.map((e) => `${e.name} (${e.id})`).join(' / ')}`);
      console.log(`    読み取った値: ${incoming.name} / 参加費 ${incoming.buyin} / スタック ${incoming.stack}`);
    }
    console.log('  ※ 読み取った側を採用したい行は、admin.html でその行を消してから取り込み直してください。');
  }
  if (stats.protectedFields.length) {
    console.log(`[import-venue-image] 人が直した項目を残しました(${stats.fieldsProtected}項目 / ${stats.protectedFields.length}行):`);
    for (const { entry, fields } of stats.protectedFields) {
      console.log(`  - ${entry.date} ${entry.start} ${entry.name} (${entry.id}): ${fields.join(', ')}`);
    }
  }
  console.log('[import-venue-image] 忘れずに `node tools/gen-venue-pages.js .` を実行し、店舗静的ページを再生成してください。');
  console.log(
    '[import-venue-image] 注意: 日程が大幅に変わった月の再取込みでは、前回取り込んだ古いエントリが' +
      '自動では消えず並存することがあります(残した手入力の件数が想定より多い場合は要確認)。' +
      '必要なら admin.html 側で手動整理してください。'
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}

module.exports = { parseArgs, slugify, todayJstIso, toTournament, importVenueImage };
