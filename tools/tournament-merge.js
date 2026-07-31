'use strict';
/**
 * tournament-merge.js
 *
 * `data.js` の `TOURNAMENTS` 配列に、1店舗ぶんの取得結果を安全に upsert するための
 * 共通ロジック。**PR #11(`feat/waitinglist-auto-import` / `tools/import-waitinglist.js`)の
 * 安全設計(upsert規則・安全弁)をそのまま踏襲**している。
 *
 * 【由来】
 *   もともとPR #13(Instagram自動巡回・中止)で切り出したモジュール。Instagram巡回自体は
 *   セッションCookie注入+検知回避を伴う設計だったため中止したが、この upsert ロジック自体は
 *   取得元に依存しない汎用部分なのでそのまま残す。
 *
 * 【★このモジュールを require しているのは誰か(2026-08-01 時点の事実)★】
 *   ・`tools/import-venue-image.js` … 店舗から直接届いたスケジュール画像の取込み
 *   ・`tools/monitor-instagram-apify.js` … Instagram投稿の日次自動監視
 *   この2つ【だけ】である。
 *
 *   【Waitinglist取込み(`tools/import-waitinglist.js`)は使っていない】
 *   同ファイルは自前の `mergeStore` を持つ【別実装】で、このモジュールを require していない。
 *   したがってここを変更してもWaitinglist取込みには影響しない(逆も同じ)。
 *
 *   ※以前このヘッダには「`main` に `import-waitinglist.js` は存在しない」「現在は
 *     `import-venue-image.js` が使う」と書かれていたが、どちらも既に事実と違っていた。
 *     この陳腐化した記述が「Waitinglistとロジックを共有している」という誤解を生んだため、
 *     2026-08-01 に事実で書き直した。**利用箇所を増減させたらここも必ず直すこと。**
 *
 * 【重複コードについて(将来のTODO)】
 *   `import-waitinglist.js` の `mergeStore` とこのモジュールは、同じ upsert規則を
 *   別々に実装している。統合すれば重複は消えるが、統合そのものが「両方の取込み経路を
 *   同時に壊しうる変更」になるため、着手するなら単独のPRで行うこと。
 *
 * 【この店(venueId)以外・過去日には一切触れない】(PR #11と同じ upsert規則)
 *   1. 過去日(JST基準の今日より前)のエントリは一切触らない
 *   2. 対象店舗の source==='auto' の今日以降のエントリは毎回作り直す
 *      (取得結果1回=その時点でのその月の告知の全件、という前提のソース向け。
 *      「作り直す」対象は source==='auto' のエントリだけで、'semi'/'manual' の
 *      エントリは次の3.のとおりスロット一致時のみ置き換える)
 *      ただし人手情報(guarantee/prize/pinnedTags/人手タグ)は引き継ぐ
 *   3. 手入力(semi/manual)のうち対象店舗の取得結果に同じ(date,start)があるものは
 *      そちらに置き換える。このときも手入力側のGTD・人手タグは引き継ぐ
 *   4. 手入力のうち対応が無いものは残す(件数と内訳を呼び出し側に返す)
 *      (`source: 'semi'` で登録するツール(店舗画像の取込み等)を再実行した場合、
 *      前回取り込んだ分もこの規則にしたがう。日程が大きく変わった月を再取込みする際に
 *      古いエントリが残ることがあるので、その場合は admin.html 側で手動整理すること)
 *   5. 対象店舗以外・`VENUES` 等の他の定数には一切触らない
 */

const fs = require('fs');

const BLOCK_PREFIX = 'const TOURNAMENTS = ';

function readDataJs(dataJsPath) {
  const src = fs.readFileSync(dataJsPath, 'utf8');
  const startIdx = src.indexOf(`${BLOCK_PREFIX}[`);
  if (startIdx < 0) throw new Error('data.js に `const TOURNAMENTS = [` が見つかりません。');
  const endIdx = src.indexOf('\n];', startIdx);
  if (endIdx < 0) throw new Error('data.js の TOURNAMENTS 配列の終端が見つかりません。');
  const jsonStart = startIdx + BLOCK_PREFIX.length;
  const jsonEnd = endIdx + 2; // '\n]' まで
  let arr;
  try {
    arr = JSON.parse(src.slice(jsonStart, jsonEnd));
  } catch (e) {
    throw new Error(`TOURNAMENTS 配列をJSONとして解釈できません: ${e.message}`);
  }
  if (!Array.isArray(arr)) throw new Error('TOURNAMENTS が配列ではありません。');
  return { src, arr, jsonStart, jsonEnd };
}

function writeDataJs(dataJsPath, file, tournaments) {
  const out = file.src.slice(0, file.jsonStart) + JSON.stringify(tournaments, null, 2) + file.src.slice(file.jsonEnd);
  fs.writeFileSync(dataJsPath, out);
}

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDateStart = (a, b) => cmp(String(a.date), String(b.date)) || cmp(String(a.start || ''), String(b.start || ''));

/**
 * 「自動的に上書きしてよい」タグ語彙。これ以外(バウンティ/特別開催/サテライト/大型など、
 * 人が付けたタグ)は置き換え時に温存する。PR #11(Waitinglist取込)と同じ語彙をそのまま使う
 * (スキーマ上の tags の意味が同じため)。
 */
const AUTO_OWNED_TAGS = ['ターボ', 'ディープ', 'PLO', 'ミックス'];

/**
 * 新エントリに、既存エントリが持っていた「取得結果では供給できない情報」を引き継ぐ。
 * PR #11 の carryOver と同じロジック。
 */
function carryOver(next, prevs) {
  let guarantee = null;
  let prize = null;
  const humanTags = [];
  const pinnedTags = [];
  for (const p of prevs) {
    if (!p) continue;
    if (guarantee == null && p.guarantee != null) guarantee = p.guarantee;
    if (prize == null && p.prize != null) prize = p.prize;
    for (const tag of p.pinnedTags || []) pinnedTags.push(tag);
    for (const tag of p.tags || []) {
      if (!AUTO_OWNED_TAGS.includes(tag)) humanTags.push(tag);
    }
  }
  const pinned = [...new Set(pinnedTags)];
  const entry = { ...next, guarantee, prize, tags: [...new Set([...(next.tags || []), ...humanTags, ...pinned])] };
  if (pinned.length) entry.pinnedTags = pinned;
  return entry;
}

/**
 * 1店舗ぶんのマージ。既存配列を破壊せず、新しい配列と統計を返す。
 * `scraped` は対象店舗の venueId が付いた Tournament 相当のオブジェクトの配列(日付昇順である必要はない)。
 */
function mergeStore(all, venueId, scraped, today) {
  const slotOf = (t) => `${t.date} ${t.start}`;

  const existing = all.filter((t) => t.venueId === venueId);
  const past = existing.filter((t) => t.date < today);
  const future = existing.filter((t) => !(t.date < today));

  const rawFuture = scraped.filter((t) => t.date >= today).sort(byDateStart);
  const apiSlots = new Set(rawFuture.map(slotOf));
  const apiById = new Map(rawFuture.map((t) => [t.id, t]));

  const existingAutoById = new Map(future.filter((t) => t.source === 'auto').map((t) => [t.id, t]));
  const manualsBySlot = new Map();
  for (const t of future) {
    if (t.source === 'auto') continue;
    const k = slotOf(t);
    if (!manualsBySlot.has(k)) manualsBySlot.set(k, []);
    manualsBySlot.get(k).push(t);
  }

  const apiCountBySlot = new Map();
  for (const t of rawFuture) apiCountBySlot.set(slotOf(t), (apiCountBySlot.get(slotOf(t)) || 0) + 1);

  // pastDated = 渡された行のうち【実際に過去日だった】数。
  // 【この1つが無いと行レベルの突き合わせができない】呼び出し側は「Visionが何行返して、
  // その各行がどうなったか」を説明できる必要があるが、過去日の行はここで静かに落ちるため、
  // added/updated/unchanged を足しても渡した行数に届かず、差が「説明の付かない残余」に見えてしまう。
  // (実際 2026-07-31 の dry-run では久留米が20行抽出・追加0で、内訳が誰にも分からなかった)
  //
  // 【★残差(scraped.length - rawFuture.length)で定義してはいけない★】
  // それだと「rawFuture に入らなかった全て」を意味してしまい、呼び出し側の保存則
  // (added+updated+unchanged+pastDated+破棄 = 渡した行数)が【恒等式】になる。
  // 恒等式は何も検査していない: この先 rawFuture の絞り込み条件が1つ増えただけで、
  // 未来日の行が黙って消えても差分がそのまま pastDated に吸い込まれ、
  // 【「過去日」として積極的に誤報される】(この保存則が殺そうとした構図そのもの)。
  // 必ず「過去日である」という性質そのものを数えること。
  // 副次的な利点として、date が undefined/null/数値の行も「過去日」に化けなくなる
  // (`undefined < today` は false なので、そういう行は残余として表に出る)。
  const stats = {
    added: 0,
    updated: 0,
    unchanged: 0,
    pastDated: scraped.filter((t) => t.date < today).length,
    removed: 0,
    carried: 0,
    ambiguous: 0,
    keptManual: [],
    replacedManual: [],
  };

  const future$ = [];
  for (const raw of rawFuture) {
    const prevAuto = existingAutoById.get(raw.id) || null;
    const prevManuals = manualsBySlot.get(slotOf(raw)) || [];

    const usableManuals =
      apiCountBySlot.get(slotOf(raw)) === 1 ? prevManuals : prevManuals.filter((m) => m.name === raw.name);
    if (prevManuals.length && usableManuals.length < prevManuals.length) stats.ambiguous++;

    const entry = carryOver(raw, [prevAuto, ...usableManuals]);
    future$.push(entry);
    if (!sameEntry(entry, raw)) stats.carried++;

    if (prevAuto) {
      if (sameEntry(prevAuto, entry)) stats.unchanged++;
      else stats.updated++;
    } else if (prevManuals.length) {
      stats.updated++;
    } else {
      stats.added++;
    }
  }

  const keptManual = [];
  for (const t of future) {
    if (t.source === 'auto') {
      if (!apiById.has(t.id)) stats.removed++;
      continue;
    }
    if (apiSlots.has(slotOf(t))) {
      stats.replacedManual.push(t);
    } else {
      keptManual.push(t);
      stats.keptManual.push(t);
    }
  }

  // past は書き込み前の自己チェック(assertOnlyTargetChanged)で「内容・順序が完全に一致すること」を
  // 求めているため、ここでソートしてはいけない(実データは日付順ではなく大会名グループ順等で並んでいる
  // ことがあり、ソートすると内容が1件も変わっていなくても順序変化を「過去日が変化した」と誤検知して
  // 書き込みを拒否してしまう。既存の並び順をそのまま保持する)。
  const block = [...past, ...[...keptManual, ...future$].sort(byDateStart)];

  const firstIdx = all.findIndex((t) => t.venueId === venueId);
  const rest = all.filter((t) => t.venueId !== venueId);
  const insertAt = firstIdx < 0 ? rest.length : all.slice(0, firstIdx).filter((t) => t.venueId !== venueId).length;
  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];

  return { next, stats };
}

/**
 * 書き込み直前の自己チェック。対象venue以外・過去日のエントリが変化していないことを確認する。
 * 違反していれば例外を投げる(=呼び出し側は data.js を書き換えずに中止すること)。
 */
function assertOnlyTargetChanged(before, after, venueId, today) {
  const others = (list) => list.filter((t) => t.venueId !== venueId);
  if (JSON.stringify(others(before)) !== JSON.stringify(others(after))) {
    throw new Error('対象外の店舗のデータが変化しています(バグ)。書き込みを中止します。');
  }
  const pastOf = (list) => list.filter((t) => t.venueId === venueId && t.date < today);
  if (JSON.stringify(pastOf(before)) !== JSON.stringify(pastOf(after))) {
    throw new Error('過去日のエントリが変化しています(バグ)。書き込みを中止します。');
  }
}

module.exports = {
  readDataJs,
  writeDataJs,
  sameEntry,
  byDateStart,
  AUTO_OWNED_TAGS,
  carryOver,
  mergeStore,
  assertOnlyTargetChanged,
};
