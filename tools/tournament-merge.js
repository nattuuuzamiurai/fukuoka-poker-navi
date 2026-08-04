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
 *   2. 【機械が所有する】source==='auto' の今日以降のエントリは毎回作り直す
 *      (取得結果1回=その時点でのその月の告知の全件、という前提のソース向け)。
 *      ただし人手情報(guarantee/prize/pinnedTags/人手タグ)は引き継ぐ
 *   3. 【機械が所有する行の、人が直した項目】はその項目だけ人の値を残す
 *      (下記【所有】。項目単位なので、大会名を直しても開始時刻の更新は止まらない)
 *   4. 【機械が所有しない行】= 人が作った行・人が直した行には一切触らない。
 *      同じ(date,start)に取得結果が来ても【機械の行を書かない】(件数と内訳を返す)
 *   5. 取得結果に対応が無い既存の行は残す(件数と内訳を呼び出し側に返す)
 *      (`source: 'semi'` で登録するツール(店舗画像の取込み等)を再実行した場合、
 *      前回取り込んだ分もこの規則にしたがう。日程が大きく変わった月を再取込みする際に
 *      古いエントリが残ることがあるので、その場合は admin.html 側で手動整理すること)
 *   6. 対象店舗以外・`VENUES` 等の他の定数には一切触らない
 *
 * 【★4 は 2026-08-04 に変えた。それ以前は「同じ枠なら手入力を置き換える」だった】
 *   旧規則の実測(dry-run #5)では、人が入れた39件が Vision の読み取り結果に置き換わった。
 *   置き換えは値の交換ではなく【情報量の低下】である:
 *     v21 の未来日28件は開始時刻23件(82%)・参加費22件(79%)を持つのに対し、
 *     同じ実行の Vision は開始時刻4.5% / 参加費13.6%。
 *   さらに手入力の39件はすべて `lowConfidence: true`(サイト表示は ⚠ 要確認)で、
 *   置き換えると【誰も確認していないのに ⚠ が外れる】= 未検証の「確認済み」という主張になる。
 *
 * 【★旧規則にあった「引き継げないGTDは引き継がない」判断について — 消えたのではなく包含された】
 *   旧実装は「同じ枠に取得結果が複数あるとき、名前が一致しない手入力の GTD/賞品は
 *   引き継がず stats.ambiguous で数える」という分岐を持っていた。その根拠は
 *   【どちらの大会のものか特定できないなら、誤情報を出すより欠落させる方が軽い】。
 *   この判断は否定されていない。新規則はより強い形でそれを包含する —
 *   引き継ぎを見送るのではなく【機械の行そのものを書かない】ので、
 *   誤って配られる余地が構造的に無くなった。したがって旧分岐は到達不能になり、
 *   到達不能なカウンタは「鳴らない警報」なので削除した。
 *   ★ここを読んだ人が「同じ枠なら機械を優先すればいい」と戻さないこと。
 *     欠落 > 誤情報 という優先順位は生きている。
 *
 * 【所有(ownership) — tools/machine-write-state.js】
 *   `data.js` の1行を見ただけでは、機械が書いたままなのか人が直したのかは分からない。
 *   そこで機械が書いた値そのものを控えておき、いまの値と1項目ずつ突き合わせる。
 *   一致 → 誰も触っていない(機械が更新してよい) / 食い違い → 人が直した(触らない)。
 *   控えが無い行は【人のもの】が既定値。詳しい理由と縮退の挙動は同ファイルのヘッダ参照。
 */

const fs = require('fs');
const state = require('./machine-write-state');

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
 *
 * 【渡す prevs は【機械が所有する同じidの既存】1件だけ】(2026-08-04)。
 * 以前は「同じ枠の手入力」も渡していたが、いまは人の行の枠に機械の行を書かないので
 * 渡す相手が存在しない。人の行の GTD/タグは【その行がそのまま残る】ことで守られる。
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
  const entry = {
    ...next,
    // 【優先順: 人の値 > 今回読み取った値 > null】(2026-08-04修正)
    // ★以前は「人の値、無ければ null」で、【今回読み取った値を毎回捨てていた】。
    //   「guarantee/prize は人手専用フィールド」という前提は Waitinglist では正しい
    //   (APIに該当フィールドが無く toTournament が定数 null を返す)が、
    //   【Vision経路では成立しない】— プロンプトが "guarantee":number|null と
    //   "prize":string|null の両方を要求しているため、読み取れた値が実際に届く。
    //   Waitinglist用の設計をVisionに流用したことによる欠陥だった。
    // ★3つの保存則は「行」の会計なので、この「項目」の欠落は原理的に検知できない。
    //   だから式そのものをここで正しくしておくこと。
    guarantee: guarantee != null ? guarantee : next.guarantee != null ? next.guarantee : null,
    prize: prize != null ? prize : next.prize != null ? next.prize : null,
    tags: [...new Set([...(next.tags || []), ...humanTags, ...pinned])],
  };
  if (pinned.length) entry.pinnedTags = pinned;
  return entry;
}

/**
 * 1店舗ぶんのマージ。既存配列を破壊せず、新しい配列と統計を返す。
 * `scraped` は対象店舗の venueId が付いた Tournament 相当のオブジェクトの配列(日付昇順である必要はない)。
 *
 * @param {object} [opts]
 *   opts.records … 機械が最後に書いた値(id → エントリ)。省略すると【全行が人のもの】になり、
 *                  機械は新しい枠に足すことしかしない。★これが安全側の既定値。
 *   opts.seed    … 状態ファイル導入前の行の引き継ぎ規則 { source:'auto', idPrefix:'wl-' }。
 *                  `source: 'semi'` を渡すと例外になる(手入力と同じ source のため)。
 * @returns {{ next: Array, stats: object, written: object }}
 *   written … 今回機械が書いた【人の値を戻す前の候補行】(id → エントリ)。
 *             ★状態ファイルにはこれを控える。戻した後の行を控えると、翌日は
 *             「控え == いまの値」になって食い違いが消え、人の修正が翌々日に上書きされる。
 */
function mergeStore(all, venueId, scraped, today, opts = {}) {
  const slotOf = (t) => `${t.date} ${t.start}`;
  const records = opts.records || {};
  const seed = state.assertSeedSpec(opts.seed || null);
  const recordOf = (t) => (Object.prototype.hasOwnProperty.call(records, t.id) ? records[t.id] : null);

  const existing = all.filter((t) => t.venueId === venueId);
  const past = existing.filter((t) => t.date < today);
  const future = existing.filter((t) => !(t.date < today));

  const rawFuture = scraped.filter((t) => t.date >= today).sort(byDateStart);

  // 既存の未来行の所有をここで1回だけ判定する(以降はこの結果だけを見る)。
  const own = new Map();
  for (const t of future) own.set(t.id, state.ownership(t, recordOf(t), seed));
  const existingById = new Map(future.map((t) => [t.id, t]));

  // 【人のもの】を枠で引けるようにする。機械の行はこの枠に入れない。
  // ★ source では分けない。Instagram監視・画像取込みが書く行も `source: 'semi'` で、
  //   人が admin.html で入れた行と source が同じだからである。分けるのは【控えの有無】。
  const humanBySlot = new Map();
  for (const t of future) {
    if (own.get(t.id).owned) continue;
    const k = slotOf(t);
    if (!humanBySlot.has(k)) humanBySlot.set(k, []);
    humanBySlot.get(k).push(t);
  }

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
    // 【★残差で作らないこと★】protected は「書かないと決めたその場で +1」する。
    // `rawFuture.length - 書いた数` にすると保存則が恒等式になり、
    // 未来日の行が別の理由で黙って消えてもこの項に吸い込まれて表に出なくなる。
    protected: 0,
    protectedRows: [], // { incoming, existing[] } … 機械が書かなかった行と、その理由になった人の行
    fieldsProtected: 0,
    protectedFields: [], // { entry, fields[] } … 人が直した項目を残した行
    removedHumanEdited: [], // 人が直した行が供給元から消えたので削除したもの(可視化のため)
    keptManual: [],
  };

  const future$ = [];
  const written = {}; // id → 機械の候補値(人の値を戻す【前】)。状態ファイルに控える値
  const blockedIds = new Set(); // 機械の行を止めた人の行の id
  const protectedIncomingIds = new Set(); // 書かなかった機械の行の id

  for (const raw of rawFuture) {
    const prev = existingById.get(raw.id) || null;
    const o = prev ? own.get(prev.id) : null;

    // (1) 同じidの既存が【人のもの】= 控えが無い。行ごと守る。
    if (prev && !o.owned) {
      stats.protected += 1;
      stats.protectedRows.push({ incoming: raw, existing: [prev] });
      blockedIds.add(prev.id);
      protectedIncomingIds.add(raw.id);
      continue;
    }

    // (2) 別idの人の行が同じ枠(date,start)を占めている。機械の行を書かない。
    //     ★項目単位で守れないのは、id が違う行同士は項目を対応づける根拠が無いため
    //     (「この人の行のこの項目」と「この機械の行のこの項目」を結べない)。
    const blockers = (humanBySlot.get(slotOf(raw)) || []).filter((t) => t.id !== raw.id);
    if (blockers.length) {
      stats.protected += 1;
      stats.protectedRows.push({ incoming: raw, existing: blockers });
      for (const b of blockers) blockedIds.add(b.id);
      protectedIncomingIds.add(raw.id);
      continue;
    }

    // (3) 通常経路。機械の候補を作り、人が直した項目【だけ】を戻す。
    const prevOwned = prev && o.owned ? prev : null;
    const machineValue = carryOver(raw, [prevOwned]);
    written[raw.id] = machineValue;
    if (!sameEntry(machineValue, raw)) stats.carried++;

    const fields = prevOwned ? o.humanFields : [];
    if (fields.length) {
      stats.fieldsProtected += fields.length;
      stats.protectedFields.push({ entry: prevOwned, fields });
    }
    const entry = state.preserveHumanFields(machineValue, prevOwned, fields);
    future$.push(entry);

    if (prev) {
      if (sameEntry(prev, entry)) stats.unchanged++;
      else stats.updated++;
    } else {
      stats.added++;
    }
  }

  const writtenIds = new Set(future$.map((e) => e.id));
  const kept = [];
  for (const t of future) {
    if (writtenIds.has(t.id)) continue; // 作り直した行(future$ 側に入っている)
    const o = own.get(t.id);
    // 機械が所有する source:'auto' の行は「取得結果=その時点の全件」が前提なので、
    // 取得結果に無い = 供給元から消えた とみなして削除する(従来どおり)。
    // ★ただし今回【書かなかった】行は消しもしない。書かないと決めた行に手を出さないのは
    //   保護の規則そのもので、ここだけ例外にすると「守ったのに消える」ことになる。
    if (t.source === 'auto' && o.owned && !protectedIncomingIds.has(t.id)) {
      stats.removed++;
      if (o.humanFields.length) stats.removedHumanEdited.push({ entry: t, fields: o.humanFields });
      continue;
    }
    kept.push(t);
    // keptManual は従来どおり「取得結果に対応が無くて残った人の行」。
    // 枠を守って機械を止めた行はこちらには入れない(protectedRows で別に数えている。二重計上を防ぐ)。
    if (!o.owned && !blockedIds.has(t.id)) stats.keptManual.push(t);
  }

  // past は書き込み前の自己チェック(assertOnlyTargetChanged)で「内容・順序が完全に一致すること」を
  // 求めているため、ここでソートしてはいけない(実データは日付順ではなく大会名グループ順等で並んでいる
  // ことがあり、ソートすると内容が1件も変わっていなくても順序変化を「過去日が変化した」と誤検知して
  // 書き込みを拒否してしまう。既存の並び順をそのまま保持する)。
  const block = [...past, ...[...kept, ...future$].sort(byDateStart)];

  const firstIdx = all.findIndex((t) => t.venueId === venueId);
  const rest = all.filter((t) => t.venueId !== venueId);
  const insertAt = firstIdx < 0 ? rest.length : all.slice(0, firstIdx).filter((t) => t.venueId !== venueId).length;
  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];

  return { next, stats, written };
}

/**
 * 書き込み直前の自己チェック。対象venue以外・過去日のエントリが変化していないことを確認する。
 * 違反していれば例外を投げる(=呼び出し側は data.js を書き換えずに中止すること)。
 *
 * 【★この関数は過去日を「順序込み」で見たままである = PR #36 の修正を受けていない★】
 *   それでも #17(並び順の誤検知で毎朝止まる)は起きない。**1店ぶんしか見ていないから**である:
 *     - mergeStore が組み直すのはその店のブロックだけで、past の店内の相対順序は保たれる
 *     - 対象外の店の相対順序も保たれる(rest の順序は触らない)
 *     - 並びが変わるのは「A店の過去日」と「B店の過去日」の間だけで、venueId で絞った
 *       この検査には構造的に見えない
 *   実測(2026-08-05): 2ブロックの v22 / v27 / v20 / v18 / v21 すべてでこの検査は通過し、
 *   複数店をまとめて見る schedule-write-guard 側だけが(旧式なら)鳴った。
 *
 *   ★★したがって【この関数に複数店を渡してはいけない】★★
 *   「直っているから安全」ではなく「見えていないから鳴らない」である。対象を複数店に
 *   広げた瞬間に #17 が再発する(= 毎朝 exit 1 で永久に止まる)。複数店をまとめて見たいときは
 *   tools/schedule-write-guard.js の checkNothingElseChanged を使うこと。
 *   根治(リスク台帳 #18 = insertAt 方式の置き換え)が済むまでこの制約は外れない。
 *
 * 【落ちても自分では直らない】呼び出し側はここが鳴ると data.js を書かずに中止するので、
 *   次の実行も同じ入力で始まり同じ理由で落ちる(README リスク台帳 #17)。
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

/**
 * 書き込み直前の突き合わせ。人の行・人が直した項目が1つも壊れていないことを確認する。
 * 違反していれば例外を投げる(=呼び出し側は data.js を書き換えずに中止すること)。
 *
 * 【★これは「保存則」ではなく突き合わせである】マージが数えたカウンタを一切参照せず、
 *   マージ前のディープコピー(before)と、マージ後の配列(after)と、控え(records)だけで判定する。
 *   したがって stats を潰す変異(`protected` を数えない・`ok: true` に固定する等)が入っても
 *   この検査は独立に生き残る。カウンタで検算する形にしてはいけない —
 *   同じ材料から導いた値どうしを比べると恒等式になり、何も検査しないものになる。
 *
 * 【before には必ずマージ前のディープコピーを渡すこと】before と after が同じ要素オブジェクトを
 *   共有していると、エントリを in-place で書き換えるバグが両辺に同じように映って素通りする。
 */
function assertHumanEditsPreserved(before, after, opts = {}) {
  const records = opts.records || {};
  const seed = state.assertSeedSpec(opts.seed || null);
  const recordOf = (t) => (Object.prototype.hasOwnProperty.call(records, t.id) ? records[t.id] : null);
  const isOwned = (t) => state.ownership(t, recordOf(t), seed).owned;

  const rowProblem = state.findUnownedRowChange(before, after, isOwned);
  if (rowProblem) throw new Error(`${rowProblem}(バグ)。書き込みを中止します。`);
  const fieldProblem = state.findHumanFieldChange(before, after, recordOf);
  if (fieldProblem) throw new Error(`${fieldProblem}(バグ)。書き込みを中止します。`);
  // 破壊だけでなく【重複】の向きも見る(いまの実装は置き換えではなく「書かない」ので、
  // 保護が外れると人の行はそのまま残って機械の行が1行増える = 同じ枠が2行になる)。
  const slotProblem = state.findMachineRowInHumanSlot(before, after, isOwned);
  if (slotProblem) throw new Error(`${slotProblem}(バグ)。書き込みを中止します。`);
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
  assertHumanEditsPreserved,
};
