/* ============================================================
 * big-events.js — 大型イベント(WJPT / JOPT / FST …)のレジストリと掲載期間の共通判定
 *
 * ■ このファイルが「会期(days)」と「掲載期間ルール」の唯一の正。
 *   - トップページ(index.html)のバナー           … visibleBigEvents() が返す全件
 *   - トップページのフッター「大会特集」          … footerBigEvent()   が返す1件
 *   - 静的イベントページ(events/<slug>/)のフッター … footerBigEvent()   が返す1件
 *   判定を各所に書き散らさない(終了した大会が出しっぱなしになる事故を防ぐ)。
 *
 * ■ 掲載期間ルール(社長指示・2026-07-29)
 *   各イベントの掲載ウィンドウは **他のイベントを一切参照せず独立** して決まる。
 *     - 掲載開始日 = そのイベントの **初日 − 14日**
 *     - 掲載終了日 = そのイベントの **最終日 + 1日**(その日は含む)
 *         … 大型大会は日付を跨いで進行することがあるため、最終日の翌日までは載せ続ける
 *   ⇒ 掲載期間は **重なってよい**。トップのバナーは同時に複数件出る(社長了承済み)。
 *   ⇒ 逆に、どのウィンドウにも入らない期間はバナー0件になる(例: 2026-08-18〜09-04)。
 *      これは仕様であってバグではない。埋めようとしないこと。
 *
 * ■ フッターの「大会特集」だけは掲載ウィンドウに縛られない(footerBigEvent を参照)。
 *   バナーが0件の期間でも「次の大会」を1件出し続ける。
 *
 * ■ 大会を追加するときは下の BIG_EVENTS に1エントリ足すだけでよい。
 *   掲載期間は会期から自動計算されるので、個別の表示ロジックは書かないこと。
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
    id: 'nippon',
    label: 'NIPPON SERIES 福岡 2026',
    days: ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'],
    featureUrl: '/events/nippon-series-2026-fukuoka/',
    hash: '#nippon',
    banner: 'img/nippon-series/nippon-series-banner.svg',
    bannerAlt: 'NIPPON SERIES FUKUOKA 2026 8.11-8.16 福岡 トヨタホールスカラエスパシオ',
    bannerDesc: '福岡・渡辺通／全38イベント',
    bannerClass: 'ev-nippon'
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
// ★★ 掲載ウィンドウと「開催中/終了」の判定は、しきい値が意図的に1日ずれている ★★
//   これはバグではなく社長指示による仕様(2026-07-29)。将来「ズレている」と思って揃えないこと。
//
//   ┌ 掲載ウィンドウ(出すか出さないか) … 最終日の【翌日】まで = eventShowUntil()
//   │   大型大会は日付を跨いで進行することがあるため、翌日までは載せ続ける。
//   └ 開催中/終了(どう見せるか)        … 最終日までが開催中、【翌日から終了】 = isEventArchived()
//       社長の言葉:「掲載してほしいだけで次の日はバナーは終了でいいです」
//
//   ⇒ 最終日の翌日は「バナーは出るが、終了状態(暗転・終了バッジ)で表示される」が正解。
//     同じ日、イベント専用ページには通常どおり「このイベントは終了しました」を出す。

// 掲載開始日 = 会期初日の14日前 / 掲載終了日 = 会期最終日の翌日(どちらもその日を含む)
const BANNER_LEAD_DAYS = 14;
const eventShowFrom = days => {
  const first = eventFirstDay(days);
  return first ? shiftDateStr(first, -BANNER_LEAD_DAYS) : null;
};
const eventShowUntil = days => {
  const last = eventLastDay(days);
  return last ? shiftDateStr(last, 1) : null;
};
// 会期最終日を過ぎたイベントは「終了(アーカイブ=開催当時の記録)」として扱う。
// バナーの見た目もページ内の文言の出し分けも、日付比較を各所に書かず必ずこの関数を通すこと。
const isEventArchived = (days, today) => {
  const last = eventLastDay(days);
  return !!last && (today || localTodayGlobal()) > last;
};
// 会期中(初日〜最終日)か
const isEventOngoing = (days, today) => {
  const t = today || localTodayGlobal();
  const first = eventFirstDay(days), last = eventLastDay(days);
  return !!first && t >= first && t <= last;
};

// ---- 掲載期間(掲載開始日〜掲載終了日)の計算 ----
// 各イベント独立。他イベントを参照しないので、レジストリの並び順にも依存しない。
// 戻り値: [{ event, from, to }] を掲載開始日の昇順で返す。
function bigEventWindows(events) {
  return (events || BIG_EVENTS)
    .filter(e => eventFirstDay(e.days) && eventLastDay(e.days))
    .map(e => ({ event: e, from: eventShowFrom(e.days), to: eventShowUntil(e.days) }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

// トップのバナー領域に出すイベント(0件〜複数件)。掲載ウィンドウに入っているものすべて。
// 並び順は ①開催中 → ②まもなく(初日の近い順) → ③終了(猶予日) で、終了したものを末尾に置く。
function visibleBigEvents(today, events) {
  const t = today || localTodayGlobal();
  const rank = e => isEventOngoing(e.days, t) ? 0 : (isEventArchived(e.days, t) ? 2 : 1);
  return bigEventWindows(events)
    .filter(w => t >= w.from && t <= w.to)
    .map(w => w.event)
    .sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      // 開催中どうしは終わりが早い順、まもなくは初日が近い順、終了は新しい順
      if (ra === 0) return eventLastDay(a.days).localeCompare(eventLastDay(b.days));
      if (ra === 1) return eventFirstDay(a.days).localeCompare(eventFirstDay(b.days));
      return eventLastDay(b.days).localeCompare(eventLastDay(a.days));
    });
}

// フッター「大会特集」に出す1件。開催中があればそれ(複数なら最終日が早い方)、
// 無ければ次の大会(初日が最も近い未来)。どちらも無ければ null。
// ※ここは掲載ウィンドウ(初日−14日)に縛られない。バナーが0件の期間でも
//   「次の大会」を出し続けるため(社長指示・2026-07-29)。バナーと一致しない日がある。
//   猶予日(最終日の翌日)のイベントは終了扱いなので「開催中」には含めない。
function footerBigEvent(today, events) {
  const t = today || localTodayGlobal();
  const list = (events || BIG_EVENTS).filter(e => eventFirstDay(e.days) && eventLastDay(e.days));
  const ongoing = list.filter(e => isEventOngoing(e.days, t))
    .sort((a, b) => eventLastDay(a.days).localeCompare(eventLastDay(b.days)));
  if (ongoing.length) return ongoing[0];
  const upcoming = list.filter(e => t < eventFirstDay(e.days))
    .sort((a, b) => eventFirstDay(a.days).localeCompare(eventFirstDay(b.days)));
  return upcoming.length ? upcoming[0] : null;
}

// ---- 大型一覧(#majors)に並べるイベント ----
// 未開催・開催中は全件、終了済みは【新しい順に maxArchived 件まで】(既定3件)。それより古いものは出さない。
// 並びは会期の古い順(画面の上から 過去 → 未来)。
// レジストリにエントリを足せば自動でここに載るので、一覧側に個別の書き足しは不要。
function bigEventListForIndex(today, maxArchived) {
  const t = today || localTodayGlobal();
  const max = (maxArchived === undefined || maxArchived === null) ? 3 : maxArchived;
  const sorted = BIG_EVENTS
    .filter(e => eventLastDay(e.days))
    .slice()
    .sort((a, b) => eventLastDay(a.days).localeCompare(eventLastDay(b.days)));
  const ended = sorted.filter(e => isEventArchived(e.days, t));
  const live = sorted.filter(e => !isEventArchived(e.days, t));
  // slice(-0) は配列全体を返してしまうため、0件指定は明示的に空配列にする(境界のバグ防止)
  const keptEnded = max <= 0 ? [] : ended.slice(-max);
  return keptEnded.concat(live).map(e => ({ event: e, archived: isEventArchived(e.days, t) }));
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
// トップのバナー(visibleBigEvents)とは判定条件が違うため、一致しない日がある(仕様)。
function mountBigEventFooter(elId, today) {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(elId || 'evtFeature');
  if (!el) return null;
  const ev = footerBigEvent(today);
  if (!ev) { el.innerHTML = ''; el.style.display = 'none'; return null; }
  el.innerHTML = '大会特集: <a href="' + ev.featureUrl + '">' + ev.label + '</a>';
  el.style.display = '';
  return ev;
}

if (typeof module !== 'undefined') {
  module.exports = {
    BIG_EVENTS, BANNER_LEAD_DAYS, localTodayGlobal, shiftDateStr,
    eventFirstDay, eventLastDay, eventShowFrom, eventShowUntil,
    isEventArchived, isEventOngoing,
    bigEventWindows, visibleBigEvents, footerBigEvent,
    bigEventListForIndex, bigEventById, bigEventDays
  };
}
