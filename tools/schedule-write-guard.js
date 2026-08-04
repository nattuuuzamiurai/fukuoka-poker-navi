/**
 * 書き込み直前の最終自己チェック（`data.js` を書く全ツール共通）。
 *
 * 「取り込み対象の未来日以外は、何ひとつ動いていないこと」を、書き込みの直前に1回だけ確かめる。
 * 破っていれば呼び出し側は **data.js を1バイトも書かずに中止する**。
 *
 * ============================================================
 * 【★この検査は書き込みの前にある = 落ちても自分では直らない★】
 * ============================================================
 * ここで中止すると `data.js` は書き換わらない。つまり **次の実行も同じ入力・同じ配置で始まり、
 * 同じ理由で落ちる**。「1回赤くなって翌日には直る」ではなく **永久に止まり続ける**。
 * しかも取込み側の保存則（投稿・行のカウンタ）は全部成立したままなので、
 * ログを見ても「全部正常なのに書かれない」という切り分けの難しい形になる。
 *
 * 2026-08-04 の実データ試験（run 30922261347）がまさにこれだった。cron を有効にしていたら
 * **初日から毎朝止まり続け、一度もデータが入らなかった**。
 *
 * **この性質は今回の検査だけでなく、書き込み前に置かれるすべての検査に当てはまる。**
 * ここに検査を足す担当は「赤くなるだけ」と読まないこと。足すなら
 * 「落ちた状態から人手なしで回復できるか」を必ず一緒に設計すること。
 * （回復できないなら、それは検査ではなく恒久的な停止装置である）
 *
 * **既存の検査は全数監査済み（2026-08-05）。** `data.js` を書く3ツールの、書き込み前に
 * `exit(1)` する検査をすべて列挙し、「良性の入力で鳴るか」「鳴ったら人手なしで直るか」を
 * 実測した。結果と、どれが**意図的な恒久停止装置**かは README
 * 「書き込み前に `exit(1)` する検査の全数監査（回復可能性・2026-08-05）」にある。
 * **検査を1本足したら、その表にも1行足すこと。**
 *
 * **★もう半分の教訓: 「通ったとき」も安全とは限らない。**
 * この検査を通過した dry-run #5（基準日 8/1）は、**人の入力39件を破壊したまま緑だった**。
 * 実際に働いた安全装置と、守るべきだった対象が別物だったためである（README リスク台帳 #17）。
 * 「緑だった」は「この検査が見ている不変条件は破れていなかった」以上の意味を持たない。
 *
 * ============================================================
 * 【なぜ過去日は「並び順」を見ないのか】
 * ============================================================
 * かつてこの検査は `JSON.stringify(pastOf(before)) !== JSON.stringify(pastOf(after))` だった。
 * `JSON.stringify` は配列の順序に敏感なので、**中身が1件も変わっていなくても
 * 並びが変わっただけで「過去日が変化した(バグ)」と報告して中止していた**。
 *
 * 並びが変わる理由は取込みの中身とは無関係で、`data.js` の**配置**にある。
 * 各ツールの `mergeStore` は店の行を1か所のブロックに組み直して差し戻すが、
 * その挿入位置（`insertAt`）は「その店の最初の行があった位置」である。つまり
 * **店の行が `data.js` 内で連続していること**を暗黙に前提にしている。
 * 実データは月末の一括登録（「THE DOJO: 2026年8月のトーナメント26件を登録」など）で
 * 月ごとに別の場所へ追記されるため、**1店が2ブロックに分かれている**ことが普通にある
 * （2026-08-05 時点で11店）。マージがそれを1か所にまとめると、
 * 後ろのブロックにある過去日の行が、**別の店の過去日の行を追い越す**。
 *
 * この「追い越し」は
 *   - 抽出結果が0行でも起きる（＝取込みの中身に一切依存しない構造上の挙動）
 *   - 一度まとめてしまえば次回以降は起きない（＝店ごとに一度きり）
 *   - ただし翌月の一括登録でまた分かれるので、**月次で再発する**
 *
 * なので順序の一致を不変条件にはできない。**代わりに順序以外はすべて厳密に見る**:
 *   - 過去日の id の集合が完全に一致すること（1件も増えない・1件も消えない）
 *   - 同じ id の中身が1バイトも違わないこと
 *   - 対象外の店は**順序も含めて**完全に一致すること（こちらは緩めていない）
 *
 * そのうえで **並びが変わった行数を必ず数えて呼び出し側に返す**。
 * 「順序を見ないことにした」で終わらせると、千行動いた理由が誰にも説明できなくなるため。
 *
 * ============================================================
 * 【並び順が掲載内容に与える影響（実測・2026-08-05）】
 * ============================================================
 * サイトは描画時に (date, start) で並べ替える（`index.html` / `tools/venue-schedule.js`）ので、
 * 配列順は基本的に表示に出ない。**ただし完全に無影響ではない**:
 * 同じ (date, start) を共有する行どうしは比較が同値になり、
 * 安定ソートによって**入力順（＝配列順）がそのまま残る**。
 * 2026-08-05 の実データでは、監視4店のマージで **634行中4行（2組）の表示順が入れ替わった**:
 *
 *   2026-08-04  v21「WJPT 祝勝会」 ↔ v20「FSTサテライト」
 *   2026-08-19  v21「ディーラー ミナっち バースデートーナメント」 ↔ v20「フリーロール」
 *
 * いずれも全店一覧での上下が入れ替わるだけで、掲載内容そのものは同一。
 * 店舗ページは単一店なので影響しない。**「表示には影響しない」と書かないこと。**
 */

'use strict';

/** 対象外の店（＝この実行で触ってよい店以外）だけを取り出す。 */
function othersOf(list, targets) {
  return list.filter((t) => !targets.has(t.venueId));
}

/** 対象店のうち過去日の行だけを取り出す。 */
function pastOf(list, targets, today) {
  return list.filter((t) => targets.has(t.venueId) && t.date < today);
}

/**
 * 「並びだけが変わった行」の数。
 *
 * 【★ずれた添字の数を数えてはいけない★】1行が先頭へ移動すると、その後ろの行の添字は
 * すべて1つずつずれる。添字の不一致を数えると「1行動いただけ」が「56行動いた」に化け、
 * 数字が実態から離れる（実際 2026-08-04 の run では 4行の移動が 56件に見えていた）。
 *
 * 正しくは **動かさずに済む行を最大化したときの、残り＝動かした行の数**。
 * これは「元の位置の並びの最長増加部分列（LIS）を残し、それ以外を動かす」に等しい。
 * 同じ id が2つある場合は先頭から順に対応づける（duplicateId は別の検査が拾う）。
 */
function countReordered(beforeList, afterList) {
  const slots = new Map();
  beforeList.forEach((t, i) => {
    if (!slots.has(t.id)) slots.set(t.id, []);
    slots.get(t.id).push(i);
  });
  const cursor = new Map();
  const seq = [];
  for (const t of afterList) {
    const idx = slots.get(t.id);
    if (!idx) return { moved: afterList.length, movedRows: afterList.slice() }; // 集合が違う。呼び出し前に弾かれる
    const k = cursor.get(t.id) || 0;
    cursor.set(t.id, k + 1);
    seq.push(idx[Math.min(k, idx.length - 1)]);
  }
  // 最長増加部分列（狭義単調増加）の長さと、その要素の位置
  const tails = []; // tails[k] = 長さ k+1 の増加列の最小末尾の seq 上の位置
  const prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
    if (lo === tails.length) tails.push(i);
  }
  const keep = new Set();
  let cur = tails.length ? tails[tails.length - 1] : -1;
  while (cur !== -1) {
    keep.add(cur);
    cur = prev[cur];
  }
  const movedRows = afterList.filter((_, i) => !keep.has(i));
  return { moved: movedRows.length, movedRows };
}

/** `data.js` の中でその店の行がいくつのブロックに分かれているかを数える。 */
function blockCounts(list) {
  const counts = new Map();
  let cur = null;
  for (const t of list) {
    if (cur !== t.venueId) {
      counts.set(t.venueId, (counts.get(t.venueId) || 0) + 1);
      cur = t.venueId;
    }
  }
  return counts;
}

/**
 * 最終自己チェック本体。**例外を投げず、判定を返す**。
 * 落ちたときの止め方（`fail()` か `throw` か）は呼び出し側の作法に任せる。
 *
 * @param {Array} before  マージ前のエントリ配列。**ディープコピーを渡すこと**
 *   （after と要素オブジェクトを共有していると、in-place で書き換えるバグが両辺に
 *     同じように映って素通りする）
 * @param {Array} after   マージ後のエントリ配列
 * @param {{ targets: Set<string>|Array<string>, today: string, othersLabel?: string }} opts
 *   othersLabel … 対象外の店をログでどう呼ぶか。ツールによって「対象外の店舗」
 *   「取得に成功した店舗以外」と呼び分けている（意味は同じ）。既定は「対象外の店舗」。
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,      // 'others' | 'past-added' | 'past-removed' | 'past-modified'
 *   message: string|null,     // 呼び出し側がそのまま出せる中止理由
 *   reordered: number,        // 並びだけが変わった過去日の行数（中身は変わっていない）
 *   reorderedByVenue: object, // { venueId: 行数 }
 *   splitVenues: object,      // マージ前に2ブロック以上だった対象店 { venueId: ブロック数 }
 * }}
 */
function checkNothingElseChanged(before, after, opts) {
  const targets = opts.targets instanceof Set ? opts.targets : new Set(opts.targets);
  const today = opts.today;
  const empty = { reordered: 0, reorderedByVenue: {}, splitVenues: {} };

  // 1) 対象外の店は【順序も含めて】完全一致。ここは緩めない。
  //    対象店のブロックが動いても、対象外の店どうしの相対順序は変わらないため
  //    （移動するのは対象店のブロックだけで、残りの並びはそのまま保たれる）。
  if (JSON.stringify(othersOf(before, targets)) !== JSON.stringify(othersOf(after, targets))) {
    return {
      ok: false,
      reason: 'others',
      message: `${opts.othersLabel || '対象外の店舗'}のデータが変化しています(バグ)。書き込みを中止します。`,
      ...empty,
    };
  }

  const pb = pastOf(before, targets, today);
  const pa = pastOf(after, targets, today);

  // 2) 過去日は「増えない・消えない・中身が変わらない」を厳密に見る。順序だけ見ない。
  const mapB = new Map(pb.map((t) => [t.id, t]));
  const mapA = new Map(pa.map((t) => [t.id, t]));

  const removed = pb.filter((t) => !mapA.has(t.id));
  if (removed.length) {
    return {
      ok: false,
      reason: 'past-removed',
      message:
        `過去日のエントリが${removed.length}件消えています(バグ)。書き込みを中止します。` +
        ` 例: ${describe(removed[0])}`,
      ...empty,
    };
  }
  const added = pa.filter((t) => !mapB.has(t.id));
  if (added.length) {
    return {
      ok: false,
      reason: 'past-added',
      message:
        `過去日のエントリが${added.length}件増えています(バグ)。書き込みを中止します。` +
        ` 例: ${describe(added[0])}`,
      ...empty,
    };
  }
  // 件数が同じでも、同じ id が重複していれば集合の一致だけでは検出できない。
  if (pb.length !== pa.length) {
    return {
      ok: false,
      reason: 'past-added',
      message:
        `過去日のエントリ数が ${pb.length}件 → ${pa.length}件 に変わっています(バグ)。書き込みを中止します。`,
      ...empty,
    };
  }
  const modified = pb.filter((t) => JSON.stringify(mapA.get(t.id)) !== JSON.stringify(t));
  if (modified.length) {
    return {
      ok: false,
      reason: 'past-modified',
      message:
        `過去日のエントリの中身が${modified.length}件変化しています(バグ)。書き込みを中止します。` +
        ` 例: ${describe(modified[0])}`,
      ...empty,
    };
  }

  // 3) ここまで来れば「中身は完全に同じ」。残りは並びの変化なので、数えて呼び出し側に返す。
  const { moved, movedRows } = countReordered(pb, pa);
  const reorderedByVenue = {};
  for (const t of movedRows) reorderedByVenue[t.venueId] = (reorderedByVenue[t.venueId] || 0) + 1;

  const blocks = blockCounts(before);
  const splitVenues = {};
  for (const [venueId, n] of blocks) {
    if (n > 1 && targets.has(venueId)) splitVenues[venueId] = n;
  }

  return { ok: true, reason: null, message: null, reordered: moved, reorderedByVenue, splitVenues };
}

function describe(t) {
  return `${t.venueId} / ${t.date} / ${t.start || '開始時刻なし'} / ${t.name} (id=${t.id})`;
}

/**
 * 判定を人が読む行にする。**並びが変わっていない実行でも必ず1行出す。**
 *
 * 【★0件でも出すこと★】「変化があったときだけ出す」設計にすると、
 * 出力そのものが壊れたときに **静かに何も出なくなる**（この案件が繰り返し潰してきた
 * 「鳴らない警報」そのもの）。毎回1行出ていれば、消えたことに気付ける。
 */
function formatReorderReport(verdict, prefix) {
  const p = prefix ? `${prefix} ` : '';
  if (!verdict.ok) return [];
  if (verdict.reordered === 0) {
    return [`${p}過去日の並び: 変化なし(0行)`];
  }
  const by = Object.entries(verdict.reorderedByVenue)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v} ${n}行`)
    .join(' / ');
  const split = Object.entries(verdict.splitVenues)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v}(${n}ブロック)`)
    .join(' / ');
  const lines = [
    `${p}過去日の並び: ${verdict.reordered}行の位置が変わりました(中身・件数は変わっていません)`,
    `${p}  内訳: ${by}`,
  ];
  if (split) {
    lines.push(
      `${p}  理由: data.js 内で行が2つ以上に分かれていた店を、マージが1か所にまとめたためです: ${split}`
    );
    lines.push(
      `${p}  この並べ直しは店ごとに一度きりです(次回以降は0行)。翌月分をまとめて登録すると再び分かれます。`
    );
  }
  lines.push(
    `${p}  ※配列順は掲載内容を変えません(サイトは描画時に日付順で並べ替えます)。` +
      `ただし同じ日・同じ開始時刻の行どうしの上下は入れ替わることがあります。`
  );
  return lines;
}

module.exports = {
  checkNothingElseChanged,
  formatReorderReport,
  countReordered,
  blockCounts,
};
