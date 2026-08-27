/**
 * site-shell.js — 静的ページ生成スクリプト共通の「ページの外側」
 *
 * 検索から直接着地する静的ページ(events/<slug>/ と venues/<slug>/)は、
 * <head>・GA4タグ・CSS・ヘッダー・フッター・自社広告がまったく同じ作りでなければならない。
 * ここを各生成スクリプトに複製すると「片方だけ直して片方を忘れる」事故が起きる
 * (このリポジトリでは恒久リンク行で実際に2回起きている。README「どこに何が出るか」を参照)。
 * そのため出どころを1つに寄せてある。
 *
 * このファイルは【純粋なモジュール】。require しただけでは何も書き込まない。
 * 読み込むだけで副作用があると、--check のつもりで実行して上書きしてしまうため。
 *
 * 使う側:
 *   - tools/gen-event-pages.js  … 大型イベントの静的ページ
 *   - tools/gen-venue-pages.js  … 店舗の静的ページ
 *   - tools/gen-sitemap.js      … esc/SITE/店舗slugの検査だけ使う
 */

const SITE = 'https://fukuokapoker.com';

// サイト全体の法的ポジショニング文(index.html フッターと同一)。
// 検索から直接着地する静的ページにも必ず載せる。
const POSITIONING = '当サイトは店舗・主催者が公開している情報を集約する媒体であり、賭博行為の勧誘・仲介を行うものではありません。賞品・プライズの取扱いは各店舗・主催者の規定によります。';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { md: `${m}/${d}`, wd: WD[dt.getUTCDay()], y, m, d };
}

// ---- 店舗slugの検査 ----
// slug は /venues/<slug>/ というURLそのものなので、欠け・重複・使えない文字を
// 「生成せずに落ちる」ことで止める。公開後に気づくと直す=URL変更になり被リンクを失う。
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function validateVenueSlugs(VENUES) {
  const problems = [];
  const seen = new Map();
  VENUES.forEach(v => {
    if (!v.slug) {
      problems.push(`${v.id} ${v.name}: slug がありません（data.js の VENUES に "slug" を足してください）`);
      return;
    }
    if (!SLUG_RE.test(v.slug)) {
      problems.push(`${v.id} ${v.name}: slug "${v.slug}" は使えません（ASCII小文字・数字・ハイフンのみ、ハイフンで始まり/終わり/連続しない）`);
    }
    if (seen.has(v.slug)) {
      problems.push(`slug "${v.slug}" が重複しています（${seen.get(v.slug)} と ${v.id}）`);
    }
    seen.set(v.slug, v.id);
  });
  if (problems.length) {
    throw new Error('店舗slugに問題があります:\n  - ' + problems.join('\n  - '));
  }
}

// ---- 大型イベントの恒久内部リンク行 ----
// レジストリ(big-events.js)の全大会を会期の古い順に並べる。
// ★ これは日付で消えてはいけない(SEOのクロール経路・内部リンク評価の土台)。
//   「大会特集」(=その日1件・JS描画)とは役割が別物なので、片方を理由にもう片方を消さないこと。
//   リンク先は featureUrl。静的ページがある大会は静的URL、無い大会(FST等)はトップのハッシュURLになる。
//   レジストリに1エントリ足せばこの行にも自動で増える。
// ★ トップ(index.html)の #evtLinks もこの同じ関数から作る(gen-event-pages.js の buildIndexHtml)。
//   2箇所を別々に手で書いていた頃に、片方だけ直して片方を忘れる事故が2回起きているため。
const LINK_SEP = '　|　';
function permanentEventLinksList(BIG) {
  return BIG.BIG_EVENTS
    .slice()
    .sort((a, b) => String(BIG.eventFirstDay(a.days)).localeCompare(String(BIG.eventFirstDay(b.days))))
    .map(e => ({ url: e.featureUrl, label: esc(e.label) }));
}
function permanentEventLinks(BIG, currentPath) {
  return permanentEventLinksList(BIG)
    .map(e => e.url === currentPath
      // 自分自身のページでは自己リンクにせず現在地として示す
      ? `<span aria-current="page" style="color:#cfd6d1">${e.label}</span>`
      : `<a href="${e.url}">${e.label}</a>`)
    .join(LINK_SEP);
}

// ---- 共通CSS ----
// 静的ページ共通の見た目。トップページ(index.html)の配色・角丸・影に合わせてある。
// 店舗ページだけで必要になるものは pageHead({ extraCss }) で足す(ここを膨らませない)。
const BASE_CSS = `  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--felt:#0f3d2e;--felt2:#14513c;--gold:#d9a441;--gold2:#f0c56b;--bg:#f6f4ef;--sur:#fff;--bor:#e7e1d6;--txt:#25201b;--mut:#8a8078;--red:#c0392b;--r:14px;--sha:0 2px 12px rgba(30,20,5,.08)}
  html{scroll-behavior:smooth}
  body{font-family:"Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;background:var(--bg);color:var(--txt);line-height:1.6;font-size:15px;padding-bottom:calc(78px + env(safe-area-inset-bottom))}
  a{color:inherit}
  .wrap{max-width:900px;margin:0 auto;padding:0 16px}
  header{background:linear-gradient(135deg,var(--felt),var(--felt2));color:#fff;position:sticky;top:0;z-index:40;box-shadow:0 2px 8px rgba(0,0,0,.15)}
  .hbar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;max-width:900px;margin:0 auto}
  .logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:1em;color:#fff;text-decoration:none}
  .logo .pip{color:var(--gold2)}
  .back-link{color:#fff;font-size:.85em;font-weight:800;text-decoration:none}
  main{padding:20px 0 40px}
  h1{font-size:1.35em;font-weight:800;line-height:1.35;margin-bottom:6px}
  .lead{color:var(--mut);font-size:.9em;margin-bottom:14px}
  .evt-meta{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:13px 15px;margin-bottom:14px;font-size:.9em;line-height:1.8}
  .evt-meta b{color:var(--felt)}
  .evt-meta .prize{display:inline-block;margin-top:4px;background:linear-gradient(135deg,var(--gold2),var(--gold));color:#3a2a06;font-weight:800;font-size:.9em;padding:4px 12px;border-radius:20px}
  .disclaimer{font-size:.8em;color:var(--mut);line-height:1.7;background:#f7f5f0;border:1px solid var(--bor);border-radius:10px;padding:11px 13px;margin-bottom:16px}
  .disclaimer b{color:var(--txt)}
  .archived{font-size:.86em;line-height:1.7;color:#5b4a1e;background:#fbf1d8;border:1px solid #ecd9a6;border-radius:10px;padding:11px 13px;margin-bottom:14px}
  .archived b{color:#3a2a06}
  /* 「まだ発表されていない」ことの告知(FST)。終了(.archived)と区別できる色にする */
  .tba{font-size:.86em;line-height:1.7;color:#26424e;background:#eef6f8;border:1px solid #cfe3e9;border-radius:10px;padding:11px 13px;margin-bottom:14px}
  .tba b{color:#14333d}
  /* 大会バナー(当サイト作成)。狭い画面でも横幅いっぱいに収め、読み込み前後で高さが動かないようにする */
  .evt-banner{display:block;width:100%;height:auto;aspect-ratio:1024/412;border-radius:var(--r);box-shadow:var(--sha);margin-bottom:14px}
  .cta{display:block;text-align:center;background:linear-gradient(135deg,var(--felt),var(--felt2));color:#fff;font-weight:800;text-decoration:none;border-radius:var(--r);padding:13px 16px;margin:6px 0 20px;box-shadow:var(--sha)}
  .cta small{display:block;font-weight:600;font-size:.8em;color:#cfe3dd;margin-top:3px}
  h2.day{font-size:1.05em;font-weight:800;color:var(--felt);margin:22px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--gold)}
  table.sched{border-collapse:collapse;width:100%;font-size:.85em;background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);overflow:hidden;box-shadow:var(--sha);margin-bottom:6px}
  table.sched th,table.sched td{padding:8px 9px;text-align:left;border-bottom:1px solid var(--bor);vertical-align:top}
  table.sched th{background:#eef3f1;color:var(--felt);font-weight:800;font-size:.92em;white-space:nowrap}
  table.sched td.no{color:var(--felt);font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums}
  table.sched td.start{white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:700}
  table.sched td.buyin{white-space:nowrap}
  table.sched tr:last-child td{border-bottom:none}
  table.sched .gtd{display:inline-block;background:#fbf1d8;border:1px solid #ecd9a6;color:#7a5711;font-size:.85em;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:5px}
  /* 「項目 / 内容」形式(FST)。項目名は左の見出し列になる */
  table.sched tbody th{width:1%;white-space:nowrap}
  table.sched td.fst-prize{font-weight:800;color:var(--felt);font-variant-numeric:tabular-nums}
  .sched-wrap{overflow-x:auto}
  .links{font-size:.88em;line-height:2;margin:18px 0 8px}
  .links a{color:#0e6a72;font-weight:700}
  /* 大会ページ末尾の「エリア別の店舗トーナメント」への導線。店舗ページの .vp-list と同じ見た目。 */
  ul.evt-areas{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px;padding:0}
  ul.evt-areas a{display:inline-block;background:var(--sur);border:1px solid var(--bor);border-radius:20px;padding:6px 13px;font-size:.85em;font-weight:700;color:var(--felt);text-decoration:none;box-shadow:var(--sha)}
  /* 店舗カード(店舗ページの「同じエリアの他のポーカー店」・イベントページの「サテライト開催店舗」で共用)。
     社長方針・2026-08-27(大型大会は一時的なので、店舗どうしの内部リンクでリピートを作る)。
     ここに1つだけ置く(gen-venue-pages.js / gen-event-pages.js の両方から使うため複製しない)。 */
  .vp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:2px 0 6px}
  .vp-card{display:block;background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:12px 13px;text-decoration:none;color:inherit}
  .vp-card:hover{border-color:var(--gold)}
  .vp-card-name{font-weight:800;font-size:.92em;color:var(--felt);line-height:1.3}
  .vp-card-sub{font-size:.78em;color:var(--mut);margin-top:4px}
  footer{background:#1b2320;color:#9aa39d;padding:22px 16px;font-size:.8em;text-align:center;line-height:1.9}
  footer a{color:var(--gold2)}
  .stickyAd{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;align-items:center;gap:10px;padding:9px 12px calc(9px + env(safe-area-inset-bottom));background:radial-gradient(120% 220% at 6% 0%,rgba(96,214,255,.20),transparent 55%),radial-gradient(120% 220% at 100% 100%,rgba(200,110,255,.16),transparent 55%),linear-gradient(160deg,#12101d,#191325 60%,#140f1e);border-top:1px solid rgba(255,255,255,.08);box-shadow:0 -4px 18px rgba(5,0,15,.35)}
  .stickyAd img{width:38px;height:38px;flex-shrink:0;filter:drop-shadow(0 0 8px rgba(120,210,255,.4))}
  .stickyAd .sa-body{flex:1;min-width:0}
  .stickyAd .sa-title{font-size:.8em;font-weight:800;color:#fff;line-height:1.25}
  .stickyAd .sa-desc{font-size:.68em;color:#b9b6c9;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .stickyAd .sa-btn{flex-shrink:0;background:linear-gradient(135deg,var(--gold2),var(--gold));color:#3a2a06;font-weight:800;font-size:.76em;padding:8px 14px;border-radius:18px;white-space:nowrap;text-decoration:none}
  @media(max-width:420px){.stickyAd .sa-desc{display:none}}
`;

/**
 * <head> 〜 <main> 開きタグまで。
 *
 * オプションの既定値は【イベントページの現状の出力そのまま】にしてある。
 * ここを変えると gen-event-pages.js --check が落ちる(=気づける)。
 *   image      … OGP画像のパス(SITE基準の相対)。省略時はJOPTバナー
 *   noImage    … true にすると og:image/twitter:image を出さない(店舗ページ用)。
 *                 店舗ページで他社イベントのバナーを出すのは不適切なため、
 *                 トップページと同じ「画像なし・summaryカード」に合わせる
 *   ogType     … og:type。既定 'article'
 *   twitterCard… 既定 'summary_large_image'
 *   extraCss   … 共通CSSの後ろに足すページ固有のCSS
 */
function pageHead({ title, desc, canonical, jsonld, image, noImage, ogType, twitterCard, extraCss }) {
  const ogimg = `${SITE}/${image || 'img/jopt/jopt-banner.jpg'}`;
  const imgTags = noImage ? '' : `<meta property="og:image" content="${esc(ogimg)}">
`;
  const twImgTag = noImage ? '' : `<meta name="twitter:image" content="${esc(ogimg)}">
`;
  // JSON-LD は渡されたときだけ出す。
  // 【なぜ省けるようにしたか】未開店の店舗ページで LocalBusiness を出すと、
  //   まだ営業していない事業所を営業中として構造化データで宣言することになる
  //   (検索結果に住所と最寄駅が出て、存在しない店を訪ねる経路ができる)。
  //   jsonld を渡さない/null のときは <script type="application/ld+json"> ごと出力しない。
  const ldTag = jsonld ? `<script type="application/ld+json">
${JSON.stringify(jsonld, null, 2)}
</script>
` : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-L7091YHTFH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  // 本番ドメイン以外(GitHub Pagesのリダイレクト元・ローカル確認・プレビュー環境等)からの
  // アクセスをGA4に計測させない。config を呼ばない限りGA4側にヒットは送られないため、
  // ここでホストを絞る(GA4実測: /index.html や存在しない /_baseline-index.html に
  // 人手とは考えにくい偏ったPVが計測されていたことへの対応)。
  if (location.hostname === 'fukuokapoker.com') {
    gtag('js', new Date());
    gtag('config', 'G-L7091YHTFH');
  }
</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="${ogType || 'article'}">
<meta property="og:site_name" content="ふくおかポーカーナビ">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
${imgTags}<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="${twitterCard || 'summary_large_image'}">
${twImgTag}<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6349478743429747"
     crossorigin="anonymous"></script>
${ldTag}<style>
${BASE_CSS}${extraCss || ''}</style>
</head>
<body>
<header>
  <div class="hbar">
    <a class="logo" href="/"><span class="pip">♠</span>ふくおかポーカーナビ</a>
    <a class="back-link" href="/">← トップへ</a>
  </div>
</header>
<main class="wrap">`;
}

/**
 * </main> 〜 </html>。
 *   BIG         … big-events.js のエクスポート(恒久リンク行を作るのに使う)
 *   currentPath … そのページ自身のパス(自己リンクを避けるため)。null なら全件リンクになる
 *   extraScripts… </body> の直前に足すスクリプト(店舗ページの日程再描画など)
 */
function pageFoot(BIG, currentPath, extraScripts) {
  // 恒久リンク行(全大会・日付に関係なく常に出す)と、
  // 「大会特集」(掲載中の1件だけ・日によって変わるのでブラウザ側で判定)は【両方】出す。
  // 後者は生成時に焼き込まない(静的ページは再生成しない限り更新されず、古い大会が残り続けるため)。
  return `</main>
<footer>
  <div><b style="color:#fff">ふくおかポーカーナビ</b> — 福岡ポーカートーナメント日程アグリゲーター</div>
  <div style="margin-top:6px"><a href="/">トップ</a>　|　${permanentEventLinks(BIG, currentPath)}</div>
  <div style="margin-top:6px"><a href="/contact.html">お問い合わせ</a>　|　<a href="/privacy.html">プライバシーポリシー</a></div>
  <div id="evtFeature" style="display:none"></div>
</footer>
<script src="/big-events.js"></script>
<script>if (typeof mountBigEventFooter === 'function') mountBigEventFooter('evtFeature');</script>
<div class="stickyAd">
  <!-- 自社アプリ(ポーカートナメ成績表)の広告なので、アイコンは【必ず自社のもの】を使う。
       以前はJOPTのバナー画像を焼き込んでいたため、日本シリーズのページでも自社広告の横に
       JOPTのブランドが出ていた(他社イベントのページに別の他社ロゴを載せる形になり不適切)。
       トップページ(index.html)の .stickyAd と同じ画像・同じ指定に揃えること。 -->
  <img src="/img/ptl-bulldog.png" alt="" width="38" height="38">
  <div class="sa-body">
    <div class="sa-title">成績、記録してますか？</div>
    <div class="sa-desc">ポーカートナメ成績表(無料) — buyin・順位・収支を記録</div>
  </div>
  <a class="sa-btn" href="https://poker-tourney-log--family.expo.app" target="_blank" rel="noopener">使ってみる →</a>
</div>
${extraScripts || ''}</body>
</html>`;
}

module.exports = {
  SITE, POSITIONING, esc, WD, fmtDate,
  LINK_SEP, permanentEventLinks, permanentEventLinksList,
  BASE_CSS, pageHead, pageFoot,
  validateVenueSlugs
};
