#!/usr/bin/env node
/**
 * fetch-search-console.js
 *
 * Google Search Console API(Search Analytics: query)から、対象プロパティの
 * クエリ別・ページ別パフォーマンス(クリック数・表示回数・CTR・平均掲載順位)を取得し、
 * `data/search-console/<実行日(JST)>.json` に保存する。
 *
 * このデータは分析用(マーケティング部のGEO/SEO監査)であり、サイト自体の表示には使わない。
 * `data.js`(表示用データ)とは完全に別系統なので、既存の取込みスクリプト
 * (import-waitinglist.js 等)の upsert・所有権ロジックとは一切関係しない
 * (毎回、新しい日付のファイルを増やしていくだけ。既存ファイルを書き換えない)。
 *
 * 【認証】サービスアカウント(GSCプロパティに「制限付き」権限で追加済み)。
 * 鍵の受け取り方は2通り(どちらか一方があればよい。両方あれば環境変数側を優先):
 *   - GSC_SERVICE_ACCOUNT_KEY  … 鍵ファイルの中身(JSON)をそのまま文字列で渡す(GitHub Actions用)
 *   - GOOGLE_APPLICATION_CREDENTIALS … 鍵ファイルへの【パス】(ローカル実行用)
 * 鍵の中身(private_key等)はログに一切出さない。エラー時もパス/存在有無のみ出す。
 *
 * 【依存ライブラリなし】このリポジトリの他のtools/*.jsと同じく、npmパッケージを使わない
 * (package.json/node_modulesが無く、CIもnpm installを行わない設計のため)。
 * `googleapis`は使わず、JWT Bearer Token Flow(RS256署名 + トークン交換)を
 * Node標準の crypto / fetch だけで実装する。
 *
 * 使い方:
 *   node tools/fetch-search-console.js                    … 直近28日分を取得して保存
 *   node tools/fetch-search-console.js --days=90           … 直近90日分
 *   node tools/fetch-search-console.js --site=<siteUrl>    … 既定(https://fukuokapoker.com/)以外を指定
 *   node tools/fetch-search-console.js --out-dir=<path>    … 保存先(既定: data/search-console)
 *   node tools/fetch-search-console.js --dry-run           … 取得・集計のみ行い、ファイルに書き込まない
 *
 * 【日付の扱い】Search Console のデータには反映まで数日のラグがあるため、
 * 期間の終端(endDate)は「実行日(JST)の3日前」にしている(GSC公式の目安に合わせた保守的な値)。
 * 保存するファイル名の日付は「取得を実行した日(JST)」であり、期間の終端日ではない
 * (毎週同じ曜日に実行すれば、ファイル名だけ見ても実行順が分かるようにするため)。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URI_DEFAULT = 'https://oauth2.googleapis.com/token';
const SEARCH_ANALYTICS_URL = (siteUrl) =>
  `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

const DEFAULT_SITE_URL = 'https://fukuokapoker.com/';
const DEFAULT_DAYS = 28;
const DATA_LAG_DAYS = 3; // GSCの反映ラグ分、期間の終端を実行日から後ろにずらす
const ROW_LIMIT = 5000; // 想定件数(このサイト規模)に対して十分大きい値。上限は仕様上25000

// ---------- 小道具 ----------

const pad2 = (n) => String(n).padStart(2, '0');

/** 実行日(JST)を YYYY-MM-DD で返す。*/
function todayJst() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

/** YYYY-MM-DD の日付を n日ずらした YYYY-MM-DD を返す(n は負でもよい)。*/
function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function parseArgs(argv) {
  const args = { days: DEFAULT_DAYS, site: DEFAULT_SITE_URL, outDir: null, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') { args.dryRun = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'days') args.days = Number(value);
    else if (key === 'site') args.site = value;
    else if (key === 'out-dir') args.outDir = value;
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    throw new Error(`--days は正の整数で指定してください(実際: ${JSON.stringify(args.days)})`);
  }
  return args;
}

// ---------- 認証(サービスアカウント JWT Bearer Token Flow) ----------

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

/** サービスアカウント鍵からアクセストークンを取得する(JWT Bearer Token Flow)。 */
async function getAccessToken(credentials) {
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('鍵ファイルに client_email / private_key が見つかりません(サービスアカウント鍵のJSONか確認してください)。');
  }
  const tokenUri = credentials.token_uri || TOKEN_URI_DEFAULT;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: credentials.client_email,
    scope: SCOPE,
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

// ---------- Search Console API ----------

/**
 * searchAnalytics.query を1回呼ぶ。
 * dimensions を省略(空配列)すると、期間全体を集計した1行(合計値)が返る。
 */
async function searchAnalyticsQuery(accessToken, siteUrl, { startDate, endDate, dimensions = [], rowLimit = ROW_LIMIT }) {
  const res = await fetch(SEARCH_ANALYTICS_URL(siteUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, dataState: 'all' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Search Console API 呼び出しに失敗しました(HTTP ${res.status}, dimensions=${JSON.stringify(dimensions)}): ${text}`);
  }
  return res.json();
}

function round(n, digits) {
  const p = 10 ** digits;
  return Math.round((n + Number.EPSILON) * p) / p;
}

/** APIの1行(keys/clicks/impressions/ctr/position)を扱いやすい形に正規化する。 */
function normalizeRow(row, dimensionLabel) {
  return {
    [dimensionLabel]: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round(row.ctr, 4),
    position: round(row.position, 2),
  };
}

/** dimensions:[] の応答(1行 or 0行)を totals 形式に正規化する。 */
function normalizeTotals(response) {
  const row = (response.rows || [])[0];
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round(row.ctr, 4),
    position: round(row.position, 2),
  };
}

// ---------- サマリー生成 ----------

/** 直前に保存済みの日付つきJSON(今回より前・最新のもの)を探す。無ければ null。 */
function findPreviousSnapshot(outDir, excludeFileName) {
  if (!fs.existsSync(outDir)) return null;
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== excludeFileName)
    .sort();
  if (files.length === 0) return null;
  const last = files[files.length - 1];
  try {
    return { fileName: last, data: JSON.parse(fs.readFileSync(path.join(outDir, last), 'utf8')) };
  } catch (e) {
    return null;
  }
}

function fmtDelta(curr, prev, digits) {
  if (prev === undefined || prev === null) return '';
  const d = round(curr - prev, digits);
  const sign = d > 0 ? '+' : '';
  return ` (前回比 ${sign}${d})`;
}

function buildSummaryMarkdown({ generatedAtJst, site, period, totals, queries, pages, previous }) {
  const topN = 20;
  const lines = [];
  lines.push(`# Search Console サマリー(${generatedAtJst} 取得)`);
  lines.push('');
  lines.push(`- 対象プロパティ: ${site}`);
  lines.push(`- 集計期間: ${period.startDate} 〜 ${period.endDate}(${period.days}日間)`);
  if (previous) {
    lines.push(`- 前回スナップショット: ${previous.fileName}(期間: ${previous.data.period?.startDate ?? '?'} 〜 ${previous.data.period?.endDate ?? '?'})`);
  } else {
    lines.push('- 前回スナップショット: なし(初回取得、または見つかりませんでした)');
  }
  lines.push('');
  lines.push('## 合計');
  lines.push('');
  const prevTotals = previous?.data?.totals;
  lines.push(`- クリック数: ${totals.clicks}${fmtDelta(totals.clicks, prevTotals?.clicks, 0)}`);
  lines.push(`- 表示回数: ${totals.impressions}${fmtDelta(totals.impressions, prevTotals?.impressions, 0)}`);
  lines.push(`- CTR: ${(totals.ctr * 100).toFixed(2)}%${prevTotals ? ` (前回 ${(prevTotals.ctr * 100).toFixed(2)}%)` : ''}`);
  lines.push(`- 平均掲載順位: ${totals.position}${prevTotals ? ` (前回 ${prevTotals.position})` : ''}`);
  lines.push('');

  lines.push(`## 上位クエリ(クリック数順・上位${topN})`);
  lines.push('');
  lines.push('| # | クエリ | クリック | 表示回数 | CTR | 平均順位 |');
  lines.push('|---|---|---|---|---|---|');
  queries.slice(0, topN).forEach((q, i) => {
    lines.push(`| ${i + 1} | ${q.query} | ${q.clicks} | ${q.impressions} | ${(q.ctr * 100).toFixed(2)}% | ${q.position} |`);
  });
  lines.push('');

  lines.push(`## 上位ページ(クリック数順・上位${topN})`);
  lines.push('');
  lines.push('| # | ページ | クリック | 表示回数 | CTR | 平均順位 |');
  lines.push('|---|---|---|---|---|---|');
  pages.slice(0, topN).forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.page} | ${p.clicks} | ${p.impressions} | ${(p.ctr * 100).toFixed(2)}% | ${p.position} |`);
  });
  lines.push('');

  return lines.join('\n');
}

// ---------- メイン ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const outDir = path.resolve(repoRoot, args.outDir || path.join('data', 'search-console'));

  const { credentials, source } = loadCredentials();
  console.log(`認証: ${source} を使用します(client_email=${credentials.client_email || '(不明)'})`);

  const runDateJst = todayJst();
  const endDate = shiftDate(runDateJst, -DATA_LAG_DAYS);
  const startDate = shiftDate(endDate, -(args.days - 1));
  const period = { startDate, endDate, days: args.days };

  console.log(`対象プロパティ: ${args.site}`);
  console.log(`集計期間: ${startDate} 〜 ${endDate}(${args.days}日間、反映ラグ${DATA_LAG_DAYS}日を考慮)`);

  const accessToken = await getAccessToken(credentials);

  const [totalsRes, queryRes, pageRes] = await Promise.all([
    searchAnalyticsQuery(accessToken, args.site, { startDate, endDate, dimensions: [] }),
    searchAnalyticsQuery(accessToken, args.site, { startDate, endDate, dimensions: ['query'] }),
    searchAnalyticsQuery(accessToken, args.site, { startDate, endDate, dimensions: ['page'] }),
  ]);

  const totals = normalizeTotals(totalsRes);
  const queries = (queryRes.rows || [])
    .map((r) => normalizeRow(r, 'query'))
    .sort((a, b) => b.clicks - a.clicks);
  const pages = (pageRes.rows || [])
    .map((r) => normalizeRow(r, 'page'))
    .sort((a, b) => b.clicks - a.clicks);

  console.log(`取得件数: クエリ ${queries.length}件 / ページ ${pages.length}件`);
  console.log(`合計: クリック ${totals.clicks} / 表示回数 ${totals.impressions} / CTR ${(totals.ctr * 100).toFixed(2)}% / 平均順位 ${totals.position}`);

  const output = {
    generatedAt: new Date().toISOString(),
    generatedAtJst: runDateJst,
    siteUrl: args.site,
    period,
    totals,
    queries,
    pages,
  };

  const jsonFileName = `${runDateJst}.json`;
  const summaryFileName = `${runDateJst}-summary.md`;
  const previous = findPreviousSnapshot(outDir, jsonFileName);
  const summaryMarkdown = buildSummaryMarkdown({
    generatedAtJst: runDateJst,
    site: args.site,
    period,
    totals,
    queries,
    pages,
    previous,
  });

  if (args.dryRun) {
    console.log('--dry-run のため、ファイルへの書き込みは行いません。');
    console.log('');
    console.log(summaryMarkdown);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, jsonFileName), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, summaryFileName), `${summaryMarkdown}\n`, 'utf8');
  console.log(`保存しました: ${path.join(outDir, jsonFileName)}`);
  console.log(`保存しました: ${path.join(outDir, summaryFileName)}`);
}

if (require.main === module) {
  main().then(
    () => { process.exitCode = 0; },
    (err) => {
      console.error(`失敗しました: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { parseArgs, todayJst, shiftDate, normalizeRow, normalizeTotals, buildSummaryMarkdown };
