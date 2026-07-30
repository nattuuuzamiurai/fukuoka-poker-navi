'use strict';
/**
 * fetch-venue-posts-apify.js
 *
 * Apify(apify.com)の既製Instagramスクレイパー(pay-per-result、$1〜1.6/1000件)を呼び出し、
 * 指定したInstagramハンドルの最近の投稿一覧(画像URL・投稿日時・パーマリンク・キャプション)を取得する。
 *
 * 【経緯】以前検討したInstagram自動ログイン監視(PR #13、社長個人アカウントのセッションCookie注入＋
 * 検知回避を伴う設計)は経営管理オフィスの判断で中止した。Apifyは正規の第三者スクレイピングサービスの
 * pay-per-resultプランを従量課金で使うだけで、自社アカウントへのログインや検知回避のロジックは不要。
 *
 * 【使用Actor】Apify Instagram Post Scraper(既定 `apify/instagram-post-scraper`)。
 * `run-sync-get-dataset-items` エンドポイントを1回POSTするだけで、Actorの実行〜結果取得(同期)が完了する:
 *
 *   POST https://api.apify.com/v2/acts/<actorId>/run-sync-get-dataset-items?token=<APIFY_API_TOKEN>
 *   body: { "username": ["<handle>"], "resultsLimit": <件数> }
 *   → データセットの配列(1件=1投稿)。フィールド名はActorのバージョンにより変わりうる。
 *
 * ⚠ 要確認: Apify側のActor入出力スキーマは提供元の更新で変わることがある。実運用開始前に
 * (a) 実際に叩いて200が返ること、(b) レスポンスの各投稿にパーマリンク/画像URL/投稿日時/キャプションに
 * 相当するフィールドが実在すること、を確認すること。想定と異なる場合は normalizeApifyItem() の
 * フィールド名候補を調整する(呼び出し元のロジックには手を入れなくてよいよう分離してある)。
 *
 * 必要な環境変数: APIFY_API_TOKEN(未設定時は例外を投げて安全に終了する。コードには直書きしない)
 */

const APIFY_API_BASE = 'https://api.apify.com/v2';
const DEFAULT_ACTOR_ID = 'apify/instagram-post-scraper'; // 要確認: 運用開始前に実在するActor IDであることを確認すること
const DEFAULT_RESULTS_LIMIT = 12; // 直近の投稿何件を見るか。多すぎるとpay-per-resultの課金が嵩む
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Apifyのデータセット1件を { permalink, imageUrl, postedAt, caption } に正規化する。
 * 必須フィールド(パーマリンク・画像URL・投稿日時)が欠けているものは null を返す(呼び出し側で除外する)。
 */
function normalizeApifyItem(item) {
  if (!item || typeof item !== 'object') return null;

  const permalink = item.url || item.postUrl || item.permalink || null;
  const imageUrl =
    item.displayUrl ||
    item.imageUrl ||
    (Array.isArray(item.images) && item.images.length ? item.images[0] : null) ||
    item.thumbnailUrl ||
    null;
  const rawTimestamp = item.timestamp || item.takenAt || item.takenAtTimestamp || item.postedAt || null;
  const postedAtDate = rawTimestamp != null ? new Date(rawTimestamp) : null;
  const postedAt = postedAtDate && !Number.isNaN(postedAtDate.getTime()) ? postedAtDate.toISOString() : null;
  const caption =
    typeof item.caption === 'string' ? item.caption : typeof item.text === 'string' ? item.text : '';

  if (!permalink || !imageUrl || !postedAt) return null;
  return { permalink, imageUrl, postedAt, caption };
}

/**
 * 指定ハンドルの最近の投稿一覧をApify経由で取得する。
 * @param {string} handle Instagramのハンドル(@なし)
 * @param {{ apifyApiToken?: string, actorId?: string, resultsLimit?: number }} [opts]
 * @returns {Promise<Array<{permalink:string, imageUrl:string, postedAt:string, caption:string}>>}
 *   失敗時は例外を投げる(呼び出し側で「data.jsを書き換えずに終了」の判断に使うため)。
 */
async function fetchInstagramPosts(handle, opts = {}) {
  const token = opts.apifyApiToken || process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error('APIFY_API_TOKEN が未設定です(Apify呼び出しに必須)。');
  }
  if (!handle) {
    throw new Error('Instagramハンドルを指定してください。');
  }

  const actorId = opts.actorId || process.env.APIFY_ACTOR_ID || DEFAULT_ACTOR_ID;
  const resultsLimit = opts.resultsLimit || DEFAULT_RESULTS_LIMIT;
  const url = `${APIFY_API_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: [handle], resultsLimit }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200 && res.status !== 201) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apify呼び出しに失敗: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error('Apifyのレスポンス形式が想定外です(配列ではありません)。');
  }
  return items.map(normalizeApifyItem).filter(Boolean);
}

module.exports = {
  fetchInstagramPosts,
  normalizeApifyItem,
  DEFAULT_ACTOR_ID,
  DEFAULT_RESULTS_LIMIT,
  APIFY_API_BASE,
};
