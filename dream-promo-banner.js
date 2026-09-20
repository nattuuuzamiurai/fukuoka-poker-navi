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
 * ■ 表示順(2026-09-19修正: 運営判断により大型大会より前に変更)
 *   promo-banners.js 冒頭のコメントにあるとおり、単発プロモ系バナーは【常に大型大会(FST等)より
 *   先頭】に出すのがこのサイトの設計原則。当初 visibleBigEvents() の【後ろ】に連結してしまい、
 *   会期のある大型大会のバナーに埋もれて視認性が下がる状態になっていたため、index.html の
 *   renderBigEventBanner() では
 *   `promos.concat(visibleDreamPromoBanner()).concat(visibleBigEvents()).concat(listing)` として
 *   promo-banners.js のプロモ群のすぐ後ろ・大型大会より前に連結する。
 *
 * ■ PR表示(景品表示法のステマ規制対応)
 *   days を持たないため、bigEventBannerHtml() の「開催中/まもなく/終了」バッジ判定
 *   (isEventArchived/eventFirstDay)はどちらも該当せず、ベースの `.eb-tag::before{content:"開催中"}`
 *   がそのまま残ってしまう(index.html側のコメント参照)。これは実態と異なる表示になるため、
 *   CSS側で `.evtBanner.ev-dream .eb-tag::before{content:"PR"}` として常に「PR」表示に
 *   上書きしている(index.htmlのCSSコメント参照)。
 *
 * ■ 見た目・画像(2026-09-19: 正方形の暫定画像 → 横長(1024×412)の専用画像に差し替え済み)
 *   bannerClass は過去の単発プロモ「DreaM グランドオープン記念」(promo-banners.js)と同じ
 *   `ev-dream`(黒地×ゴールド×赤)を流用する。実写真(フライヤー画像)を使うため customBanner は
 *   使わない(listing-banner.jsと違う点)。
 *   ★ 正方形フライヤー(900×900)をCSSのaspect-ratio+object-fitで横長にクロップ表示すると
 *     画像の一部が欠けて見えたため、クロップ指定を撤去し、最初から横長(1024×412)で
 *     作成した画像を使う方式に変更した(2026-09-19)。img/dream/dream-saturday-tournament.jpg を
 *     差し替え、このファイル自体には imgAspect 等のクロップ指定は持たせていない
 *     (index.html 側の `.evtBanner .eb-img{aspect-ratio:1024/412;object-fit:cover}` が
 *     全バナー共通で高さを揃えるため、個別のバナーごとに指定する必要が無い。
 *     index.htmlの該当コメント参照)。
 *
 * ■ リンク先(2026-09-19修正: 店舗ページ→トーナメント専用ページに変更)
 *   href はこのトーナメント専用の詳細ページ(events/dream-saturday-tournament/)。
 *   来店特典(初回入場無料)の告知もこのページに一本化している
 *   (店舗ページ venues/dream-casinobar-kurume/ 側には特典ボックスを重複掲載しない)。
 *
 * ■ 表示のオン/オフは下の DREAM_PROMO_BANNER_ENABLED を切り替えるだけでよい。
 * ============================================================ */

const DREAM_PROMO_BANNER_ENABLED = true;

const DREAM_PROMO_BANNER = {
  id: 'dream-saturday-tournament',
  label: 'DreaM Saturdayトーナメント',            // カルーセルのドット(aria-label)で使う。index.html の ec-dots が ev.label を読む
  href: '/events/dream-saturday-tournament/',
  bannerClass: 'ev-dream',
  banner: 'img/dream/dream-saturday-tournament.jpg',
  bannerAlt: 'CASINO BAR DreaM Saturdayトーナメント（久留米）',
  bannerDesc: '毎週土曜日・久留米・18時スタート',    // eb-tagに出す下部説明文(ST18:00を明記・2026-09-19追加)
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
