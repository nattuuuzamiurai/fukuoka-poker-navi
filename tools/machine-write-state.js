'use strict';
/**
 * machine-write-state.js — 「機械が最後に書いた値」の控えと、そこから導く【所有】の判定。
 *
 * 【何のためにあるか】
 *   `data.js` の1行を見ただけでは、それが
 *     (a) 機械が書いてそのまま誰も触っていない行  … 機械が更新してよい
 *     (b) 人が作った行 / 人が直した行             … 機械が触ってはいけない
 *   のどちらなのか分からない。印が無いからである。
 *   そこで【機械が書いた値そのもの】を控えておき、いまの `data.js` と1項目ずつ突き合わせる。
 *   一致していれば誰も触っていない。食い違っていれば人が直した。
 *
 *   ★この方式を選んだ理由は「社長の作業を1つも増やさないこと」。
 *     人が「これは直した」と印を付ける方式は、付け忘れた瞬間に静かに壊れる。
 *
 * 【控えるのは「人の値を戻す前」の機械の値】(★ここを取り違えると保護が1日しか持たない)
 *   人が直した項目を戻したあとの行を控えると、翌日は「控え == いまの値」になって
 *   食い違いが消え、【人の修正が翌々日に上書きされる】。控えるのは常に
 *   「誰も触っていなければ機械が書いたはずの値」= carryOver 直後の候補行である。
 *
 * 【粒度が2つある理由】
 *   - 同一idの既存 … 項目ごとに突き合わせられるので【項目単位】で守る。
 *     行ごと凍結すると、社長が大会名を1つ直しただけでその行の開始時刻が
 *     二度と更新されなくなる。この案件で最も重い実害は一貫して
 *     「プレイヤーが違う時間に店へ行く」なので、その設計は採れない。
 *   - 別idが同じ枠(date,start)を占めている … 項目を対応づける根拠が無いので【行単位】で守る
 *     (「この人の行のこの項目」と「この機械の行のこの項目」を結ぶ根拠が無い)。
 *
 * 【状態ファイルが壊れた/消えたときの縮退 — 隠さずここに書く】
 *   記録が読めなければ全行が「記録なし」になる。すると
 *     - 人の行は【守られたまま】(記録が無い = 人のもの、が既定値のため)
 *     - 機械の auto 行は seed 規則(下記)で拾い直され、状態ファイル導入前と同じ挙動に戻る
 *   つまり「人の行が壊れる」方向には劣化しない。ただし
 *   【機械の行に対する人の修正だけは、状態ファイルが健全な間しか守れない】。
 *   これは方式の限界であって、直したつもりで隠してはいけない。
 *
 * 【seed(状態ファイル導入前に機械が書いた行の引き継ぎ)】
 *   導入時点で `data.js` にある機械の行には記録が無い。これを素直に「人のもの」とすると
 *   稼働中の取込みが数週間凍結し、しかもログに毎朝「守った49件」と常時点灯する
 *   (この案件が一貫して排除してきた形)。そこで例外を1つだけ、狭く置く:
 *
 *     記録が無くても、id が【その取込みツール自身の名前空間】で始まり、
 *     かつ source === 'auto' なら、機械のものとして扱い記録を取り直す。
 *
 *   ★ 根拠: `wl-<ULID>` の ULID は API が発行した値で【人が発明できない】。
 *     `source: 'auto'` を書くのは tools/import-waitinglist.js だけである
 *     (recurring-dedupe.js のヘッダもこの事実に依存している)。
 *   ★ 効くのは各行につき1回だけ。以後は記録が付くので自然に解消する。
 *   ★★ seed に `source: 'auto'` 以外を渡してはいけない。Instagram監視と画像取込みが書くのは
 *     `source: 'semi'` で、これは【人が admin.html で入れた行と同じ source】である。
 *     ここを緩めると、人の手入力572件が「機械のもの」に化けて静かに上書きされる。
 *     渡された時点で例外にして気づけるようにしてある(assertSeedSpec)。
 */

const fs = require('fs');

/** 状態ファイルの形式。version は将来の読み替えのために持つ(いまは 1 だけ)。 */
const STATE_VERSION = 1;

/**
 * 同一性の鍵。ここが違えばそもそも別の行なので、突き合わせの対象にしない。
 * (id が違う行同士は項目を対応づけられない = 行単位で守る側に回る)
 */
const IDENTITY_FIELDS = ['id', 'venueId'];

/**
 * 守った項目をログに並べる順。社長の優先順位
 * 「最低限はトナメ名。次点で参加費と開始時間。賞金は店舗のトーナメントではあまり気にしなくていい」
 * をここに効かせる。★【保護する項目の取捨には使わない】— 全項目を等しく守るほうが安全で安く済む。
 * 効かせるのは報告の並び順だけ。
 */
const FIELD_REPORT_ORDER = [
  'name',
  'buyin',
  'start',
  'date',
  'stack',
  'addon',
  'reentry',
  'tags',
  'pinnedTags',
  'lowConfidence',
  'verified',
  'guarantee',
  'prize',
];

/**
 * 値の比較。`undefined`(キーが無い)と `null` は同じ「値が無い」として扱わない —
 * 任意フィールド(lowConfidence / pinnedTags)を人が【付けた・外した】ことも
 * 「人が直した」として拾う必要があるため、キーの有無まで見る。
 */
function sameValue(a, b) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 控えといまの値を突き合わせ、【人が直した項目】の名前を返す(報告順に並べる)。
 * 控えに無いキー・いまに無いキーも対象(片方にしか無ければ食い違い)。
 */
function humanEditedFields(current, record) {
  if (!record || !current) return [];
  const keys = new Set([...Object.keys(record), ...Object.keys(current)]);
  const out = [];
  for (const k of keys) {
    if (IDENTITY_FIELDS.includes(k)) continue;
    if (!sameValue(current[k], record[k])) out.push(k);
  }
  return sortFieldsForReport(out);
}

/** 守った項目を社長の優先順位で並べる(未知の項目は末尾に、名前順で)。 */
function sortFieldsForReport(fields) {
  const rank = (f) => {
    const i = FIELD_REPORT_ORDER.indexOf(f);
    return i < 0 ? FIELD_REPORT_ORDER.length : i;
  };
  return [...fields].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * seed の指定が安全かを確かめる。上のヘッダ【★★】の理由により
 * `source: 'auto'` 以外の seed は受け付けない。
 */
function assertSeedSpec(seed) {
  if (!seed) return null;
  if (seed.source !== 'auto') {
    throw new Error(
      `seed の source は 'auto' でなければなりません(渡された値: ${JSON.stringify(seed.source)})。` +
        "'semi' は人が admin.html で入れた行と同じ source なので、seed にすると手入力が機械のものに化けます。"
    );
  }
  if (!seed.idPrefix) {
    throw new Error('seed には idPrefix(その取込みツール自身の名前空間)が必要です。');
  }
  return seed;
}

/**
 * 1行の所有を判定する。
 *
 * @param {object} entry           いま data.js にある行
 * @param {object|null} record     機械が最後に書いた値(無ければ null)
 * @param {{source:string, idPrefix:string}|null} seed  状態ファイル導入前の引き継ぎ規則
 * @returns {{owned:boolean, seeded:boolean, humanFields:string[]}}
 *   owned=false … 人のもの。機械は1バイトも触らない
 *   owned=true  … 機械のもの。humanFields に挙がった項目【だけ】は人の値を残す
 */
function ownership(entry, record, seed) {
  if (record) {
    return { owned: true, seeded: false, humanFields: humanEditedFields(entry, record) };
  }
  if (seed && entry && entry.source === seed.source && String(entry.id || '').startsWith(seed.idPrefix)) {
    return { owned: true, seeded: true, humanFields: [] };
  }
  return { owned: false, seeded: false, humanFields: [] };
}

/**
 * 機械が作った候補行に、人が直した項目【だけ】を戻す。
 * 挙げられていない項目は候補の値をそのまま使う(= 自動化は止まらない)。
 */
function preserveHumanFields(candidate, current, fields) {
  if (!fields || !fields.length || !current) return candidate;
  const out = { ...candidate };
  for (const k of fields) {
    if (IDENTITY_FIELDS.includes(k)) continue;
    if (Object.prototype.hasOwnProperty.call(current, k)) out[k] = current[k];
    else delete out[k]; // 人がキーごと外した(例: ⚠ を外した)場合もその意図を残す
  }
  return out;
}

/**
 * 状態ファイルを読む。読めない/壊れているときは【空として返し、例外は投げない】。
 * ここで落とすと、状態ファイル1つで日次の取込みが永久に止まる。
 * 縮退したことは呼び出し側がログに出せるよう `broken` で返す。
 */
function readState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    return { entries: {}, missing: true, broken: false };
  }
  try {
    const json = JSON.parse(raw);
    const entries = json && typeof json.entries === 'object' && json.entries ? json.entries : null;
    if (!entries) return { entries: {}, missing: false, broken: true };
    return { entries, missing: false, broken: false };
  } catch (e) {
    return { entries: {}, missing: false, broken: true };
  }
}

/**
 * 次の状態を組み立てる。
 *
 * @param {object} prevEntries      前回の記録(id → 機械が書いた値)
 * @param {object} writtenEntries   今回機械が書いた値(id → 値)。★人の値を戻す【前】の候補行
 * @param {{today:string, replacedVenueIds?:string[], liveIds?:Set<string>}} opts
 *   replacedVenueIds … 今回マージし直した店。その店の古い記録は捨てて今回ぶんで置き換える
 *                      (取得に失敗してスキップした店の記録は残す)
 *   liveIds          … 書き込み後の data.js に存在する id。ここに無い記録は捨てる
 * 【未来日ぶんだけ残す】過去日の行はどの取込みも触らないので、控える意味が無い。
 * 残すとファイルが際限なく膨らむ。
 */
function buildNextEntries(prevEntries, writtenEntries, opts) {
  const { today, replacedVenueIds, liveIds } = opts;
  const replaced = new Set(replacedVenueIds || []);
  const next = {};
  for (const [id, rec] of Object.entries(prevEntries || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (replaced.has(rec.venueId)) continue; // 今回作り直した店は下で入れ直す
    next[id] = rec;
  }
  for (const [id, rec] of Object.entries(writtenEntries || {})) {
    next[id] = rec;
  }
  // 刈り込み: 過去日 / data.js から消えた行
  for (const [id, rec] of Object.entries(next)) {
    if (today && rec && typeof rec.date === 'string' && rec.date < today) delete next[id];
    else if (liveIds && !liveIds.has(id)) delete next[id];
  }
  return next;
}

/**
 * 状態ファイルを書く。内容が変わらないときは書かない(mtimeも動かさない)。
 * 書いたかどうかを返す。dryRun なら「ズレているか」だけを返して書かない。
 *
 * 【キーを並べ替えて書く】日次コミットの差分を「本当に変わった行」だけにするため。
 * 並びが実行のたびに揺れると、中身が同じでも毎日ファイル全体が差分になる。
 */
function writeState(statePath, entries, opts) {
  const { writtenBy, dryRun } = opts || {};
  const sorted = {};
  for (const id of Object.keys(entries).sort()) sorted[id] = entries[id];
  const json =
    JSON.stringify(
      {
        version: STATE_VERSION,
        writtenBy: writtenBy || null,
        // ★ 生成日時・件数などの「実行するたびに変わる値」は入れない。
        //   入れると日程に変化が無い日でもこのファイルだけが差分になり、無意味なコミットが増える
        //   (auto-import-stores.json で同じ判断をしている)。
        entries: sorted,
      },
      null,
      2
    ) + '\n';

  let cur = null;
  try {
    cur = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    /* 未生成 */
  }
  if (cur === json) return false;
  if (!dryRun) fs.writeFileSync(statePath, json);
  return true;
}

/**
 * 書き込み直前の突き合わせ 1/2。
 * 【機械のものでない行】は、マージ前に存在したものがすべて、内容そのままで残っていること。
 *
 * ★これは【カウンタを一切参照しない】。左辺はマージ前のディープコピー、右辺はマージ後の配列で、
 *   どちらもマージ側の集計とは独立した外部の値である。したがって
 *   stats を潰す変異(`ok: true` に固定する等)が入ってもこの検査は生き残る。
 * ★突き合わせは id を鍵にする(位置ではない)。並べ替えは正当な操作なので、
 *   位置で比べると内容が1件も変わっていないのに違反と誤報する。
 *
 * @returns {string|null} 違反の説明。問題なければ null
 */
function findUnownedRowChange(before, after, isOwned) {
  const afterById = new Map(after.map((t) => [t.id, t]));
  for (const t of before) {
    if (isOwned(t)) continue;
    const now = afterById.get(t.id);
    if (!now) {
      return `機械のものでない行が消えています: id=${t.id} / ${t.date} ${t.start} ${t.name}`;
    }
    if (JSON.stringify(now) !== JSON.stringify(t)) {
      return `機械のものでない行が書き換えられています: id=${t.id} / ${t.date} ${t.start} ${t.name}`;
    }
  }
  return null;
}

/**
 * 書き込み直前の突き合わせ 2/2。
 * 【人が直した項目】は、その行が残っている限り値が変わっていないこと。
 * (行ごと消えるのは供給元から消えた場合で、それは別の会計 stats.removed が持つ)
 *
 * こちらもカウンタを参照しない。控え(record)と before/after だけで判定する。
 */
function findHumanFieldChange(before, after, recordOf) {
  const afterById = new Map(after.map((t) => [t.id, t]));
  for (const t of before) {
    const rec = recordOf(t);
    if (!rec) continue; // 記録が無い行は上の検査の担当
    const fields = humanEditedFields(t, rec);
    if (!fields.length) continue;
    const now = afterById.get(t.id);
    if (!now) continue;
    for (const f of fields) {
      if (!sameValue(now[f], t[f])) {
        return (
          `人が直した項目が書き換えられています: id=${t.id} / 項目=${f} / ` +
          `人の値=${JSON.stringify(t[f])} → 書き込もうとした値=${JSON.stringify(now[f])}`
        );
      }
    }
  }
  return null;
}

/**
 * 書き込み直前の突き合わせ 3/3。
 * 【人のものだった行が占めている枠に、機械の行を新しく置いていないこと】。
 *
 * 【なぜ 1/2 では足りないか(変異試験で判明・2026-08-04)】
 *   枠の保護を外す変異を入れても、1(行が書き換わっていないか)は鳴らなかった。
 *   いまの実装は「置き換える」のではなく「書かない」ので、保護を外すと
 *   【人の行はそのまま残り、機械の行がもう1行増える】= 破壊ではなく重複になるためである。
 *   重複も実害で、`recurring-dedupe.js` のヘッダが言うとおり
 *   「同じ大会が2行に見えるのは1行足りないより信用を損なう」。
 *   検査が「破壊」しか見ていないと、この向きの退行を素通りさせる。
 *
 * 【誤検知しない理由】見るのは【今回新しく増えた行】だけで、既存どうしの同時刻衝突には触れない
 *   (実データには v35 の start:'' 同士のように正当な同枠の行が存在する)。
 *   「人のものだった枠に機械の行を新設する」ことは保護の規則が禁じているので、
 *   ここが鳴る = 規則が破れた、以外の意味を持たない。
 *
 * こちらもカウンタを参照しない(before / after / 所有判定だけ)。
 */
function findMachineRowInHumanSlot(before, after, isOwned) {
  const slotKey = (t) => `${t.venueId} ${t.date} ${t.start}`;
  const beforeIds = new Set(before.map((t) => t.id));
  const humanSlots = new Map();
  for (const t of before) {
    if (isOwned(t)) continue;
    if (!humanSlots.has(slotKey(t))) humanSlots.set(slotKey(t), t);
  }
  for (const t of after) {
    if (beforeIds.has(t.id)) continue; // 今回新しく増えた行だけを見る
    const human = humanSlots.get(slotKey(t));
    if (human && human.id !== t.id) {
      return (
        `人の行が居る枠に機械の行を書いています: ${t.date} ${t.start} / ` +
        `人の行=${human.name}(${human.id}) / 書こうとした行=${t.name}(${t.id})`
      );
    }
  }
  return null;
}

module.exports = {
  STATE_VERSION,
  FIELD_REPORT_ORDER,
  sameValue,
  humanEditedFields,
  sortFieldsForReport,
  assertSeedSpec,
  ownership,
  preserveHumanFields,
  readState,
  buildNextEntries,
  writeState,
  findUnownedRowChange,
  findHumanFieldChange,
  findMachineRowInHumanSlot,
};
