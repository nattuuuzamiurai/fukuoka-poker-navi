'use strict';
/**
 * gsc-auth.js
 *
 * Google Search Console API を使う複数のスクリプト(tools/fetch-search-console.js,
 * tools/submit-sitemap.js)が共有する認証ロジック(サービスアカウント鍵の読み込み・
 * JWT Bearer Token Flowでのアクセストークン取得)。元々は fetch-search-console.js に
 * 直接書かれていたが、sitemaps.submit(tools/submit-sitemap.js)を追加する際に
 * 重複実装を避けるためここに切り出した(2026-09-14)。
 *
 * 【依存ライブラリなし】このリポジトリの他の tools/*.js と同じく、npmパッケージを使わない
 * (package.json/node_modulesが無く、CIもnpm installを行わない設計のため)。
 * `googleapis`は使わず、Node標準の crypto / fetch だけで実装する。
 *
 * 【認証】サービスアカウント鍵の受け取り方は2通り(どちらか一方があればよい。両方あれば
 * 環境変数側を優先):
 *   - GSC_SERVICE_ACCOUNT_KEY  … 鍵ファイルの中身(JSON)をそのまま文字列で渡す(GitHub Actions用)
 *   - GOOGLE_APPLICATION_CREDENTIALS … 鍵ファイルへの【パス】(ローカル実行用)
 * 鍵の中身(private_key等)はログに一切出さない。エラー時もパス/存在有無のみ出す。
 *
 * 【スコープは呼び出し側が決める】fetch-search-console.js は読み取り専用(webmasters.readonly)、
 * submit-sitemap.js は書き込み系API(sitemaps.submit)を呼ぶため webmasters(フル)が必要。
 * そのためスコープはここに固定せず、getAccessToken() の引数で渡す。
 */

const fs = require('fs');
const crypto = require('crypto');

const TOKEN_URI_DEFAULT = 'https://oauth2.googleapis.com/token';

/**
 * サービスアカウント鍵が「環境変数として指定されているかどうか」だけを判定する(読み込みはしない)。
 * Secret未設定でもビルド/ワークフローを止めない設計のスクリプト(tools/fetch-photos.js等と同方針)が、
 * 「未設定なので安全にスキップ」と「設定されているが壊れている(エラーにすべき)」を区別するために使う。
 */
function credentialsConfigured() {
  const inlineJson = process.env.GSC_SERVICE_ACCOUNT_KEY;
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Boolean((inlineJson && inlineJson.trim()) || (keyPath && keyPath.trim()));
}

/** 鍵ファイルの中身(JSON)を、環境変数の2通りのどちらかから読み込む。中身をログに出さない。 */
function loadCredentials() {
  const inlineJson = process.env.GSC_SERVICE_ACCOUNT_KEY;
  if (inlineJson && inlineJson.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(inlineJson);
    } catch (e) {
      throw new Error('GSC_SERVICE_ACCOUNT_KEY の中身をJSONとして読み込めませんでした(値そのものはログに出しません)。');
    }
    return { credentials: parsed, source: 'GSC_SERVICE_ACCOUNT_KEY(環境変数)' };
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && keyPath.trim()) {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS が指すファイルが見つかりません: ${keyPath}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (e) {
      throw new Error(`鍵ファイルをJSONとして読み込めませんでした(パス: ${keyPath})。中身はログに出しません。`);
    }
    return { credentials: parsed, source: `GOOGLE_APPLICATION_CREDENTIALS(${keyPath})` };
  }

  throw new Error(
    'サービスアカウント鍵が見つかりません。GSC_SERVICE_ACCOUNT_KEY(JSON文字列)か ' +
    'GOOGLE_APPLICATION_CREDENTIALS(ファイルパス)のいずれかを環境変数に設定してください。'
  );
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** サービスアカウント鍵からアクセストークンを取得する(JWT Bearer Token Flow)。scope は呼び出し側が指定する。 */
async function getAccessToken(credentials, scope) {
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('鍵ファイルに client_email / private_key が見つかりません(サービスアカウント鍵のJSONか確認してください)。');
  }
  if (!scope) {
    throw new Error('getAccessToken(credentials, scope) には scope の指定が必須です。');
  }
  const tokenUri = credentials.token_uri || TOKEN_URI_DEFAULT;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: credentials.client_email,
    scope,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(credentials.private_key);
  const jwt = `${signingInput}.${signature.toString('base64url')}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`アクセストークンの取得に失敗しました(HTTP ${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('トークン応答に access_token がありませんでした。');
  }
  return data.access_token;
}

module.exports = { credentialsConfigured, loadCredentials, base64url, getAccessToken, TOKEN_URI_DEFAULT };
