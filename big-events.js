/* ============================================================
 * big-events.js — 大型イベント(WJPT / JOPT / FST …)のレジストリと掲載期間の共通判定
 *
 * ■ このファイルが「会期(days)」と「掲載期間ルール」の唯一の正。
 *   - トップページ(index.html)のバナー
 *   - トップページのフッター「大会特集」
 *   - 静的イベントページ(events/<slug>/index.html)のフッター「大会特集」
 *   はすべて activeBigEvent() が選んだ **同じ1件** だけを表示する。
 *   判定を各所に書き散らさない(バナーとフッターが食い違う・終了した大会が残る事故を防ぐ)。
 *
 * ■ 掲載期間ルール(社長指示・2026-07-29)
 *   - 掲載終了日 = そのイベントの最終日の翌日(その日は含む)
 *       … 大型大会は日付を跨いで進行することがあるため、最終日の翌日までは載せ続ける
 *   - 掲載開始日 = 直前のイベントの掲載終了日の翌日(= 直前イベントの最終日 + 2日)
 *       … 直前のイベントが無ければ下限なし
 *   ⇒ 同時に表示される大型イベントは常に **最大1件**。
 *     該当が無ければ(次の大会が未登録なら)何も表示しない。
 *
 * ■ 大会を追加するときは下の BIG_EVENTS に1エントリ足すだけでよい。
 *   掲載期間は前後のイベントから自動計算されるので、個別の表示ロジックは書かないこと。
 *   詳しい手順は README.md「大型イベントの追加手順と掲載期間ルール」を参照。
 * ============================================================ */

const BIG_EVENTS = [
  {
    id: 'wjpt',
    label: 'WJPT 2026',                       // フッター「大会特集」の表示名
    days: ['2026-07-18', '2026-07-19', '2026-07-20'],
    featureUrl: '/events/wjpt-2026/',         // フッターのリンク先(サイトルート起点)
    hash: '#wjpt',                            // トップページ内の特集ページ(バナーのリンク先)
    banner: 'img/wjpt/wjpt-banner.jpg',
    bannerAlt: 'WJPT West Japan Poker Tour 7.18-7.20 北九州',
    bannerDesc: '北九州・全21トーナメント',
    bannerClass: 'ev-wjpt'
  },
  {
    id: 'jopt',
    label: 'JOPT 2026 福岡',
    days: ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'],
    featureUrl: '/events/jopt-2026-fukuoka-01/',
    hash: '#jopt',
    banner: 'img/jopt/jopt-banner.jpg',
    bannerAlt: 'JOPT 2026 Fukuoka #01 7.30-8.2 UNITEDLAB 福岡・大名',
    // 件数はデータ読み込み後に index.html 側が上書きする(jopt-data.js は #jopt を開くまで読まないため)
    bannerDesc: '福岡・大名／全44トーナメント',
    bannerClass: 'ev-jopt'
  },
  {
    id: 'fst',
    label: 'FST 2026 福岡',
    days: ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'],
    // FSTはまだ個別トーナメントが未発表のため静的ページを作っていない。
    // 発表後に events/fst-2026-fukuoka/ を作ったら、この featureUrl をそちらに差し替える。
    featureUrl: '/#fst',
    hash: '#fst',
    banner: 'img/fst/fst-banner.svg',
    bannerAlt: 'FST FUKUOKA SUPER TOURNAMENT 9.19-9.23 ホテルニューオータニ博多',
    bannerDesc: '福岡・渡辺通／怒涛の5日間',
    bannerClass: 'ev-fst'
  }
];

// ---- 日付ユーティリティ(YYYY-MM-DD の文字列比較で完結させる) ----
// 端末のローカル日付。UTCに変換すると日本の深夜に前日扱いになるため必ずローカルで組み立てる。
function localTodayGlobal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
// YYYY-MM-DD を n 日ずらす(月またぎ・年またぎは Date に任せる)
function shiftDateStr(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
// イベントの会期は days(YYYY-MM-DD の配列)で表す。並び順に依存しないよう端ではなく最小値・最大値で求める。
const eventFirstDay = days => (Array.isArray(days) && days.length) ? days.reduce((a, b) => a < b ? a : b) : null;
const eventLastDay = days => (Array.isArray(days) && days.length) ? days.reduce((a, b) => a > b ? a : b) : null;
// 掲載終了日 = 会期最終日の翌日。大型大会は日付を跨いで進行することがあるため、
// この日までは「まだ開催中」として扱う(バナーも特集ページの文言も同じ日に切り替わる)。
const eventShowUntil = days => {
  const last = eventLastDay(days);
  return last ? shiftDateStr(last, 1) : null;
};
// 掲載終了日を過ぎたイベントは「アーカイブ(開催当時の記録)」として扱う。
// バナーの表示可否もページ内の文言の出し分けも、日付比較を各所に書かず必ずこの関数を通すこと。
const isEventArchived = (days, today) => {
  const until = eventShowUntil(days);
  return !!until && (today || localTodayGlobal()) > until;
};

// ---- 掲載期間(掲載開始日〜掲載終了日)の計算 ----
// レジストリの並び順には依存させず、必ず「最終日」でソートしてから前後関係を決める。
// 戻り値: [{ event, from(null=下限なし), to }] を最終日の昇順で返す。
function bigEventWindows(events) {
  const list = (events || BIG_EVENTS)
    .filter(e => eventLastDay(e.days))
    .slice()
    .sort((a, b) => eventLastDay(a.days).localeCompare(eventLastDay(b.days)));
  let prevTo = null;
  return list.map(e => {
    const to = eventShowUntil(e.days);                    // 最終日の翌日まで掲載
    const from = prevTo ? shiftDateStr(prevTo, 1) : null; // 直前イベントの掲載終了日の翌日から
    prevTo = to;
    return { event: e, from, to };
  });
}

// 今日(または指定日)に掲載すべき大型イベントを1件だけ返す。該当が無ければ null。
// 掲載期間は互いに重ならないよう組み立てているので、最初に一致したものを返せばよい。
// ※会期が完全に重なる大会を登録すると from > to の空区間になり、その大会は表示されない。
//   同時期の大会を並べたい場合はこのルール自体の見直しが必要(社長確認事項)。
function activeBigEvent(today, events) {
  const t = today || localTodayGlobal();
  const hit = bigEventWindows(events).find(w => (w.from === null || t >= w.from) && t <= w.to);
  return hit ? hit.event : null;
}

function bigEventById(id) {
  return BIG_EVENTS.find(e => e.id === id) || null;
}
function bigEventDays(id) {
  const e = bigEventById(id);
  return e ? e.days.slice() : [];
}

// ---- フッター「大会特集」の描画(トップページ・静的ページ共通) ----
// 開催中の大会、開催中が無ければ次の大会を1件だけ出す。該当が無ければ行ごと隠す。
// バナーと同じ activeBigEvent() を使うので、両者は必ず一致する。
function mountBigEventFooter(elId, today) {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(elId || 'evtFeature');
  if (!el) return null;
  const ev = activeBigEvent(today);
  if (!ev) { el.innerHTML = ''; el.style.display = 'none'; return null; }
  el.innerHTML = '大会特集: <a href="' + ev.featureUrl + '">' + ev.label + '</a>';
  el.style.display = '';
  return ev;
}

if (typeof module !== 'undefined') {
  module.exports = {
    BIG_EVENTS, localTodayGlobal, shiftDateStr,
    eventFirstDay, eventLastDay, eventShowUntil, isEventArchived,
    bigEventWindows, activeBigEvent, bigEventById, bigEventDays
  };
}
