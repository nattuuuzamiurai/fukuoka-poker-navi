#!/usr/bin/env node
/**
 * sns-monitor-instagram.js
 *
 * 公式サイトAPIが無い店舗(v40/v20/v18/v21/v34/v35)向けに、Instagramの投稿を監視して
 * 新しい月間スケジュール告知を検知し、`data.js` に自動反映する。
 *
 * 【全体の流れ(1店舗ぶん)】
 *   1. 巡回スケジュール判定(tools/sns-schedule.js) … 今日この店をチェックする日か、
 *      今この時間帯かを店舗ID+日付から決定論的に決める(スケジューリングロジック自体は
 *      ネットワークアクセスなしで動く。詳細は同ファイルのコメント参照)
 *   2. プロフィールを開きフィードをスクショ → Visionモデルで新着判定(tools/instagram-vision.js)
 *   3. 新着なら投稿のパーマリンクを特定 → oEmbedで個別投稿をレンダリングしてスクショ
 *      (tools/instagram-oembed.js。失敗時は開いているページを直接スクショにフォールバック)
 *   4. その画像をVisionモデルに渡しTournamentスキーマへ正規化
 *   5. 安全なupsert規則(tools/tournament-merge.js。PR #11と同じ設計)で `data.js` に反映
 *
 * 【安全弁】
 *   - シークレット(INSTAGRAM_SESSION_COOKIE)が無ければ何もせず終了する
 *   - ブロック・ログイン要求等を検知したら即座に中止し、以後このスクリプトは
 *     `sns-monitor-state.json` の `_pausedReason` が人手でクリアされるまで完全に停止する
 *     (再試行やブロック回避を試みない。詳細は README 参照)
 *   - `data.js` への書き込み直前に「対象店舗以外・過去日が変化していないか」を自己チェックする
 *
 * 使い方:
 *   node tools/sns-monitor-instagram.js                 … 通常実行(GitHub Actionsから毎時呼ばれる)
 *   node tools/sns-monitor-instagram.js --dry-run        … data.js / state を書き換えず実行する
 *   node tools/sns-monitor-instagram.js --schedule-only  … 今日チェック対象になる店舗だけ表示して終了
 *                                                          (ネットワークアクセス無し。CI動作確認用)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const schedule = require('./sns-schedule');
const merge = require('./tournament-merge');
const dashboard = require('./dashboard-report');

const REPO_ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'sns-monitor-state.json');
const DATA_JS = path.join(REPO_ROOT, 'data.js');

const DRY_RUN = process.argv.includes('--dry-run');
const SCHEDULE_ONLY = process.argv.includes('--schedule-only');

// 店舗間で連続アクセスしないための遅延(独立したランダム値)
const MIN_INTER_STORE_DELAY_MS = 60 * 1000;
const MAX_INTER_STORE_DELAY_MS = 5 * 60 * 1000;

// ---------- 小道具 ----------

const pad2 = (n) => String(n).padStart(2, '0');
function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function todayJstIso() {
  // テスト専用のフック(結合テストで「今日」を固定するため)。本番では未設定=実際の日付を使う。
  if (process.env.SNS_MONITOR_FAKE_TODAY_JST) return process.env.SNS_MONITOR_FAKE_TODAY_JST;
  const j = nowJst();
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}
function currentHourJst() {
  // テスト専用のフック(結合テストで「今の時間帯」を固定するため)。
  if (process.env.SNS_MONITOR_FAKE_HOUR_JST) return Number(process.env.SNS_MONITOR_FAKE_HOUR_JST);
  return nowJst().getUTCHours();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'post';
}

function loadRawState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}
function saveRawState(raw) {
  if (DRY_RUN) {
    console.log('[sns-monitor] --dry-run のため sns-monitor-state.json は書き換えません。');
    return;
  }
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(raw, null, 2)}\n`);
}
function storeEntries(raw) {
  return Object.entries(raw).filter(([k]) => !k.startsWith('_'));
}

// ---------- 1店舗ぶんのチェック ----------

/**
 * @returns {Promise<{ nextState: object, alert: object|null }>}
 */
async function checkStore(venueId, storeState, today, libs) {
  const { browserLib, oembedLib, visionLib } = libs;
  const dryRun = 'dryRun' in libs ? libs.dryRun : DRY_RUN;
  const dataJsPath = libs.dataJsPath || DATA_JS;

  return browserLib.withInstagramContext(process.env.INSTAGRAM_SESSION_COOKIE, async (context) => {
    const { screenshot: feedShot, page: profilePage } = await browserLib.screenshotProfileFeed(context, storeState.handle);
    const detection = await visionLib.detectNewPost(feedShot, { lastFoundPostDate: storeState.lastFoundPostDate });

    if (!detection.hasNewPost || !detection.isScheduleAnnouncement) {
      return finishAsMiss(venueId, storeState, today);
    }

    const postIndex = typeof detection.postIndex === 'number' && detection.postIndex >= 0 ? detection.postIndex : 0;
    const links = await browserLib.listRecentPostLinks(profilePage, postIndex + 1);
    const permalink = links[postIndex] || links[0];
    if (!permalink) {
      console.log(`[sns-monitor] ${venueId}: Visionは新着と判定しましたが、パーマリンクを特定できませんでした。今回は見送り扱いにします。`);
      return finishAsMiss(venueId, storeState, today);
    }

    const postPage = await context.newPage();
    await postPage.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const wall = await browserLib.detectAuthWall(postPage);
    if (wall.blocked) throw new browserLib.AuthWallError(wall.reason);
    const finalUrl = postPage.url();

    let postShot = null;
    const html = await oembedLib.fetchOembedHtml(finalUrl).catch((e) => {
      console.error(`[sns-monitor] ${venueId}: oEmbed取得で例外(フォールバックします): ${e.message}`);
      return null;
    });
    if (html) postShot = await oembedLib.renderOembedScreenshot(context, html);
    if (!postShot) {
      console.log(`[sns-monitor] ${venueId}: oEmbedが使えなかったため、開いている投稿ページを直接スクリーンショットします(フォールバック)。`);
      postShot = await postPage.screenshot({ type: 'png' });
    }

    // 投稿の実際の掲載日時はDOMから安定して取れないことが多いため、「発見できた日」を基準にする。
    const foundDateIso = today;
    const rawTournaments = await visionLib.extractTournaments(postShot, { postedDateHint: foundDateIso });

    if (!rawTournaments.length) {
      console.log(`[sns-monitor] ${venueId}: Vision抽出が0件でした(告知画像ではなかった可能性)。今回は見送り扱いにします。`);
      return finishAsMiss(venueId, storeState, today);
    }

    const tournaments = rawTournaments
      .filter((t) => t && t.date && t.name)
      .map((t) => ({
        id: `ig-${venueId}-${t.date}-${String(t.start || '0000').replace(':', '')}-${slugify(t.name)}`,
        venueId,
        name: String(t.name).trim(),
        date: t.date,
        start: t.start || '00:00',
        buyin: t.buyin != null ? Number(t.buyin) : 0,
        addon: t.addon != null ? Number(t.addon) : null,
        stack: t.stack != null ? Number(t.stack) : 0,
        guarantee: t.guarantee != null ? Number(t.guarantee) : null,
        reentry: t.reentry === 'late' ? 'late' : Boolean(t.reentry),
        prize: t.prize || null,
        tags: Array.isArray(t.tags) ? t.tags : [],
        source: 'auto',
        verified: false,
      }));

    if (!dryRun) {
      const file = merge.readDataJs(dataJsPath);
      const before = file.arr;
      const { next, stats } = merge.mergeStore(before, venueId, tournaments, today);
      merge.assertOnlyTargetChanged(before, next, venueId, today);
      merge.writeDataJs(dataJsPath, file, next);
      console.log(
        `[sns-monitor] ${venueId}: data.js を更新しました(追加${stats.added}/更新${stats.updated}/` +
          `変更なし${stats.unchanged}/削除${stats.removed}/手入力の置き換え${stats.replacedManual.length}件)。`
      );
    } else {
      console.log(`[sns-monitor] ${venueId}: --dry-run のため data.js は書き換えていません(抽出 ${tournaments.length}件)。`);
    }

    const nextState = { ...schedule.recordFound(storeState, foundDateIso, finalUrl), lastAttemptDate: today };
    return { nextState, alert: null };
  });
}

function finishAsMiss(venueId, storeState, today) {
  const { state: nextState, shouldReportMiss, shouldReportCycleGiveUp } = schedule.recordMissAttempt(storeState, today);
  let alert = null;
  if (shouldReportCycleGiveUp) {
    alert = {
      venueId,
      type: 'cycle_give_up',
      message:
        `猶予期間(missThresholdDate=${storeState.missThresholdDate} + ${schedule.GRACE_DAYS}日)を過ぎても` +
        `新しい告知が見つかりませんでした(連続未検出 ${nextState.consecutiveMisses}回目)。次サイクルへ回します。`,
    };
  } else if (shouldReportMiss) {
    alert = {
      venueId,
      type: 'missed_deadline',
      message: `missThresholdDate(${storeState.missThresholdDate})を過ぎても新しい告知が見つかっていません。`,
    };
  }
  return { nextState, alert };
}

// ---------- main ----------

async function main() {
  const today = todayJstIso();
  const hour = currentHourJst();
  const raw = loadRawState();

  if (raw._pausedReason) {
    console.log(`[sns-monitor] 一時停止中のため何もしません: ${raw._pausedReason}`);
    console.log(
      '[sns-monitor] Cookie失効・ブロック等の原因に対処したうえで、sns-monitor-state.json の ' +
        '_pausedReason を null に戻し、コミットしてから運用を再開してください。'
    );
    return;
  }

  const due = storeEntries(raw)
    .filter(([venueId, s]) => schedule.shouldCheckToday(s, today, venueId) && schedule.isTargetHourReached(venueId, today, hour))
    .map(([venueId]) => venueId);

  console.log(`[sns-monitor] 基準日(JST): ${today} ${hour}時台 / 巡回対象: ${due.length ? due.join(', ') : '(なし)'}`);

  if (SCHEDULE_ONLY) {
    console.log('[sns-monitor] --schedule-only のためここで終了します(ネットワークアクセスなし)。');
    return;
  }
  if (due.length === 0) return;

  if (!process.env.INSTAGRAM_SESSION_COOKIE) {
    console.log('[sns-monitor] INSTAGRAM_SESSION_COOKIE が未設定のため、何もせず終了します。');
    return;
  }

  // Playwright / Vision呼び出しはここで初めてrequireする(未インストールの環境でも
  // --schedule-only 等の純粋ロジックは動くようにするため)。
  const browserLib = require('./instagram-browser');
  const oembedLib = require('./instagram-oembed');
  const visionLib = require('./instagram-vision');

  for (const venueId of due) {
    const delay = MIN_INTER_STORE_DELAY_MS + Math.floor(Math.random() * (MAX_INTER_STORE_DELAY_MS - MIN_INTER_STORE_DELAY_MS));
    console.log(`[sns-monitor] ${venueId}: ${Math.round(delay / 1000)}秒待機してから確認します。`);
    await sleep(delay);

    try {
      const { nextState, alert } = await checkStore(venueId, raw[venueId], today, {
        browserLib,
        oembedLib,
        visionLib,
        dryRun: DRY_RUN,
        dataJsPath: DATA_JS,
      });
      raw[venueId] = nextState;
      if (alert) {
        await dashboard.reportAlert(alert).catch((e) => console.error(`[sns-monitor] ダッシュボードへの報告に失敗: ${e.message}`));
      }
      saveRawState(raw); // 1店舗ごとに保存(途中失敗で他店の進捗を失わないため)
    } catch (e) {
      console.error(`[sns-monitor] ${venueId} の処理中にエラー: ${e.stack || e.message}`);
      const isAuthWall = e && e.name === 'AuthWallError';
      await dashboard
        .reportAlert({
          venueId,
          type: isAuthWall ? 'block_suspected' : 'unexpected_error',
          message: isAuthWall ? e.message : `想定外のエラー: ${e.message}`,
        })
        .catch((e2) => console.error(`[sns-monitor] ダッシュボードへの報告に失敗: ${e2.message}`));

      if (isAuthWall) {
        raw._pausedReason = `${new Date().toISOString()} ${venueId}: ${e.message}`;
        saveRawState(raw);
        console.error('[sns-monitor] ブロック兆候を検知したため、以降の店舗も含めて今回の実行を中止し、次回以降は一時停止します。');
        process.exitCode = 1;
        break;
      }
      process.exitCode = 1;
      // このストアは lastAttemptDate を更新しない(次回また抽選対象にできるように)まま次店舗へ。
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}

module.exports = { checkStore, finishAsMiss, todayJstIso, currentHourJst, slugify };
