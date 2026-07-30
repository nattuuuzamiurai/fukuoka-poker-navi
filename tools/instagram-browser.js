'use strict';
/**
 * instagram-browser.js
 *
 * Playwright(headless Chromium)でInstagramのプロフィール/投稿を開きスクリーンショットを撮る。
 * ログインは**毎回ユーザー名+パスワードでは行わない**。
 *
 * 【認証方式(社長個人のアカウントを使うための設計変更)】
 *   GitHub Actionsのランナーは既知のデータセンターIPレンジから通信するため、
 *   ユーザー名+パスワードで毎回ログインすると「異常なログイン試行」として二段階認証・
 *   本人確認チャレンジが高確率で発生し、(a) 巡回が失敗する (b) 社長個人のアカウントに
 *   「見慣れない場所からログインがありました」という本人向け警告が飛ぶ。
 *   そのため、**社長が普段使うブラウザで一度ログイン済みのセッションCookieを
 *   ヘッドレスブラウザに注入する**方式にしている。ログイン処理そのものは行わない。
 *
 * 【必要シークレット】`INSTAGRAM_SESSION_COOKIE`
 *   Playwrightの storageState 形式(`{ cookies: [...], origins: [...] }`)、または
 *   Cookie配列単体(`[{name,value,domain,path,...}, ...]`)のJSON文字列。
 *   取得方法(運用の想定): 社長が普段お使いのブラウザでInstagramにログインした状態から
 *   Cookieをエクスポートする(例: ブラウザ拡張でstorageStateやCookie一覧を書き出す)。
 *   エクスポートしたJSONをそのままこのシークレットの値として登録する。
 *   Cookieはいずれ失効する。失効時はログイン画面へのリダイレクト等で検知し、
 *   「ブロック」と同じ扱いで即座に中止・最優先報告に回す(下記 detectAuthWall)。
 *
 * 【ブロック検知したら突破しようとしない】
 *   ログイン要求・チャレンジ・レート制限などの兆候を検知したら、リトライや別経路を
 *   試さずその場で例外を投げて呼び出し側(sns-monitor-instagram.js)に処理を委ねる。
 *   呼び出し側は最優先報告(ダッシュボード)に回し、それ以上そのアカウントで
 *   Instagramへアクセスしない。
 */

// Playwright は実際にブラウザを操作する関数の中でのみ require する。
// (スケジューリング/マージ等の純粋ロジックの単体テストが、Playwright未インストールの
//  環境でも動くようにするため。トップレベルでは決して require しない。)
function loadPlaywright() {
  return require('playwright');
}

/** INSTAGRAM_SESSION_COOKIE(JSON文字列)を Playwright の storageState 形式に正規化する。 */
function parseStorageState(rawJson) {
  if (!rawJson) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`INSTAGRAM_SESSION_COOKIE をJSONとして解釈できません: ${e.message}`);
  }
  if (Array.isArray(parsed)) {
    return { cookies: parsed, origins: [] };
  }
  if (parsed && Array.isArray(parsed.cookies)) {
    return { cookies: parsed.cookies, origins: Array.isArray(parsed.origins) ? parsed.origins : [] };
  }
  throw new Error('INSTAGRAM_SESSION_COOKIE の形式が不正です(storageState形式かCookie配列を想定)。');
}

/**
 * ログイン要求・チャレンジ・レート制限らしき兆候を検知する。
 * 見つかったら { blocked: true, reason } を返す(呼び出し側が例外にして処理を止める)。
 */
async function detectAuthWall(page) {
  const url = page.url();
  if (/\/accounts\/login/.test(url)) {
    return { blocked: true, reason: `ログイン画面にリダイレクトされました(セッションCookie失効の可能性): ${url}` };
  }
  if (/\/challenge\//.test(url)) {
    return { blocked: true, reason: `本人確認チャレンジ画面が表示されました: ${url}` };
  }
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '').catch(() => '');
  const suspiciousPhrases = [
    'アカウントが一時的に制限されています',
    'このアカウントは無効になっています',
    '不審な行動が検出されました',
    'Try Again Later',
    "We restrict certain activity",
    'Please wait a few minutes',
  ];
  const hit = suspiciousPhrases.find((p) => bodyText.includes(p));
  if (hit) {
    return { blocked: true, reason: `ブロック・制限を示す文言を検出しました: 「${hit}」` };
  }
  return { blocked: false, reason: null };
}

/**
 * storageState を注入したブラウザコンテキストを開き、fn(context) を実行して必ず閉じる。
 * @template T
 * @param {string} storageStateJson INSTAGRAM_SESSION_COOKIE の生の値
 * @param {(context: import('playwright').BrowserContext) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withInstagramContext(storageStateJson, fn) {
  const { chromium } = loadPlaywright();
  const storageState = parseStorageState(storageStateJson);
  if (!storageState) throw new Error('INSTAGRAM_SESSION_COOKIE が空です。');

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 1600 },
      locale: 'ja-JP',
    });
    return await fn(context);
  } finally {
    await browser.close();
  }
}

/**
 * プロフィールを開き、フィード部分をスクリーンショットする(Buffer)。
 * ハイライト/ストーリーズは対象外(フィード投稿の監視のみ)。
 * ログイン要求等を検知したら例外を投げる(呼び出し側で最優先報告)。
 */
async function screenshotProfileFeed(context, handle) {
  const page = await context.newPage();
  await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(2000); // フィードの遅延読み込みを待つ(要調整)

  const wall = await detectAuthWall(page);
  if (wall.blocked) throw new AuthWallError(wall.reason);

  // フィードのグリッド部分だけを撮る(プロフィールヘッダーは不要)。
  // セレクタはInstagramのDOM変更で壊れうるため、見つからない場合はページ全体にフォールバックする。
  const feed = await page.$('main article, main section article, main');
  const target = feed || page;
  const screenshot = await target.screenshot({ type: 'png' });
  return { screenshot, page };
}

/**
 * フィードのグリッドから投稿のパーマリンク候補を新しい順に取得する(左上=最新の想定)。
 */
async function listRecentPostLinks(page, limit = 6) {
  const hrefs = await page.$$eval(
    'a[href*="/p/"], a[href*="/reel/"]',
    (as, lim) => as.slice(0, lim).map((a) => a.href),
    limit
  );
  // 重複除去(同じ投稿が複数リンクを持つDOM構造のことがある)
  return [...new Set(hrefs)];
}

class AuthWallError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'AuthWallError';
  }
}

module.exports = {
  parseStorageState,
  detectAuthWall,
  withInstagramContext,
  screenshotProfileFeed,
  listRecentPostLinks,
  AuthWallError,
};
