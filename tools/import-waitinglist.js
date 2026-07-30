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
 *   node tools/import-waitinglist.js               … data.js を書き換える
 *   node tools/import-waitinglist.js --dry-run     … 書き込まず、差分サマリだけ出す
 *   node tools/import-waitinglist.js --allow-shrink… 件数の急減ガードを外して実行する
 *                                                    (閉店・長期休業など正当な大幅減のとき人が明示的に通す)
 *
 * 対象店舗を増やすときは下の STORES に1行足すだけでよい。
 *
 * 【安全弁】外部APIの一時障害でサイトのデータが消えるのを防ぐため、次のいずれかが起きたら
 * data.js を一切書き換えずに非ゼロ終了する。「HTTP 200だが中身が壊れている」部分障害も止める:
 *   1. fetch失敗 / HTTP 200以外 / レスポンス形状が想定外
 *   2. ある店舗の取得件数が0件
 *   3. ページング不整合(totalRecords に対して実取得件数が足りない = 途中で切れている)
 *   4. 別店舗のデータ混入(store.displayId が要求した storeId と違う)
 *   5. 今日以降の件数が前回の半分未満に急減(部分障害・過去日のみ返却などを検出。--allow-shrink で解除)
 *   6. 書き込み直前の自己チェック(対象外店舗・過去日エントリが変化していないか)
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
  //
  // 将来の候補(APIに掲載があることは確認済み)。有効化は「data.jsの店名 = APIの店名」を
  // 目視で確かめてから行うこと。venueIdを取り違えるとよその店の日程を掲載してしまう。
  //
  //   [店名が一致・そのまま有効化してよい]
  //   { venueId: 'v22', displayId: '4012445', label: 'CRownCLown' },
  //   { venueId: 'v19', displayId: '4039056', label: 'CASINO Arrows 小倉店' },
  //   { venueId: 'v27', displayId: '4069478', label: 'THE DOJO' },
  //   { venueId: 'v33', displayId: '4091897', label: 'Poker room SKY' },
  //
  //   [要確認・店名が一致しないので人の確認が必要]
  //   v26 / 4009265 … data.jsは「JOKER♠️ 福岡大橋」、API店名は "POKER HOUSE JOKER"。同一店か未確認
  //   v30 / 4050814 … data.jsは「ARIA 中洲」、API店名は "Aria" で登録1件のみ。同一店か未確認
];

const API_BASE = 'https://api.waitinglist-poker.com/v1/game-schedules/tournament';
const PAGE_LIMIT = 100;          // APIのlimit上限
const PAGE_INTERVAL_MS = 1000;   // ページ間の待ち時間(礼儀)
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;          // 一時的な失敗のリトライ回数
const RETRY_BASE_MS = 3000;      // リトライ間隔(3秒 → 6秒)
const DATA_JS = path.join(__dirname, '..', 'data.js');

const DRY_RUN = process.argv.includes('--dry-run');
// 件数の急減ガードを人の判断で外すためのフラグ(閉店・長期休業など正当な減少のとき)
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');
const SHRINK_RATIO = 0.5; // 今日以降の件数が「前回 × この比率」を下回ったら止める

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

/**
 * 1店舗ぶんの全トーナメントを取得(ページング)。失敗は例外を投げる。
 *
 * 「HTTP 200だが中身が足りない」部分障害を通さないため、最後に totalRecords と
 * 実際の取得件数を突き合わせる。2ページ目が空で返るケース(=途中で切れる)も
 * ここで検出され、黙って件数が減ることはない。
 */
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
  const uniq = all.filter((t) => {
    if (!t || !t.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // ページング不整合(=部分障害)の検出。宣言された総件数に届いていなければ信用しない。
  if (all.length < total) {
    throw new Error(`ページング不整合: totalRecords=${total} に対し ${all.length}件しか取得できませんでした`);
  }
  return uniq;
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

  // addons[] は「アドオン」専用の配列ではなく、リバイや参加費違いの枠も入っている。
  // 例: m GLORY の addons[0] は addonName:"リバイ"/price 2000 で、そのまま使うとサイトに
  //     「+AO ¥2,000」と誤表示される。addonName が明示的にアドオンのものだけを採用する。
  const addonEntry = (Array.isArray(t.addons) ? t.addons : [])
    .find((a) => a && a.price != null && /アドオン|add[- ]?on/i.test(a.addonName || ''));
  const addon = addonEntry ? Number(addonEntry.price) : null;

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
 * APIが供給できる(=毎回上書きしてよい)タグ語彙。
 * これ以外のタグ(バウンティ / 特別開催 / サテライト / 大型 など)は人間が付けたものなので、
 * 置き換え時に消さずに引き継ぐ。
 */
const API_OWNED_TAGS = ['ターボ', 'ディープ', 'PLO', 'ミックス'];

/**
 * APIから作った新エントリに、既存エントリが持っていた「APIが供給できない情報」を引き継ぐ。
 * 対象は guarantee(GTD) / prize / 人間が付けたタグ。
 * 引き継ぎ元は「同じidの既存auto」と「同じ(date,start)の手入力」の両方(前者を優先)。
 *
 * これが無いと、初回の置き換えでGTDやバウンティ等が消え、さらに毎日の再生成で
 * 人が後から足した情報も翌朝には消えてしまう(冪等性のためにも必須)。
 */
function carryOver(next, prevs) {
  let guarantee = null;
  let prize = null;
  const humanTags = [];
  for (const p of prevs) {
    if (!p) continue;
    if (guarantee == null && p.guarantee != null) guarantee = p.guarantee;
    if (prize == null && p.prize != null) prize = p.prize;
    for (const tag of p.tags || []) {
      if (!API_OWNED_TAGS.includes(tag)) humanTags.push(tag);
    }
  }
  return { ...next, guarantee, prize, tags: [...new Set([...next.tags, ...humanTags])] };
}

/**
 * 1店舗ぶんのマージ。既存配列を破壊せず、新しい配列と統計を返す。
 *
 * ルール:
 *   - 過去日(today未満)のエントリは内容を一切変更しない
 *   - today以降: その店の source==='auto' は作り直す(ただし上記 carryOver で人手情報は温存)
 *   - today以降: 手入力(semi/manual)のうちAPIに同じ(date,start)があるものはAPI版に置き換える
 *   - today以降: 手入力のうちAPIに対応が無いものは残す(件数と内訳をログに出す)
 */
function mergeStore(all, store, apiEntries, today) {
  const slotOf = (t) => `${t.date} ${t.start}`;

  const existing = all.filter((t) => t.venueId === store.venueId);
  const past = existing.filter((t) => t.date < today);
  const future = existing.filter((t) => !(t.date < today));

  const rawFuture = apiEntries.filter((t) => t.date >= today).sort(byDateStart);
  const apiSlots = new Set(rawFuture.map(slotOf));
  const apiById = new Map(rawFuture.map((t) => [t.id, t]));

  const existingAutoById = new Map(future.filter((t) => t.source === 'auto').map((t) => [t.id, t]));
  // 手入力を (date,start) で引けるようにする。同じ枠に複数あればすべて対象。
  const manualsBySlot = new Map();
  for (const t of future) {
    if (t.source === 'auto') continue;
    const k = slotOf(t);
    if (!manualsBySlot.has(k)) manualsBySlot.set(k, []);
    manualsBySlot.get(k).push(t);
  }

  const stats = { added: 0, updated: 0, unchanged: 0, removed: 0, carried: 0, keptManual: [], replacedManual: [] };

  // API側を1件ずつ確定させる(既存の情報を引き継ぎながら)
  const future$ = [];
  for (const raw of rawFuture) {
    const prevAuto = existingAutoById.get(raw.id) || null;
    const prevManuals = manualsBySlot.get(slotOf(raw)) || [];
    const entry = carryOver(raw, [prevAuto, ...prevManuals]);
    future$.push(entry);
    if (!sameEntry(entry, raw)) stats.carried++;

    if (prevAuto) {
      if (sameEntry(prevAuto, entry)) stats.unchanged++;
      else stats.updated++;
      if (prevManuals.length) stats.replacedManual.push(...prevManuals);
    } else if (prevManuals.length) {
      stats.updated++;
      stats.replacedManual.push(...prevManuals);
    } else {
      stats.added++;
    }
  }

  // 既存の未来ぶんの後始末
  const keptManual = [];
  for (const t of future) {
    if (t.source === 'auto') {
      if (!apiById.has(t.id)) stats.removed++; // APIから消えた = 中止/削除
      continue; // auto は丸ごと作り直すのでここでは残さない
    }
    if (!apiSlots.has(slotOf(t))) {
      keptManual.push(t);
      stats.keptManual.push(t);
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

    // 店舗の同一性検証。storeIdが無視されて別店舗が返ってきた場合に、
    // よその店のトーナメントをこの店として書き込んでしまうのを防ぐ。
    const wrong = raw.find((t) => t.store && t.store.displayId && String(t.store.displayId) !== String(store.displayId));
    if (wrong) {
      fail(`${store.label}: 別店舗(displayId=${wrong.store.displayId} / ${wrong.store.name})のデータが混入しています。中止します。`);
    }

    const mapped = raw.map((t) => toTournament(t, store.venueId)).filter(Boolean);
    if (mapped.length === 0) {
      fail(`${store.label} の変換結果が0件でした(startAtが不正?)。中止します。`);
    }

    // 「今日以降の件数が急に半分未満に減った」= API側の部分障害を疑う。
    // HTTP 200で中身だけ欠けている応答(件数が足りない / 過去日しか返らない 等)はここで止まる。
    // 閉店・長期休業など正当な大幅減のときは --allow-shrink で人が明示的に通す。
    const prevFuture = before.filter((t) => t.venueId === store.venueId && t.date >= today).length;
    const nextFuture = mapped.filter((t) => t.date >= today).length;
    if (!ALLOW_SHRINK && prevFuture > 0 && nextFuture < Math.ceil(prevFuture * SHRINK_RATIO)) {
      fail(
        `${store.label}: 今日以降の件数が ${prevFuture}件 → ${nextFuture}件 と急減。` +
          'API側の部分障害の可能性があるため中止します(意図した減少なら --allow-shrink)。'
      );
    }

    console.log(`[import-waitinglist] ${store.label}: API ${raw.length}件 取得 / 変換 ${mapped.length}件 / うち ${today} 以降 ${nextFuture}件(前回 ${prevFuture}件)`);
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
    console.log(`  うち人手情報(GTD/プライズ/人手タグ)を引き継いだもの ${stats.carried}件`);
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
