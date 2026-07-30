'use strict';
/**
 * instagram-oembed.js
 *
 * 個別投稿1件ぶんの高精度スクリーンショットを、プロフィール全体のスクショではなく
 * **その投稿単体のoEmbed埋め込み**からレンダリングして撮る(Vision抽出の精度を上げるため)。
 *
 * 【2026年6月からトークン不要になったInstagram公式oEmbed】(要事前確認)
 *   GET https://www.facebook.com/instagram_oembed?url=<投稿URL>&omitscript=true
 *   → { html, thumbnail_url, ... }
 *   このタスクの前提では2026年6月からアプリトークン無しで叩けるようになったとされているが、
 *   実運用開始前に実際のレスポンス(200で `html` が返るか、トークンを要求されないか)を
 *   必ず確認すること。トークンが必要だった場合は `INSTAGRAM_OEMBED_ACCESS_TOKEN` のような
 *   シークレットを別途追加する前提で `ACCESS_TOKEN` 引数を用意してある(下記)。
 *
 * 【失敗時はフォールバック】
 *   oEmbedの取得・レンダリングに失敗しても、呼び出し側がすでに開いている投稿詳細ページ
 *   (ログイン済みブラウザで開いた本物のページ)をそのままスクリーンショットすれば
 *   Vision抽出は続行できる。ここで例外を投げるのではなく `null` を返し、
 *   呼び出し側(sns-monitor-instagram.js)がフォールバックする設計にしている。
 */

const OEMBED_ENDPOINT = 'https://www.facebook.com/instagram_oembed';

/**
 * oEmbed APIから埋め込みHTMLを取得する。失敗したら null を返す(投げない)。
 * @param {string} postUrl 投稿のパーマリンク(例: https://www.instagram.com/p/XXXXXXXXX/)
 * @param {{ accessToken?: string }} [opts]
 */
async function fetchOembedHtml(postUrl, opts = {}) {
  const params = new URLSearchParams({ url: postUrl, omitscript: 'true' });
  if (opts.accessToken) params.set('access_token', opts.accessToken);
  const res = await fetch(`${OEMBED_ENDPOINT}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  }).catch((e) => {
    console.error(`[instagram-oembed] oEmbed取得に失敗(フォールバックします): ${e.message}`);
    return null;
  });
  if (!res || res.status !== 200) {
    if (res) console.error(`[instagram-oembed] oEmbed取得に失敗(HTTP ${res.status})。フォールバックします。`);
    return null;
  }
  const json = await res.json().catch(() => null);
  if (!json || !json.html) {
    console.error('[instagram-oembed] oEmbedレスポンスに html がありません。フォールバックします。');
    return null;
  }
  return json.html;
}

/**
 * oEmbedの埋め込みHTMLをPlaywrightのページに描画してスクリーンショットする。
 * Instagramの埋め込みスクリプト(embed.js)がblockquoteをiframeに差し替えるのを待つ。
 * 失敗したら null を返す(投げない。呼び出し側でフォールバック)。
 */
async function renderOembedScreenshot(context, html) {
  const page = await context.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><body style="margin:0">${html}</body></html>`,
      { waitUntil: 'domcontentloaded' }
    );
    // embed.js が blockquote.instagram-media を iframe に差し替えるのを待つ
    await page.waitForSelector('iframe', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(2000);
    const target = (await page.$('iframe, blockquote.instagram-media')) || page;
    const screenshot = await target.screenshot({ type: 'png' }).catch(() => null);
    return screenshot;
  } catch (e) {
    console.error(`[instagram-oembed] 埋め込みのレンダリングに失敗(フォールバックします): ${e.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { fetchOembedHtml, renderOembedScreenshot };
