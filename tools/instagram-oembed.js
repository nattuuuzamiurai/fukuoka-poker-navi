'use strict';
/**
 * instagram-oembed.js
 *
 * 店舗が「画像そのもの」ではなく「Instagramの投稿リンク」だけを送ってきた場合に備えた、
 * 公式oEmbed(認証不要)からその投稿のサムネイル画像を取得するための補助モジュール。
 * `tools/import-venue-image.js` の `--instagram-url` オプションから使う(任意機能)。
 *
 * 【スコープ】あくまで「リンクだけ届いた場合の代替入手経路」であり、ログイン・巡回は
 * 一切行わない(PR #13で中止したセッションCookie注入+検知回避の自動巡回とは無関係)。
 * ブラウザ操作も行わない — Facebookの公開APIへの1回のfetchと、返ってきた
 * サムネイルURLへの1回のfetchのみ。基本的には店舗から画像ファイルを直接送って
 * もらう(`--image`)運用を優先し、これは補助的な位置づけとする。
 *
 * 【2026年6月からトークン不要になったInstagram公式oEmbed】(要事前確認)
 *   GET https://www.facebook.com/instagram_oembed?url=<投稿URL>&omitscript=true
 *   → { html, thumbnail_url, thumbnail_width, thumbnail_height, ... }
 *   実運用開始前に実際のレスポンス(200で `thumbnail_url` が返るか)を確認すること。
 *   トークンが必要だった場合は環境変数 `INSTAGRAM_OEMBED_ACCESS_TOKEN` を渡せば使う。
 *
 * 【カルーセル投稿の制約】複数画像投稿の場合、oEmbedのサムネイルは先頭の1枚のみ。
 * 月間スケジュール画像が2枚目以降にある投稿では抽出漏れが起きうる
 * (店舗には「スケジュール画像を1枚目にしてください」と依頼するか、`--image` で
 * 画像を直接送ってもらう運用を優先すること)。
 */

const OEMBED_ENDPOINT = 'https://www.facebook.com/instagram_oembed';

/** oEmbed APIから埋め込み情報を取得する。失敗したら null を返す(投げない)。 */
async function fetchOembedInfo(postUrl, opts = {}) {
  const params = new URLSearchParams({ url: postUrl, omitscript: 'true' });
  const accessToken = opts.accessToken || process.env.INSTAGRAM_OEMBED_ACCESS_TOKEN;
  if (accessToken) params.set('access_token', accessToken);
  const res = await fetch(`${OEMBED_ENDPOINT}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  }).catch((e) => {
    console.error(`[instagram-oembed] oEmbed取得に失敗: ${e.message}`);
    return null;
  });
  if (!res || res.status !== 200) {
    if (res) console.error(`[instagram-oembed] oEmbed取得に失敗(HTTP ${res.status})`);
    return null;
  }
  return res.json().catch(() => null);
}

/**
 * 投稿の(先頭の)サムネイル画像をダウンロードする。
 * @param {string} postUrl 投稿のパーマリンク
 * @returns {Promise<Buffer>} 失敗時は例外を投げる(呼び出し側=CLIでエラー終了させるため)
 */
async function fetchThumbnailImage(postUrl, opts = {}) {
  const info = await fetchOembedInfo(postUrl, opts);
  if (!info || !info.thumbnail_url) {
    throw new Error(
      'oEmbedからサムネイルURLを取得できませんでした(非公開アカウント/削除済み/カルーセル2枚目以降の可能性)。' +
        '--image で画像ファイルを直接指定してください。'
    );
  }
  const res = await fetch(info.thumbnail_url, { signal: AbortSignal.timeout(20000) });
  if (res.status !== 200) throw new Error(`サムネイル画像の取得に失敗しました(HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { fetchOembedInfo, fetchThumbnailImage };
