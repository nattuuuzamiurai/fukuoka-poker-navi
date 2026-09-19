/* ============================================================
 * dream-promo-banner.js — CASINO BAR DreaM「Saturdayトーナメント」PR掲載の常設バナー(トップページ)
 *
 * ■ なぜ big-events.js / promo-banners.js に混ぜないのか(2026-09-19導入)
 *   BIG_EVENTS / PROMO_BANNERS はどちらも「会期(days)」を持つことを前提に、
 *   掲載開始日・終了日を自動計算する仕組み(big-events.jsの日付ヘルパー)と一体になっている。
 *   このバナーは特定の日付を持たない常設のPR掲載(毎週土曜開催・単一店舗)で性質が違うため、
 *   listing-banner.js(掲載店舗募集の常設バナー)と同じ考え方で専用ファイル1本にした。
 *   promo-banners.js冒頭のコメントも参照。
 *
 * ■ 表示順
 *   index.html の renderBigEventBanner() が
 *   `promos.concat(visibleBigEvents()).concat(visibleDreamPromoBanner()).concat(listing)` として、
 *   会期のある告知(単発プロモ・大型大会)の【後ろ】・掲載店舗募集バナー(listing-banner.js)の
 *   【前】に連結する。
 *
 * ■ PR表示(景品表示法のステマ規制対応)
 *   days を持たないため、bigEventBannerHtml() の「開催中/まもなく/終了」バッジ判定
 *   (isEventArchived/eventFirstDay)はどちらも該当せず、ベースの `.eb-tag::before{content:"開催中"}`
 *   がそのまま残ってしまう(index.html側のコメント参照)。これは実態と異なる表示になるため、
 *   CSS側で `.evtBanner.ev-dream .eb-tag::before{content:"PR"}` として常に「PR」表示に
 *   上書きしている(index.htmlのCSSコメント参照)。
 *
 * ■ 見た目
 *   bannerClass は過去の単発プロモ「DreaM グランドオープン記念」(promo-banners.js)と同じ
 *   `ev-dream`(黒地×ゴールド×赤)を流用する。実写真(フライヤー画像)を使うため customBanner は
 *   使わない(listing-banner.jsと違う点)。フライヤーは特定の日付を含まない常設デザインなので、
 *   画像そのものの差し替え作業は発生しない。
 *
 * ■ 表示のオン/オフは下の DREAM_PROMO_BANNER_ENABLED を切り替えるだけでよい。
 * ============================================================ */

const DREAM_PROMO_BANNER_ENABLED = true;

const DREAM_PROMO_BANNER = {
  id: 'dream-saturday-tournament',
  label: 'DreaM Saturdayトーナメント',            // カルーセルのドット(aria-label)で使う。index.html の ec-dots が ev.label を読む
  href: '/venues/dream-casinobar-kurume/',
  bannerClass: 'ev-dream',
  banner: 'img/dream/dream-saturday-tournament.jpg',
  imgAspect: '2/1',                              // フライヤーが正方形(900×900)のため表示上トリミングする(index.htmlのbigEventBannerHtml()参照)
  bannerAlt: 'CASINO BAR DreaM Saturdayトーナメント（久留米）',
  bannerDesc: '毎週土曜開催・久留米',              // eb-tagに出す下部説明文
  btnText: '特典を見る →'
};

// トップのバナー領域に出すか(0件 or 1件)。第1引数はテスト用の差し替え口
// (省略時は本番の DREAM_PROMO_BANNER_ENABLED を使う。listing-banner.js と同じ考え方)。
function visibleDreamPromoBanner(enabledOverride) {
  const on = (enabledOverride === undefined) ? DREAM_PROMO_BANNER_ENABLED : enabledOverride;
  return on ? [DREAM_PROMO_BANNER] : [];
}

if (typeof module !== 'undefined') {
  module.exports = { DREAM_PROMO_BANNER_ENABLED, DREAM_PROMO_BANNER, visibleDreamPromoBanner };
}
