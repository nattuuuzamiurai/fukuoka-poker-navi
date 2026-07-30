#!/usr/bin/env node
/**
 * import-waitinglist.js
 *
 * Waitinglist(DMMポーカーのイベントカレンダーの裏側)の公開APIから、
 * 対象店舗のトーナメント日程を取得して `data.js` の TOURNAMENTS に upsert する。
 *
 * 認証不要のJSON APIで、Origin/Refererを付けて叩くだけで取れる:
 *   GET https://api.waitinglist-poker.com/v1/game-schedules/tournament?storeId=<displayId>&limit=100&page=1
 *   → { totalRecords: number, tournaments: [...] }
 *
 * 使い方:
 *   node tools/import-waitinglist.js              … data.js を書き換える
 *   node tools/import-waitinglist.js --dry-run    … 書き込まず、差分サマリだけ出す
 *
 * 対象店舗を増やすときは下の STORES に1行足すだけでよい。
 *
 * 【安全弁】外部APIの一時障害でサイトのデータが消えるのを防ぐため、
 *   - fetch失敗 / HTTP 200以外 / ある店舗の取得件数が0件
 *   のいずれかが起きたら data.js を一切書き換えずに非ゼロ終了する。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// 店舗設定 — 1行足せば対象店舗を増やせる
//   venueId : data.js の VENUES における店舗ID
//   displayId: Waitinglist の storeId
// ============================================================
const STORES = [
  { venueId: 'v3', displayId: '4018492', label: "m HOLD'EM 中洲" },
  // 将来: v22/4012445 CRownCLown, v19/4039056 CASINO Arrows 小倉店,
  //       v26/4009265 POKER HOUSE JOKER, v27/4069478 THE DOJO,
  //       v33/4091897 Poker room SKY, v30/4050814 ARIA中洲
];

const API_BASE = 'https://api.waitinglist-poker.com/v1/game-schedules/tournament';
const PAGE_LIMIT = 100;          // APIのlimit上限
const PAGE_INTERVAL_MS = 1000;   // ページ間の待ち時間(礼儀)
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;          // 一時的な失敗のリトライ回数
const RETRY_BASE_MS = 3000;      // リトライ間隔(3秒 → 6秒)
const DATA_JS = path.join(__dirname, '..', 'data.js');

const DRY_RUN = process.argv.includes('--dry-run');

// ---------- 小道具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

/** UTCのISO文字列 → JSTの { date: 'YYYY-MM-DD', start: 'HH:MM' }。実行環境のTZに依存しない。 */
function toJst(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return {
    date: `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`,
    start: `${pad2(j.getUTCHours())}:${pad2(j.getUTCMinutes())}`,
  };
}

/** 今日(JST)の YYYY-MM-DD */
function todayJst() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

function fail(msg) {
  console.error(`[import-waitinglist] ERROR: ${msg}`);
  console.error('[import-waitinglist] data.js は書き換えていません。');
  process.exit(1);
}

// ---------- 取得 ----------

async function fetchPageOnce(displayId, page) {
  const url = `${API_BASE}?storeId=${encodeURIComponent(displayId)}&limit=${PAGE_LIMIT}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      Origin: 'https://poker.dmm.com',
      Referer: 'https://poker.dmm.com/',
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (page ${page})`);
  const json = await res.json();
  if (!json || !Array.isArray(json.tournaments)) throw new Error(`想定外のレスポンス形式 (page ${page})`);
  return json;
}

/** 一時的なネットワークエラー・レート制限で日次実行が落ちないよう、数回だけリトライする。 */
async function fetchPage(displayId, page) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchPageOnce(displayId, page);
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = RETRY_BASE_MS * attempt;
      console.warn(`[import-waitinglist] 取得失敗 (${attempt}/${MAX_ATTEMPTS}): ${e.message} — ${wait / 1000}秒後に再試行`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** 1店舗ぶんの全トーナメントを取得(ページング)。失敗は例外を投げる。 */
async function fetchStore(store) {
  const first = await fetchPage(store.displayId, 1);
  const total = Number(first.totalRecords) || first.tournaments.length;
  const all = [...first.tournaments];
  const pages = Math.ceil(total / PAGE_LIMIT);
  for (let p = 2; p <= pages; p++) {
    await sleep(PAGE_INTERVAL_MS);
    const res = await fetchPage(store.displayId, p);
    if (res.tournaments.length === 0) break;
    all.push(...res.tournaments);
  }
  // 念のためidで重複排除
  const seen = new Set();
  return all.filter((t) => {
    if (!t || !t.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// ---------- 変換 ----------

/**
 * APIのトーナメント1件 → data.js の Tournament スキーマ。
 * guarantee / prize はAPIに該当フィールドが無く、notesからの推測は誤りの温床なので常に null。
 * 「大型」タグは人間の判断が要るため自動付与しない。
 */
function toTournament(t, venueId) {
  const jst = toJst(t.startAt);
  if (!jst) return null;

  const tags = [];
  if (t.feature === 'ターボ') tags.push('ターボ');
  else if (t.feature === 'ディープ') tags.push('ディープ');
  if (t.gameRule === 'plo') tags.push('PLO');
  else if (t.gameRule === 'mix') tags.push('ミックス');

  const addon =
    Array.isArray(t.addons) && t.addons.length && t.addons[0] && t.addons[0].price != null
      ? Number(t.addons[0].price)
      : null;

  const reentry = Array.isArray(t.entries) && t.entries.some((e) => e && e.entryType === 'reEntry');

  return {
    id: `wl-${t.id}`,
    venueId,
    name: String(t.name || '').trim(),
    date: jst.date,
    start: jst.start,
    buyin: Number(t.registrationFee) || 0,
    addon,
    stack: Number(t.startingStack) || 0,
    guarantee: null,
    reentry,
    prize: null,
    tags,
    source: 'auto',
    verified: false,
  };
}

// ---------- data.js の読み書き ----------

const BLOCK_PREFIX = 'const TOURNAMENTS = ';

function readDataJs() {
  const src = fs.readFileSync(DATA_JS, 'utf8');
  const startIdx = src.indexOf(`${BLOCK_PREFIX}[`);
  if (startIdx < 0) fail('data.js に `const TOURNAMENTS = [` が見つかりません。');
  const endIdx = src.indexOf('\n];', startIdx);
  if (endIdx < 0) fail('data.js の TOURNAMENTS 配列の終端が見つかりません。');
  const jsonStart = startIdx + BLOCK_PREFIX.length;
  const jsonEnd = endIdx + 2; // '\n]' まで
  let arr;
  try {
    arr = JSON.parse(src.slice(jsonStart, jsonEnd));
  } catch (e) {
    fail(`TOURNAMENTS 配列をJSONとして解釈できません: ${e.message}`);
  }
  if (!Array.isArray(arr)) fail('TOURNAMENTS が配列ではありません。');
  return { src, arr, jsonStart, jsonEnd };
}

function writeDataJs(file, tournaments) {
  const out = file.src.slice(0, file.jsonStart) + JSON.stringify(tournaments, null, 2) + file.src.slice(file.jsonEnd);
  fs.writeFileSync(DATA_JS, out);
}

// ---------- upsert ----------

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 文字列の単純比較(ロケール非依存)。date/start はどちらも辞書順=時系列順になる書式。 */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDateStart = (a, b) => cmp(String(a.date), String(b.date)) || cmp(String(a.start), String(b.start));

/**
 * 1店舗ぶんのマージ。既存配列を破壊せず、新しい配列と統計を返す。
 *
 * ルール:
 *   - 過去日(today未満)のエントリは内容を一切変更しない
 *   - today以降: その店の source==='auto' は作り直す
 *   - today以降: 手入力(semi/manual)のうちAPIに同じ(date,start)があるものはAPI版に置き換える
 *   - today以降: 手入力のうちAPIに対応が無いものは残す(件数と内訳をログに出す)
 */
function mergeStore(all, store, apiEntries, today) {
  const existing = all.filter((t) => t.venueId === store.venueId);
  const past = existing.filter((t) => t.date < today);
  const future = existing.filter((t) => !(t.date < today));

  const future$ = apiEntries.filter((t) => t.date >= today).sort(byDateStart);
  const apiSlots = new Set(future$.map((t) => `${t.date} ${t.start}`));
  const apiById = new Map(future$.map((t) => [t.id, t]));

  const stats = { added: 0, updated: 0, unchanged: 0, removed: 0, keptManual: [], replacedManual: [] };

  // 既存の未来ぶんを仕分け
  const keptManual = [];
  for (const t of future) {
    if (t.source === 'auto') {
      if (!apiById.has(t.id)) stats.removed++; // APIから消えた = 中止/削除
      continue; // auto は丸ごと作り直すのでここでは残さない
    }
    if (apiSlots.has(`${t.date} ${t.start}`)) {
      stats.replacedManual.push(t);
    } else {
      keptManual.push(t);
      stats.keptManual.push(t);
    }
  }

  // API側の追加/更新/変更なしを数える
  const existingById = new Map(future.map((t) => [t.id, t]));
  for (const t of future$) {
    const prev = existingById.get(t.id);
    if (prev) {
      if (sameEntry(prev, t)) stats.unchanged++;
      else stats.updated++;
    } else if (apiSlots.has(`${t.date} ${t.start}`) && stats.replacedManual.some((m) => m.date === t.date && m.start === t.start)) {
      stats.updated++; // 手入力の置き換え
    } else {
      stats.added++;
    }
  }

  // 店舗ブロックを再構成(date → start 昇順)。過去日の中身は触らない。
  const block = [...past, ...keptManual, ...future$].sort(byDateStart);

  // 元の位置(その店の最初のエントリ位置)に差し込む。無ければ末尾。
  const firstIdx = all.findIndex((t) => t.venueId === store.venueId);
  const rest = all.filter((t) => t.venueId !== store.venueId);
  const insertAt = firstIdx < 0 ? rest.length : all.slice(0, firstIdx).filter((t) => t.venueId !== store.venueId).length;
  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];

  return { next, stats };
}

// ---------- main ----------

async function main() {
  const today = todayJst();
  console.log(`[import-waitinglist] 基準日(JST): ${today}${DRY_RUN ? ' / DRY-RUN' : ''}`);

  const file = readDataJs();
  const before = file.arr;
  const beforeJson = JSON.stringify(before);

  // 1) 先に全店ぶん取得しきる(途中失敗で中途半端に書き込まないため)
  const fetched = [];
  for (const store of STORES) {
    let raw;
    try {
      raw = await fetchStore(store);
    } catch (e) {
      fail(`${store.label} (storeId=${store.displayId}) の取得に失敗: ${e.message}`);
    }
    if (raw.length === 0) {
      fail(`${store.label} (storeId=${store.displayId}) のトーナメントが0件でした。API側の異常の可能性があるため中止します。`);
    }
    const mapped = raw.map((t) => toTournament(t, store.venueId)).filter(Boolean);
    if (mapped.length === 0) {
      fail(`${store.label} の変換結果が0件でした(startAtが不正?)。中止します。`);
    }
    console.log(`[import-waitinglist] ${store.label}: API ${raw.length}件 取得 / 変換 ${mapped.length}件 / うち ${today} 以降 ${mapped.filter((t) => t.date >= today).length}件`);
    fetched.push({ store, mapped });
  }

  // 2) マージ
  let arr = before;
  const allStats = [];
  for (const { store, mapped } of fetched) {
    const { next, stats } = mergeStore(arr, store, mapped, today);
    arr = next;
    allStats.push({ store, stats });
  }

  // 3) サマリ
  for (const { store, stats } of allStats) {
    console.log('');
    console.log(`[${store.label} / ${store.venueId}]`);
    console.log(
      `  追加 ${stats.added}件 / 更新 ${stats.updated}件 / 変更なし ${stats.unchanged}件 / ` +
        `削除(APIから消滅) ${stats.removed}件 / 手入力の置き換え ${stats.replacedManual.length}件 / ` +
        `API未掲載の手入力 ${stats.keptManual.length}件`
    );
    if (stats.replacedManual.length) {
      console.log(`  手入力→API版に置き換え ${stats.replacedManual.length}件:`);
      for (const t of stats.replacedManual) console.log(`    - ${t.date} ${t.start} ${t.name} (${t.id}, source=${t.source})`);
    }
    if (stats.keptManual.length) {
      console.log('  API未掲載のため残した手入力(APIに未登録か、中止された可能性。要目視確認):');
      for (const t of stats.keptManual) console.log(`    - ${t.date} ${t.start} ${t.name} (${t.id}, source=${t.source})`);
    }
  }

  // 4) 他店に影響が出ていないことの自己チェック
  const targets = new Set(STORES.map((s) => s.venueId));
  const others = (list) => list.filter((t) => !targets.has(t.venueId));
  if (JSON.stringify(others(before)) !== JSON.stringify(others(arr))) {
    fail('対象外の店舗のデータが変化しています(バグ)。書き込みを中止します。');
  }
  // 過去日のエントリが変化していないことも確認
  const pastOf = (list) => list.filter((t) => targets.has(t.venueId) && t.date < today);
  if (JSON.stringify(pastOf(before)) !== JSON.stringify(pastOf(arr))) {
    fail('過去日のエントリが変化しています(バグ)。書き込みを中止します。');
  }

  const changed = JSON.stringify(arr) !== beforeJson;
  console.log('');
  console.log(`[import-waitinglist] TOURNAMENTS 全体: ${before.length}件 → ${arr.length}件 / 変更${changed ? 'あり' : 'なし'}`);

  if (DRY_RUN) {
    console.log('[import-waitinglist] --dry-run のため data.js は書き換えていません。');
    return;
  }
  if (!changed) {
    console.log('[import-waitinglist] 変更が無いため data.js は書き換えていません。');
    return;
  }
  writeDataJs(file, arr);
  console.log('[import-waitinglist] data.js を更新しました。');
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
