#!/usr/bin/env node
/**
 * fetch-photos.js
 *
 * 店舗写真フェッチスクリプト(ホットペッパー グルメ Webサービス)。
 * 姉妹プロジェクト「久留米飲み屋ナビ」(scripts/fetch-photos.js)の移植。設計方針は同じ。
 *
 * fukuoka-venues.json の各店の "sources"(URL文字列の配列)からホットペッパーの
 * 店舗ID(strJxxxxxx)を正規表現で抽出し、ホットペッパー グルメAPIを **ID直接引き** で叩いて
 * 店の代表写真1枚(shop.photo.pc.l)、店のロゴ画像(shop.logo_image)、店舗ページURL(shop.urls.pc)
 * を収集する。
 *
 * 【なぜ店名検索を使わないか】店名の曖昧一致は別店舗の写真を誤掲載するリスクがあるため、
 * sources に登録済みのホットペッパー店舗IDでの直接引きのみに限定する(README準拠)。
 *
 * 【出力キーが v.id (data.js) である理由】
 *   fukuoka-venues.json は「実店の調査結果(原典)」であり、data.js の VENUES と違って
 *   id/slug を持たない(README: `fukuoka-venues.json` は `data.js` の VENUES の原典)。
 *   一方、この出力を読む gen-venue-pages.js は data.js の VENUES(v.id)を単位に動くため、
 *   fukuoka-venues.json の各店を **店名の完全一致** で data.js の VENUES に対応付けてから
 *   v.id をキーにする。完全一致は「別店舗の取り違え」が起きない一方、名前が一字でも
 *   ズレれば対応が取れず対象外になるだけ(誤爆ではなく取りこぼし側に倒れる)。
 *   対応が取れなかった店名は警告に出す(鳴らない失敗を作らない)。
 *
 * 出力: data/photos.generated.json  ( data.js の venue id -> { photo?, logo?, hpUrl } )
 *   - photo / logo はどちらか一方だけ登録されている店もある(存在するフィールドのみ書き出す)。
 *   - このファイルは .gitignore 対象(コミットしない)。CIで、静的ページを再生成するワークフロー
 *     (gen-venue-pages.js を呼ぶ全ジョブ)の中で毎回このスクリプトを先に走らせて生成する。
 *   - 画像ファイルは保存しない。URL(imgfp.hotp.jp)のみ(ホットリンク表示は gen-venue-pages.js 側)。
 *
 * APIキー: process.env.HOTPEPPER_API_KEY
 *   - 未設定なら **空マップを書き出して正常終了**(Secret未設定のCI・ローカルでもビルドが通る)。
 *   - キーはコード・コミット・ログに一切出さない(GitHub Secrets / 環境変数のみ)。
 *
 * 実行方法:
 *   HOTPEPPER_API_KEY=xxxx node tools/fetch-photos.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const VENUES_JSON = path.join(ROOT, 'fukuoka-venues.json');
const DATA_JS = path.join(ROOT, 'data.js');
const OUT_FILE = path.join(ROOT, 'data', 'photos.generated.json');

const API_BASE = 'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/';
// ホットペッパー店舗ID: URL中の /str<英字1文字+数字列> を拾う。例 strJ003736010 -> J003736010
const HP_ID_RE = /hotpepper\.jp\/str([A-Za-z]\d+)/i;
// レートに優しくするための逐次リクエスト間ウェイト(ms)。対象は数店なのですぐ終わる。
const SLEEP_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// ホットペッパーの「画像なし」共通ダミー画像を除外する(久留米飲み屋ナビと同じ判定)。
// logo_image は未登録店でもこのプレースホルダーが返るため、そのままロゴに使うと汎用の
// 「NO IMAGE」画像が表示されてしまう。実ロゴ・実写真はコンテンツ配信パス /IMGH/ 配下にあり、
// ダミーは /SYS/cmn/... の noimage 系なので、それらを弾く。
function isPlaceholderImage(u) {
  if (!u) return true;
  return /\/SYS\/cmn\//i.test(u) || /noimage|no_image|noimg|dummy/i.test(u);
}

// entry.sources(URL文字列の配列)からホットペッパー店舗IDを1件だけ拾う。無ければ null。
function extractHpId(sources) {
  for (const s of sources || []) {
    const m = String(s).match(HP_ID_RE);
    if (m) return m[1];
  }
  return null;
}

// fukuoka-venues.json の各店(名前のみで名寄せ)を data.js の VENUES(id)に対応付けて、
// { map: Map<venueId, hpId>, unmatched: string[](対応が取れなかった店名) } を返す。
// 店名は完全一致のみ(曖昧一致はしない — 上のファイル冒頭コメント参照)。
function collectHpIds(venuesJson, dataVenues) {
  const nameToId = new Map();
  for (const v of dataVenues || []) nameToId.set(v.name, v.id);

  const map = new Map();
  const unmatched = [];
  for (const entry of (venuesJson && venuesJson.venues) || []) {
    const hpId = extractHpId(entry.sources);
    if (!hpId) continue; // この店はホットペッパー未掲載(sourcesに無い) = 対象外
    const id = nameToId.get(entry.name);
    if (!id) {
      unmatched.push(entry.name);
      continue;
    }
    map.set(id, hpId);
  }
  return { map, unmatched };
}

// 「ネットワーク起因の失敗(リトライ対象)」を表すセンチネル。
// 正常応答で「写真なし」だった場合(=null)とは区別する。
const RETRY = Symbol('retry');

// ホットペッパーAPIをID直接引きで1回叩く。
//   成功(写真 or ロゴあり) -> { photo, logo, hpUrl }(無い方は空文字)
//   正常応答だが写真・ロゴなし/店舗なし -> null(リトライしない)
//   通信失敗・タイムアウト・非200 -> RETRY(呼び出し側で1回だけ再試行)
function fetchShopOnce(apiKey, hpId) {
  const params = new URLSearchParams({ key: apiKey, id: hpId, format: 'json' });
  const reqUrl = `${API_BASE}?${params.toString()}`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = https.get(reqUrl, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        // ステータスコードやレスポンスにキーが含まれることは無いが、
        // 念のため生レスポンスはログに出さない(万一の露出防止)。
        if (res.statusCode !== 200) {
          console.warn(`  [warn] ${hpId}: HTTP ${res.statusCode}`);
          return done(RETRY);
        }
        try {
          const data = JSON.parse(raw);
          const shop = data && data.results && data.results.shop && data.results.shop[0];
          if (!shop) return done(null);
          let photo = (shop.photo && shop.photo.pc && shop.photo.pc.l) || '';
          // ロゴ画像(shop.logo_image)。フル応答(type=lite以外)にのみ含まれる。
          // ID直接引きはフル応答なので取得できる。文字列でなければ無視する。
          let logo = (typeof shop.logo_image === 'string' && shop.logo_image) || '';
          // 「画像なし」ダミーは実素材として扱わない(汎用NO IMAGE画像の掲載を防ぐ)。
          if (isPlaceholderImage(photo)) photo = '';
          if (isPlaceholderImage(logo)) logo = '';
          // 写真・ロゴのどちらも無ければ「素材なし」= リトライ不要の null。
          if (!photo && !logo) return done(null);
          const hpUrl = (shop.urls && shop.urls.pc) || '';
          done({ photo, logo, hpUrl });
        } catch (e) {
          console.warn(`  [warn] ${hpId}: JSONパース失敗 (${e.message})`);
          done(RETRY);
        }
      });
    });
    req.on('error', (e) => {
      console.warn(`  [warn] ${hpId}: リクエスト失敗 (${e.message})`);
      done(RETRY);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      console.warn(`  [warn] ${hpId}: タイムアウト`);
      done(RETRY);
    });
  });
}

// ネットワーク起因の失敗のみ1回だけ再試行する(写真なしは再試行しない)。
async function fetchShop(apiKey, hpId) {
  let r = await fetchShopOnce(apiKey, hpId);
  if (r === RETRY) {
    await sleep(SLEEP_MS * 2);
    r = await fetchShopOnce(apiKey, hpId);
  }
  return r === RETRY ? null : r;
}

function writeEmptyMap() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({}, null, 2) + '\n', 'utf-8');
}

async function main() {
  const apiKey = process.env.HOTPEPPER_API_KEY;

  // Secret未設定でもビルドを止めない: 空マップを書いて正常終了。
  if (!apiKey) {
    console.log('[fetch-photos] HOTPEPPER_API_KEY が未設定のため、写真フェッチをスキップします(空マップを出力)。');
    writeEmptyMap();
    console.log(`[fetch-photos] ${path.relative(ROOT, OUT_FILE)} を出力しました(0件)。`);
    return;
  }

  const venuesJson = readJSON(VENUES_JSON);
  const { VENUES: dataVenues } = require(DATA_JS);
  const { map: hpIds, unmatched } = collectHpIds(venuesJson, dataVenues);
  if (unmatched.length) {
    console.warn(
      `[fetch-photos] fukuoka-venues.json にあるが data.js に同名の店が見つからず対象外: ${unmatched.join('、')}`
    );
  }
  console.log(`[fetch-photos] ホットペッパーID直接引き対象: ${hpIds.size}件`);

  const out = {};
  let photoCount = 0;
  let logoCount = 0;
  let i = 0;
  for (const [venueId, hpId] of hpIds) {
    i++;
    const result = await fetchShop(apiKey, hpId);
    if (result && (result.photo || result.logo)) {
      // 存在するフィールドだけを書き出す(photo だけ / logo だけの店もあるため差分を最小化)。
      const entry = {};
      if (result.photo) entry.photo = result.photo;
      if (result.logo) entry.logo = result.logo;
      if (result.hpUrl) entry.hpUrl = result.hpUrl;
      out[venueId] = entry;
      if (result.photo) photoCount++;
      if (result.logo) logoCount++;
    }
    if (i < hpIds.size) await sleep(SLEEP_MS);
  }

  // idソートで安定した出力にする(差分比較しやすく)。
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');

  console.log(`[fetch-photos] 写真取得できた店数: ${photoCount}件 / ロゴ取得できた店数: ${logoCount}件 / 対象 ${hpIds.size}件`);
  console.log(`[fetch-photos] ${path.relative(ROOT, OUT_FILE)} を出力しました。`);
}

if (require.main === module) {
  main().catch((e) => {
    // 予期しない例外でもビルド全体を止めないよう、空マップを保証したうえで非ゼロ終了はしない。
    console.warn(`[fetch-photos] 予期しないエラー: ${e.message}. 空マップを出力して続行します。`);
    try {
      writeEmptyMap();
    } catch (_) {
      /* ignore */
    }
  });
}

module.exports = { HP_ID_RE, isPlaceholderImage, extractHpId, collectHpIds };
