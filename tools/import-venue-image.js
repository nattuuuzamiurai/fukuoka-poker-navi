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

const REPO_ROOT = path.join(__dirname, '..');
const DATA_JS = path.join(REPO_ROOT, 'data.js');

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

/** Vision抽出の素の結果1件 → Tournamentスキーマ。 */
function toTournament(t, venueId) {
  const start = t.start || '00:00';
  return {
    id: `photo-${venueId}-${t.date}-${String(start).replace(':', '')}-${slugify(t.name)}`,
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

  const tournaments = (Array.isArray(raw) ? raw : [])
    .filter((t) => t && t.date && t.name)
    .map((t) => toTournament(t, opts.venueId));

  if (!tournaments.length) {
    throw new Error('Vision抽出結果が0件でした(告知画像ではなかった可能性があります)。');
  }

  if (opts.dryRun) {
    return { tournaments, stats: null };
  }

  const file = mergeLib.readDataJs(opts.dataJsPath);
  const before = file.arr;
  const { next, stats } = mergeLib.mergeStore(before, opts.venueId, tournaments, today);
  mergeLib.assertOnlyTargetChanged(before, next, opts.venueId, today);
  mergeLib.writeDataJs(opts.dataJsPath, file, next);

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
      `変更なし${stats.unchanged}/削除${stats.removed}/手入力の置き換え${stats.replacedManual.length}件/` +
      `残した手入力${stats.keptManual.length}件)。`
  );
  console.log('[import-venue-image] 忘れずに `node tools/gen-venue-pages.js .` を実行し、店舗静的ページを再生成してください。');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}

module.exports = { parseArgs, slugify, todayJstIso, toTournament, importVenueImage };
