/* ============================================================
 * promo-banners.js — 単発の店舗プロモーション(グランドオープン記念など)専用の小さなレジストリ
 *
 * ■ なぜ big-events.js の BIG_EVENTS に混ぜないのか
 *   (依頼・2026-09-02「CASINO BAR DreaM グランドオープン記念ポーカートーナメント」で新設)
 *   BIG_EVENTS は「外部主催・複数日開催の大型大会」を前提に、サテライト開催店舗の集計・
 *   大型一覧ページ(#majors)・フッター「大会特集」のローテーションまで一体で紐づいている
 *   (big-events.js冒頭のコメント参照)。DreaMのグランドオープン企画は「単一店舗・単日」で
 *   性質がまったく違うため、そのままBIG_EVENTSに1エントリ足すと、
 *     - サテライト開催店舗の集計対象になってしまう(店舗が1つしかないのに集計する意味がない)
 *     - 大型大会と並んで #majors の一覧に載ってしまう
 *     - フッター「大会特集」が「次の大会」として日本シリーズ等と同列にローテーションしてしまう
 *   といった、大型大会前提のロジックに巻き込まれる。そこで【トップのバナー枠に差し込むことだけ】
 *   を目的にした、このファイル1本を新設した。
 *
 * ■ 掲載期間の判定ロジックは1箇所に集約する(big-events.jsと同じ設計思想)
 *   日付の組み立て・「開催中/終了」の判定そのもの(shiftDateStr / eventFirstDay / eventLastDay /
 *   eventShowUntil / isEventArchived / isEventOngoing / localTodayGlobal)は
 *   big-events.js が引き続き唯一の所有者。このファイルはそれらをそのまま使い、
 *   「掲載開始日を初日の何日前にするか」というプロモ側だけのパラメータ(PROMO_LEAD_DAYS)と、
 *   プロモの一覧(PROMO_BANNERS)だけを持つ。日付比較のコードをここで書き足さないこと。
 *
 * ■ 掲載期間ルール(社長了承済み・2026-09-02)
 *     - 掲載開始日 = そのプロモの初日 − PROMO_LEAD_DAYS 日
 *     - 掲載終了日 = そのプロモの最終日 + 1日(その日は含む) … big-events.js の eventShowUntil と同じ式
 *   大型大会は「初日−30日」だが、DreaMは単発1日イベントなので14日に短縮している
 *   (DreaM: 初日2026-09-05 → 掲載開始2026-08-22、最終日2026-09-05 → 掲載終了2026-09-06)。
 *   ★ 最終日+1(=最終日の翌日)は big-events.js と同じ仕様で「バナーは出るが終了状態(暗転+
 *     「終了」バッジ)」になる(isEventArchived は最終日を過ぎたら真を返すため)。揃えないこと。
 *
 * ■ トップページ(index.html)側の使い方
 *   renderBigEventBanner() が visiblePromoBanners() の結果を visibleBigEvents() の
 *   【結果の先頭に連結】して描画する。「常に大型大会より先頭(1枚目)」はこの連結順で実現している
 *   (visibleBigEvents() 側の開催中/まもなく/終了の並び替えロジックには一切手を入れない)。
 *   バナー1枚分のHTML生成(bigEventBannerHtml())・横スライド機構
 *   (.evtCarousel/.ec-slide/initBigEventCarousel())はどちらも index.html 側の既存の仕組みを
 *   そのまま共用する(新しいUIは作らない)。プロモのバナーはハッシュ内遷移ではなく実ページへの
 *   リンクなので、BIG_EVENTSの `hash`(例 '#fst')の代わりに `href`(例 '/events/...')を持つ。
 *
 * ■ 新しいプロモを追加するときは下の PROMO_BANNERS に1エントリ足すだけでよい。
 * ============================================================ */

// Node実行時(tools/gen-sitemap.js 等)は big-events.js が export する関数を _BE 経由で参照する。
// ブラウザでは index.html がこのファイルより先に big-events.js を読み込むため
// (<script src="big-events.js"> → <script src="promo-banners.js">)、eventFirstDay 等は
// すでにこのスクリプトと同じトップレベルの字句スコープに存在している。
//
// ★★2026-09-02の本番障害・再発防止(重要)★★
//   以前はここで `var eventFirstDay = BE.eventFirstDay;` のように big-events.js と
//   【同じ名前】でNode用のローカル変数を宣言していた。ブラウザの複数の<script>タグは
//   同じページ内でグローバルな字句スコープを共有するため、if文の中の var 宣言であっても
//   【実行されなくても】構文解析の時点でスクリプト全体にホイスティングされ、
//   big-events.js側の `const eventFirstDay = …` と名前が衝突して
//   `Uncaught SyntaxError: Identifier 'eventFirstDay' has already been declared` になり、
//   このファイル全体(PROMO_BANNERSごと)が読み込めずDreaMのバナーが出なくなった
//   (node --test はCommonJSでファイルごとにスコープが独立するため検知できず、
//   本番デプロイ後に実際のブラウザで初めて発覚した)。
//   そのため、Node向けのrequire結果は `_BE` という【big-events.js側と衝突しない別名】
//   1つだけをトップレベルで宣言し、このファイルで使う各関数もすべて `_` を付けた別名
//   (`_eventFirstDay` 等)に束ねる。ブラウザでは `_BE` が null になるので、素の識別子
//   (big-events.jsがすでに宣言済みのもの)に読みにいくだけで新しい宣言は増やさない。
//   ★同じ名前の var/let/const をここに追加しないこと。★
const _BE = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./big-events.js')
  : null;
const _eventFirstDay = _BE ? _BE.eventFirstDay : eventFirstDay;
const _eventLastDay = _BE ? _BE.eventLastDay : eventLastDay;
const _shiftDateStr = _BE ? _BE.shiftDateStr : shiftDateStr;
const _eventShowUntil = _BE ? _BE.eventShowUntil : eventShowUntil;
const _localTodayGlobal = _BE ? _BE.localTodayGlobal : localTodayGlobal;

const PROMO_BANNERS = [
  {
    id: 'dream-grandopen-2026',
    label: 'DreaM グランドオープン記念',         // カルーセルのドット(aria-label)で使う。index.html の ec-dots が ev.label を読む
    days: ['2026-09-05'],                       // 単日開催
    href: '/events/dream-grandopen-2026/',      // バナーのリンク先(実ページ。BIG_EVENTSの hash と違い遷移先はトップのハッシュ内ではない)
    banner: 'img/dream/dream-grandopen-banner.jpg',
    bannerAlt: 'CASINO BAR DreaM グランドオープン記念ポーカートーナメント 9.5 久留米',
    bannerDesc: '久留米・グランドオープン記念',
    bannerClass: 'ev-dream'
  }
];

// 掲載開始日を「初日の何日前」にするか。大型大会(big-events.js の BANNER_LEAD_DAYS=30)より
// 短い、単発1日イベント用の値(社長了承済み・2026-09-02)。
const PROMO_LEAD_DAYS = 14;
const promoShowFrom = days => {
  const first = _eventFirstDay(days);
  return first ? _shiftDateStr(first, -PROMO_LEAD_DAYS) : null;
};

// トップのバナー領域に出すプロモ(0件〜複数件)。掲載ウィンドウに入っているものすべてを、
// 掲載開始日の昇順で返す(big-events.js の bigEventWindows/visibleBigEvents と同じ考え方)。
// 第2引数 promos は big-events.js の visibleBigEvents(today, events) と同じテスト用の差し替え口
// (省略時は本番の PROMO_BANNERS を使う。テストで本番データを書き換えずに境界値を検証できる)。
function visiblePromoBanners(today, promos) {
  const t = today || _localTodayGlobal();
  return (promos || PROMO_BANNERS)
    .filter(p => _eventFirstDay(p.days) && _eventLastDay(p.days))
    .map(p => ({ promo: p, from: promoShowFrom(p.days), to: _eventShowUntil(p.days) }))
    .filter(w => t >= w.from && t <= w.to)
    .sort((a, b) => a.from.localeCompare(b.from))
    .map(w => w.promo);
}

if (typeof module !== 'undefined') {
  module.exports = { PROMO_BANNERS, PROMO_LEAD_DAYS, promoShowFrom, visiblePromoBanners };
}
