/* ============================================================
 * listing-banner.js — 掲載店舗募集の常設バナー(トップページ最上部)
 *
 * ■ なぜ big-events.js / promo-banners.js に混ぜないのか(2026-09-17導入)
 *   BIG_EVENTS / PROMO_BANNERS はどちらも「会期(days)」を持つことを前提に、
 *   掲載開始日・終了日を自動計算する仕組み(big-events.jsの日付ヘルパー)と一体になっている。
 *   このバナーは日付を持たない常設の自社告知(掲載店舗の募集)で性質がまったく違うため、
 *   promo-banners.js冒頭のコメントと同じ考え方で、専用ファイル1本にした。
 *
 * ■ 表示順
 *   他の告知(大型大会・単発プロモ)が1件でもあれば、そのすべての【後ろ(最後尾)】に付く。
 *   他に告知が0件ならこのバナー単体で表示する(index.html の renderBigEventBanner() 側で
 *   `promos.concat(visibleBigEvents()).concat(visibleListingBanner())` として連結する)。
 *
 * ■ 状態バッジなし
 *   days を持たないため「開催中/まもなく/終了」のバッジは出さない。CSS側で
 *   `.evtBanner.ev-listing .eb-tag::before{content:none}` として打ち消している。
 *
 * ■ 見た目
 *   実写真が無いため、他のバナーのような画像(<img>)ではなくCSSで組む。
 *   bigEventBannerHtml()(index.html)側に `ev.customBanner` を見た分岐を1つ追加している
 *   (既存の画像バナー呼び出しはすべて今まで通り)。
 *
 * ■ 表示のオン/オフは下の LISTING_BANNER_ENABLED を切り替えるだけでよい。
 *
 * ■ リンク先(2026-09-19変更)
 *   以前は contact.html?type=listing(お問い合わせフォームへ直接遷移)にリンクしていたが、
 *   店舗掲載・PR枠の案内ページ(guide/partners/)を新設したことに伴い、まずそちらで内容を
 *   見てもらってから問い合わせに進んでもらう動線に変更した。guide/partners/index.html側の
 *   お問い合わせ導線(PR掲載枠/経営管理ダッシュボードそれぞれ)は引き続き
 *   contact.html?type=listing・?type=dashboard を使う。
 * ============================================================ */

const LISTING_BANNER_ENABLED = true;

const LISTING_BANNER = {
  id: 'listing-recruit',
  label: '掲載店舗募集',                        // カルーセルのドット(aria-label)で使う。index.html の ec-dots が ev.label を読む
  href: 'guide/partners/',
  bannerClass: 'ev-listing',
  customBanner: true,                          // 画像を使わずCSSで組む(bigEventBannerHtml側の分岐)
  eyebrow: '掲載店舗様へ',
  heading: 'この枠に、あなたのお店の告知を',
  sub: 'トップページの目立つ場所に掲載できます',
  bannerDesc: 'お店の告知バナー、掲載受付中',    // eb-tagに出す下部説明文
  btnText: '詳しくは →'
};

// トップのバナー領域に出すか(0件 or 1件)。第1引数はテスト用の差し替え口
// (省略時は本番の LISTING_BANNER_ENABLED を使う。promo-banners.js/big-events.js の
// today/promos 引数と同じ考え方)。
function visibleListingBanner(enabledOverride) {
  const on = (enabledOverride === undefined) ? LISTING_BANNER_ENABLED : enabledOverride;
  return on ? [LISTING_BANNER] : [];
}

if (typeof module !== 'undefined') {
  module.exports = { LISTING_BANNER_ENABLED, LISTING_BANNER, visibleListingBanner };
}
