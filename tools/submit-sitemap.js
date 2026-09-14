#!/usr/bin/env node
/**
 * submit-sitemap.js
 *
 * Google Search Console API の sitemaps.submit を呼び、対象プロパティ
 * (https://fukuokapoker.com/)に sitemap.xml の更新を通知する。
 *   PUT https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
 *
 * ★これは「特定URLのインデックス登録をリクエスト」とは別物(そちらのAPIは非公開)。
 *   あくまで「サイトマップを見に来てください」という軽い通知で、実際にいつ・どこまで
 *   クロールされるかはGoogle側の判断による(このスクリプトはそこまで保証しない)。
 *
 * 【認証】tools/fetch-search-console.js と同じサービスアカウント鍵(GSCプロパティに
 * アクセス権限が設定済み)を使う。鍵の読み込み・JWT署名・トークン交換は共通ロジックとして
 * tools/gsc-auth.js に切り出してあり、ここではそれを呼ぶだけ(重複実装しない)。
 *   - GSC_SERVICE_ACCOUNT_KEY  … 鍵ファイルの中身(JSON)をそのまま文字列で渡す(GitHub Actions用)
 *   - GOOGLE_APPLICATION_CREDENTIALS … 鍵ファイルへの【パス】(ローカル実行用)
 * 鍵の中身はログに一切出さない。
 *
 * ★スコープは fetch-search-console.js と違う: sitemaps.submit は書き込み系のAPIのため、
 *   読み取り専用スコープ(webmasters.readonly)では権限不足(403)になる。このスクリプトは
 *   フルスコープ(https://www.googleapis.com/auth/webmasters)でトークンを取得する。
 *
 * 【Secret未設定時の挙動】tools/fetch-photos.js 等と同じ設計方針: GSC_SERVICE_ACCOUNT_KEY /
 * GOOGLE_APPLICATION_CREDENTIALS のどちらも設定されていなければ、エラーにせず
 * 「スキップしました」とログを出して exit 0 にする(Secret未登録のCI・ローカルでも
 * ワークフローを止めない)。
 * 一方、鍵は設定されているのに壊れている場合(JSONとして読めない等)や、
 * API呼び出し自体が失敗した場合(認証エラー・ネットワークエラー・403等)は、
 * 原因究明が必要なので握りつぶさず exit 1 で落とす。
 *
 * 使い方:
 *   node tools/submit-sitemap.js                                … 既定(https://fukuokapoker.com/sitemap.xml)を送信
 *   node tools/submit-sitemap.js --site=<siteUrl> --sitemap=<sitemapUrl>  … 対象を変える場合
 *
 * 実行タイミング: .github/workflows/submit-sitemap.yml(週次 + workflow_dispatchで手動実行可)。
 */

'use strict';

const { credentialsConfigured, loadCredentials, getAccessToken } = require('./gsc-auth');

const SCOPE = 'https://www.googleapis.com/auth/webmasters'; // 書き込み系APIのためフルスコープが必要
const DEFAULT_SITE_URL = 'https://fukuokapoker.com/';
const DEFAULT_SITEMAP_URL = 'https://fukuokapoker.com/sitemap.xml';

function parseArgs(argv) {
  const args = { site: DEFAULT_SITE_URL, sitemap: DEFAULT_SITEMAP_URL };
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'site') args.site = value;
    else if (key === 'sitemap') args.sitemap = value;
  }
  return args;
}

/** sitemaps.submit のエンドポイントURL(siteUrl・sitemapUrlは両方ともURLエンコードする)。 */
function sitemapSubmitUrl(siteUrl, sitemapUrl) {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
}

/** sitemaps.submit を1回呼ぶ。成功時はHTTPステータスコードを返す。 */
async function submitSitemap(accessToken, siteUrl, sitemapUrl) {
  const res = await fetch(sitemapSubmitUrl(siteUrl, sitemapUrl), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sitemaps.submit の呼び出しに失敗しました(HTTP ${res.status}): ${text}`);
  }
  return res.status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Secret未設定でもワークフローを止めない: 他の同種スクリプト(tools/fetch-photos.js等)と同じ方針。
  if (!credentialsConfigured()) {
    console.log(
      '[submit-sitemap] GSC_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS が' +
      '未設定のため、sitemap再送信をスキップします。'
    );
    return;
  }

  const { credentials, source } = loadCredentials();
  console.log(`[submit-sitemap] 認証: ${source} を使用します(client_email=${credentials.client_email || '(不明)'})`);
  console.log(`[submit-sitemap] 対象プロパティ: ${args.site}`);
  console.log(`[submit-sitemap] 送信するsitemap: ${args.sitemap}`);

  const accessToken = await getAccessToken(credentials, SCOPE);
  const status = await submitSitemap(accessToken, args.site, args.sitemap);
  console.log(`[submit-sitemap] 送信しました(HTTP ${status})。Googleがいつ・どこまでクロールするかは保証されません。`);
}

if (require.main === module) {
  main().then(
    () => { process.exitCode = 0; },
    (err) => {
      console.error(`[submit-sitemap] 失敗しました: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { parseArgs, sitemapSubmitUrl, submitSitemap };
