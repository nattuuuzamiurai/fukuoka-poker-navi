/**
 * recurring-dedupe.js — 「自動取込と重なった定期開催(RECURRING)の行は出さない」判定の【唯一の所有者】
 *
 * 【何を解決するか】
 *   店の予約システム(Waitinglist)から自動取込んだ日程(source:'auto')と、こちらが手で登録した
 *   毎週固定の定期開催(RECURRING)は、同じ大会を指していることがある。両方を並べると
 *   同じ枠が2行になる。
 *
 *     8月2日（日）
 *       16:10  2000 Turbo      ターボ  ¥2,000  30,000点   ← 自動取込(source:'auto')
 *       16:10  Turbo 毎週日曜  ターボ  ¥2,000  30,000点   ← RECURRING の展開行
 *
 *   矛盾した情報ではない(開始時刻・参加費・スタックまで一致している)が、トップの一覧には
 *   「毎週◯曜」バッジが無く、副文言だけが食い違うため【16:10開始の別大会が2つある】ように読める。
 *   日程を正確に一覧できることが売りの媒体で、同じ大会が2行に見えるのは1行足りないより信用を損なう。
 *   「今月の開催数」も水増しされる。
 *
 * 【規則(意図的にここまで狭くしてある。広げないこと)】
 *   その店の source:'auto' のエントリと (venueId, date, 開始時刻) が【完全に一致する】
 *   RECURRING の展開行だけを出さない。残す側は必ず自動取込のほう(店自身の予約システムが正)。
 *
 *   ★ 広げてはいけない理由 ★
 *   1. TOURNAMENTS 同士の同時刻衝突には一切触れない。実データには
 *        - v33 2026-07-10 19:00 「FPC AJPC DAY1」(¥0, source:'semi') と
 *          RECURRING 金曜19:00「JOPT福岡サテライト」(¥4,000) … 参加費が違う【別の大会】
 *        - v35 の5件(7/4, 7/10, 7/11, 7/12, 7/25) … いずれも start が空文字同士
 *      がある。前者は source が 'auto' でないので対象外、後者は TOURNAMENTS 同士なので対象外。
 *      どちらもこの規則では消えない。
 *   2. 「自動取込がある期間は RECURRING を丸ごと止める」形にしてはいけない。APIは店が
 *      登録したぶんしか返さないため、登録が無い曜日(v19 なら土曜 Deep Stack・月曜 Free Roll)が
 *      全滅する(実測で 28行 → 9行)。【一致した行だけ】を落とすこと。
 *   3. 開始時刻が確定していない行(空文字・"未定")は鍵にしない。空文字同士を一致とみなすと、
 *      無関係な大会が消える。
 *
 * 【なぜ独立したファイルなのか — 2箇所で同じ判定をするため】
 *   RECURRING の展開は2箇所にあり、生成するフィールドも既に違う。
 *     - tools/venue-schedule.js の vpRows()  … 静的な店舗ページ(生成時のNode + 閲覧時のブラウザ)
 *     - index.html の expandRecurring()      … トップのSPA(閲覧時のブラウザ)
 *   同じ判定を2つ書くと必ず片方が古くなる。PR #15 が潰した不整合の再導入になるので、
 *   判定は【このファイル1本】に寄せ、3つの実行環境がすべて同じバイト列を読む形にした。
 *     - Node          … tools/venue-schedule.js が require する
 *     - 店舗ページ    … 生成HTMLが <script src="/recurring-dedupe.js"> で読む
 *     - トップのSPA   … index.html が <script src="recurring-dedupe.js"> で読む
 *   data.js / big-events.js と同じ「ブラウザからも Node からも読める素のJS」なのでリポジトリ直下に置く。
 *   ES5で書いているのは、店舗ページに埋め込まれる SCHEDULE_JS と同じ水準に合わせるため。
 *
 * 【auto-import-stores.json との関係】
 *   規則の原文は「auto-import-stores.json に載っている店について…」だが、判定はその一段細かい
 *   【エントリ自身が source:'auto' であること】で行っている。理由:
 *     - ブラウザは JSON を同期的に読めない。店リストを index.html に写すと、
 *       「判定を2箇所に書かない」ために避けたはずのズレが今度はデータ側で起きる。
 *     - source:'auto' を書くのは tools/import-waitinglist.js だけ(Instagram監視は 'semi')。
 *       つまり「その店の予約システムから来た行」という signal はエントリ自身が持っている。
 *     - 抑止されるのは「自動取込の行と時刻まで一致する行」だけなので、店リストで絞っても
 *       結果は変わらない(リストに載っていて auto エントリが無い店 → 抑止対象が存在しない)。
 *   唯一ずれるのは「取込を止めたのに過去の auto エントリが残っている店」。この場合も
 *   その日付には auto の行が実際に表示されているので、重複でも欠落でもない。
 *   ずれが起きていないことは auditAutoStores()(Node専用)が生成時に照合して警告する。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  else if (root) { root.RecurringDedupe = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 開始時刻を比較できる形にそろえる。"9:30" → "09:30"。
     HH:MM として読めないもの(空文字・null・"未定")は '' を返し、鍵に使わない
     = そういう行は絶対に抑止されない。 */
  function normStart(s) {
    if (s == null) return '';
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return '';
    return (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
  }

  function keyOf(venueId, date, start) {
    return String(venueId) + '|' + String(date) + '|' + start;
  }

  /* 抑止した行の記録。(venueId, date, start) で上書きするので、同じ描画を何度繰り返しても増えない
     (SPAは月を切り替えるたびに展開し直す)。 */
  var LOG = {};

  var cacheSrc = null, cacheIdx = null;

  /* source:'auto' のエントリを (venueId|date|開始時刻) で引ける形にする。
     同じ配列で何度も呼ばれる(SPAの描き直し)ので、配列の同一性でキャッシュする。 */
  function autoIndex(tournaments) {
    if (tournaments === cacheSrc) return cacheIdx;
    var idx = {}, i, t, s, k;
    for (i = 0; i < tournaments.length; i++) {
      t = tournaments[i];
      if (!t || t.source !== 'auto') continue;
      s = normStart(t.start);
      if (!s || !t.date) continue;          // 時刻が確定していない行は鍵にしない
      k = keyOf(t.venueId, t.date, s);
      if (!idx[k]) idx[k] = t;              // 先勝ち。名前の記録に実体を使う
    }
    cacheSrc = tournaments; cacheIdx = idx;
    return idx;
  }

  /**
   * RECURRING を日付に展開した行(rows)から、自動取込と同じ枠のものを取り除いて返す。
   * tournaments は絞り込まない全体を渡してよい(日付まで一致しないと当たらないため結果は同じ)。
   * 元の配列は書き換えない。
   */
  function filterExpanded(tournaments, rows) {
    if (!tournaments || !tournaments.length || !rows || !rows.length) return rows || [];
    var idx = autoIndex(tournaments), out = [], i, r, s, hit;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      /* ★ 展開行が venueId を持っていないと鍵が作れず、判定が【黙って空振りする】。
         2箇所の展開(tools/venue-schedule.js の vpExpandRecurring / index.html の expandRecurring)は
         元々そろっていなかった(静的側は venueId を持っていなかった)。同じ事故を二度起こさないよう、
         見つけ次第落とす。動かなくなるのは生成時か開発時で、公開後に静かに重複が戻ることはない。 */
      if (!r || r.venueId == null || r.venueId === '') {
        throw new Error('recurring-dedupe: 展開行に venueId がありません（判定が空振りします）: ' + JSON.stringify(r));
      }
      s = normStart(r.start);
      hit = s ? idx[keyOf(r.venueId, r.date, s)] : null;
      if (!hit) { out.push(r); continue; }
      /* 名前が食い違うことはある(API「2000 Turbo」/ 定期「Turbo」)。
         店自身の予約システムが正なのでAPI版を残し、食い違いは記録に残す。 */
      LOG[keyOf(r.venueId, r.date, s)] = {
        venueId: r.venueId, date: r.date, start: s,
        recurringName: String(r.name == null ? '' : r.name),
        autoName: String(hit.name == null ? '' : hit.name),
        autoId: hit.id == null ? null : String(hit.id)
      };
    }
    return out;
  }

  /** 抑止した行の件数と内訳。ログ出力用。 */
  function summary() {
    var keys = Object.keys(LOG).sort(), rows = [], byVenue = {}, mismatch = 0, i, e;
    for (i = 0; i < keys.length; i++) {
      e = LOG[keys[i]];
      rows.push(e);
      byVenue[e.venueId] = (byVenue[e.venueId] || 0) + 1;
      if (e.recurringName !== e.autoName) mismatch++;
    }
    var parts = Object.keys(byVenue).sort().map(function (v) { return v + ' ' + byVenue[v] + '件'; });
    return {
      count: rows.length,
      byVenue: byVenue,
      nameMismatch: mismatch,
      rows: rows,
      text: parts.join(' / ') + (mismatch ? '（うち名前が食い違うもの ' + mismatch + '件）' : '')
    };
  }

  /** 抑止の内訳を1行1件で返す(生成スクリプトのログ用)。 */
  function detailLines() {
    return summary().rows.map(function (e) {
      return '  - ' + e.venueId + ' ' + e.date + ' ' + e.start
        + ' 「' + e.recurringName + '」(定期) を非表示 ← 「' + e.autoName + '」(' + e.autoId + ', 自動取込) を採用'
        + (e.recurringName === e.autoName ? '' : '  ※名前が違う');
    });
  }

  function reset() { LOG = {}; cacheSrc = null; cacheIdx = null; }

  /**
   * 【Node専用・振る舞いには影響しない】auto-import-stores.json と data.js の食い違いを照合する。
   *   判定そのものは source:'auto' で行っているので、ここは監査のためだけにある(上のコメント参照)。
   *   返り値は警告文の配列。空なら食い違い無し。
   */
  function auditAutoStores(tournaments, storesJson) {
    var listed = {}, seen = {}, warn = [], i;
    var stores = (storesJson && storesJson.stores) || [];
    for (i = 0; i < stores.length; i++) listed[stores[i].venueId] = stores[i].label || stores[i].venueId;
    for (i = 0; i < tournaments.length; i++) {
      if (tournaments[i] && tournaments[i].source === 'auto') seen[tournaments[i].venueId] = true;
    }
    Object.keys(seen).sort().forEach(function (v) {
      if (!listed[v]) {
        warn.push(v + ': source:\'auto\' のエントリがあるのに auto-import-stores.json に載っていません'
          + '（取込を止めた店の古いエントリが残っている可能性）');
      }
    });
    return warn;
  }

  return {
    normStart: normStart,
    filterExpanded: filterExpanded,
    summary: summary,
    detailLines: detailLines,
    reset: reset,
    auditAutoStores: auditAutoStores
  };
});
