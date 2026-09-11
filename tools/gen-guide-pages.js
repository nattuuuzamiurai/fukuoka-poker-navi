#!/usr/bin/env node
/**
 * gen-guide-pages.js
 *
 * 「福岡 ポーカー」という広い検索クエリを獲得するための静的ガイドページを生成する。
 * 店舗ページ(/venues/<slug>/)は「店名+日程」、エリアページ(/areas/<slug>/)は「地名+ポーカー」を
 * それぞれ狙うのに対し、このページは「初めてで何も分からない」層が最初に検索する一般語
 * （トーナメント・大会を前面に出さない語）を受ける入口で、店舗ページ・エリアページへの
 * 内部リンクのハブも兼ねる。
 *
 * 【原稿の出どころ】企画部の企画・コンテンツ制作部の執筆にもとづく
 *   guide-beginner-content-draft.md（2026-09-12時点の data.js を前提に執筆）。
 *   見出し構成（3つの選び方の軸 → 初心者講習明記6店の個別紹介 → エリア導線 →
 *   全34店舗一覧表 → FAQ → トップページ誘導）はそのまま踏襲する。
 *
 * 【data.js との突き合わせ方針】
 *   店名・スラッグ・エリア・アクセス・営業時間は data.js の VENUES からそのまま読み込む
 *   （原稿の該当欄を手で書き写すと、日次の自動取込で data.js が更新されるたびに
 *   このページだけ古い情報が残る）。実際に原稿作成時点(2026-09-12)の data.js と
 *   突き合わせた結果、アクセス・営業時間は全34店舗で一致していた（全角/半角の括弧の
 *   表記ゆれのみ）ことを確認済み。
 *   一方、「初心者講習の実施明記」の有無・紹介文・「営業時間は第三者媒体の情報」という
 *   ヘッジは data.js に対応するフラグを持たない編集判断のため
 *   （tools/venue-listing-rules.js と同じ考え方 ＝ その店の実態を人が確認していないと
 *   決められない情報を、note文字列の正規表現一致のような脆い方法で自動判定しない）、
 *   下記 HIGHLIGHT_STORES / BEGINNER_COURSE_IDS / HOURS_THIRDPARTY_IDS に直接持つ。
 *   ★ data.js のスキーマ・VENUES の項目には一切手を入れない
 *     （並行して別セッションが data.js に構造化データ用フィールドを拡充している可能性があるため、
 *      このページはその読み取りだけを行い、書き込み・スキーマ変更は行わない）。
 *
 * 【JSON-LD】WebPage + FAQPage のみ。個別店舗の LocalBusiness は店舗ページ側に集約済みなので
 *   ここでは出さない（README「法務・信頼性メモ」の方針どおり、留保付きの値を構造化データに
 *   出さない・断定しないという原則にも、そもそも店舗の許認可等を主張しないここでは抵触しない）。
 *
 * 生成物:
 *   - guide/beginner/index.html
 *   - sitemap.xml … 中身は tools/gen-sitemap.js が決める。ここでは組み立てず、そのまま書くだけ。
 *
 * 【index.html 側の導線】
 *   index.html 自体（フッターの運営者情報行）へのリンク追加は、この生成スクリプトでは
 *   自動同期しない。#evtLinks/#areaLinks/#venueLinks と違い「一覧が増減するレジストリ」
 *   ではなく1本の固定リンクなので、about.html/contact.html/privacy.html と同じく
 *   手で1行足すだけで足りる（機械同期の仕組みを増やさない）。
 *
 * 使い方:
 *   node gen-guide-pages.js <リポジトリのパス>            … 生成する
 *   node gen-guide-pages.js <リポジトリのパス> --check     … 書き込まず、ディスクの内容と一致するかだけ見る
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
const REPO = path.resolve(REPO_ARG);

const shell = require('./site-shell.js');
const { SITE, POSITIONING, esc, pageHead, FAQ_CSS, faqBlock } = shell;
const { sitemapFile } = require('./gen-sitemap.js');
const { AREA_SLUGS, areaVenues, areaList, footerAreaLinksHtml } = require('./area-schedule.js');

// ---- データ読み込み(読むだけ。data.js・big-events.js には一切書き込まない) ----
const DATA = require(path.join(REPO, 'data.js'));
const BIG = require(path.join(REPO, 'big-events.js'));
const { VENUES, AREAS } = DATA;

// slug の欠け・重複は生成前に止める(このページから /venues/<slug>/ へのリンクが壊れるため)。
shell.validateVenueSlugs(VENUES);

function venueById(id) {
  const v = VENUES.find(x => x.id === id);
  if (!v) throw new Error(`gen-guide-pages.js: data.js に ${id} が見つかりません(店舗の削除/ID変更に伴い、このファイルの参照も見直してください)`);
  return v;
}

const GUIDE_PATH = 'guide/beginner/index.html';
const GUIDE_URL = '/guide/beginner/';
const CANONICAL = `${SITE}${GUIDE_URL}`;

const FOOTER_AREA_LINKS = footerAreaLinksHtml(VENUES, AREAS);
const pageFoot = extraScripts => shell.pageFoot(BIG, null, extraScripts, FOOTER_AREA_LINKS);

// ============================================================
// 編集判断(data.js にフラグを持たないため、ここに直接持つ)
// ============================================================

// 「初心者講習」「初心者プラン」の実施を、店舗自身の公式サイト・SNS等で明記していることが
// 確認できた店舗(原稿・2026-09-12時点)。5店舗。
const BEGINNER_COURSE_IDS = ['v7', 'v21', 'v35', 'v40', 'v41'];

// 営業時間が第三者媒体(当サイトが直接確認していない情報源)によるもので、店舗による一次確認が
// 取れていない店舗。data.js の note に「営業時間は第三者媒体情報のため要確認」等の記載がある
// 店舗と対応する(原稿・2026-09-12時点の data.js との突き合わせ済み)。
const HOURS_THIRDPARTY_IDS = [
  'v3', 'v4', 'v5', 'v6', 'v8', 'v9', 'v13', 'v14', 'v19', 'v21', 'v22', 'v27', 'v29', 'v40'
];

// 初心者講習明記の個別紹介(6店舗)。5店舗(BEGINNER_COURSE_IDS)に加え、CasinoXは「女性・初心者向け」
// の表記はあるが「初心者講習」の実施明記までは確認できていない例外として、あえて併記する
// (原稿の方針。無いことにせず、確認できていない旨とセットで正直に書く)。
const HIGHLIGHT_STORES = [
  { id: 'v7', intro: '公式サイト(店舗確認済み)によると、無料の初心者講習を実施しているとのことです。' },
  { id: 'v21', intro: '公式ラインの案内によると、初心者講習を実施しているとのことです。JOPT/WJPT・MASAKICHI SUPER LEAGUE系のトーナメントも開催しているとされ、卓状況は公式オープンチャットで随時更新されているとのことです。' },
  { id: 'v35', intro: '公式Instagramによると、初心者講習を毎日実施しているとのことです。フリーロール(無料参加)の実績もあるとされています。KENポーカー(久留米)と同じ久留米エリアの別店舗です。' },
  { id: 'v40', intro: '公式Xによると、初心者講習を実施しているとのことです。ボードゲームも多数用意されているとされ、掲載中のTripleBarrel小倉店の姉妹店にあたります。' },
  { id: 'v41', intro: '公式サイトによると「初心者プラン」が用意されているとのことです。風俗営業5号許可を取得済みで、チップの換金・景品交換は一切ないと案内されています。トーナメントの日程は公式Instagramで告知されているとのことです。' },
  { id: 'v28', intro: '公式Instagramでは「女性・初心者向け」と案内されています。ただし、他の5店舗のような「初心者講習」の実施明記は当サイトでは確認できていません(2026年9月時点)。姉弟で運営する小規模な店舗で、貸切イベントにも対応しているとのことです。', noCourseBadge: true }
];

// エリアから探す(原稿の短い紹介文。gen-area-pages.js の AREA_CONTENT はエリアページ本体用の
// 長い紹介文で、こちらはこのガイドページ専用の一言。役割が違うので使い回さない)。
const AREA_INTRO = {
  '天神': '福岡随一の繁華街で、店舗数の多いエリアの一つです。',
  '中洲': '天神と並ぶ繁華街で、天神と同じく店舗数が多いエリアです。前述の通り、初心者講習の明記がある店舗は今のところありません。',
  '大名': '天神エリアに近い立地です。',
  '今泉': '天神から徒歩圏内の落ち着いたエリアです。',
  '大橋': '大橋駅周辺のエリアです。',
  '北九州': '小倉・黒崎・折尾など、県内で最も店舗数が多いエリアです。',
  '久留米': '西鉄久留米駅周辺で、初心者講習を掲げる店舗が複数あるエリアです。'
};

// ============================================================
// ページ固有CSS(見た目は既存の静的ページと同じデザイン言語。BASE_CSS/FAQ_CSSにある
// クラス(.vp-cards/.vp-card/.disclaimer/.lead/.links/.cta/.sched-wrap等)はそのまま流用し、
// ここには「この構成に足りない分」だけを足す)
// ============================================================
const GUIDE_CSS = `  .gd-card{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:14px 15px;margin-bottom:10px}
  .gd-card h3{font-size:.98em;font-weight:800;color:var(--felt);margin-bottom:5px}
  .gd-card .mt{font-size:.85em;color:var(--mut);line-height:1.8;margin-bottom:6px}
  .gd-card p{font-size:.88em;line-height:1.8;margin:0 0 2px}
  .gd-card a.vlink{display:inline-block;margin-top:6px;font-size:.85em;font-weight:700;color:#0e6a72;text-decoration:none}
  table.gd-table{border-collapse:collapse;width:100%;min-width:640px;font-size:.82em;background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);overflow:hidden;box-shadow:var(--sha);margin-bottom:6px}
  table.gd-table th,table.gd-table td{padding:7px 8px;text-align:left;border-bottom:1px solid var(--bor);vertical-align:top}
  table.gd-table th{background:#eef3f1;color:var(--felt);font-weight:800;white-space:nowrap}
  table.gd-table td.gd-course{text-align:center;font-weight:800;color:var(--felt);white-space:nowrap}
  table.gd-table a{color:#0e6a72;font-weight:700;text-decoration:none}
  table.gd-table tr:last-child td{border-bottom:none}
`;

// ============================================================
// 本文の組み立て
// ============================================================

// ---- 3つの選び方の軸 ----
const POINTS = [
  { t: '1. 初心者講習の有無', d: 'ポーカーのルールを知らない状態で店に行くのは、誰でも少し勇気がいるものです。「初心者講習」「初心者プラン」を掲げている店舗であれば、ルールを知らないことを前提に案内してもらえる可能性が高く、最初の一歩として選びやすいと言えます。' },
  { t: '2. アクセス(駅からの近さ)', d: 'ポーカー店の多くは夜間の営業が中心で、終電の時間帯を気にしながら帰ることも少なくありません。駅から近い店舗であれば、土地勘がなくても迷いにくく、帰りの移動も安心です。' },
  { t: '3. 営業時間(自分の行ける時間帯か)', d: '店舗によって開店時間・閉店時間はさまざまで、平日と土日祝で営業時間が異なる店舗もあります。仕事帰りに寄れるか、休日の昼間から入れるかなど、自分の生活リズムに合う時間帯で営業しているかを事前に確認しておくと安心です。' }
];
function pointsBlock() {
  return `
<h2 class="day">初心者が福岡のポーカー店を選ぶときに見るべき3つのポイント</h2>
<div class="vp-cards" style="grid-template-columns:1fr">
${POINTS.map(p => `  <div class="vp-card" style="cursor:default">
    <div class="vp-card-name">${esc(p.t)}</div>
    <div class="vp-card-sub">${esc(p.d)}</div>
  </div>`).join('\n')}
</div>`;
}

// ---- 初心者講習明記の6店舗 ----
function highlightStoresBlock() {
  const cards = HIGHLIGHT_STORES.map(h => {
    const v = venueById(h.id);
    return `<div class="gd-card">
  <h3>${esc(v.name)}(${esc(v.area)})</h3>
  <div class="mt">アクセス: ${esc(v.access || '情報なし')}<br>営業時間: ${esc(v.hours || '情報なし')}${HOURS_THIRDPARTY_IDS.includes(v.id) ? '※' : ''}</div>
  <p>${esc(h.intro)}</p>
  <a class="vlink" href="/venues/${v.slug}/">${esc(v.name)}の店舗ページ →</a>
</div>`;
  }).join('\n');
  // 「中洲エリアについて」は原稿の固定文言だが、前提(中洲エリアの店に初心者講習明記が無いこと)が
  // 崩れたら気づけるよう、HIGHLIGHT_STORESの実データで検算してから出す。
  const nakasuHasBeginnerCourse = HIGHLIGHT_STORES.some(h => !h.noCourseBadge && venueById(h.id).area === '中洲');
  if (nakasuHasBeginnerCourse) {
    throw new Error('gen-guide-pages.js: 中洲エリアに初心者講習明記の店舗が見つかりました。'
      + '「中洲エリアについて」の固定文言(該当店舗なし、という前提)を書き直してください。');
  }
  const nakasuCount = areaVenues(VENUES, '中洲').filter(v => !v.preopen).length;
  return `
<h2 class="day">初心者講習が明記されている福岡のポーカー店</h2>
<p class="lead">以下の6店舗は、公式サイトや公式SNS等で「初心者講習」「初心者プラン」といった表記が確認できた店舗です。当サイトが独自に優劣を判定したものではなく、各店舗自身が発信している情報をそのまま紹介しています。内容は変更されることがあるため、来店前には必ず各店舗の最新の公式情報をご確認ください。</p>
${cards}
<div class="disclaimer">掲載店舗数が最も多い中洲エリア(${nakasuCount}店舗)ですが、2026年9月時点で「初心者講習」の実施を明記している店舗は確認できていません。中洲エリアで初めての来店を検討する場合は、事前に各店舗の公式SNS等で初心者対応の可否を直接確認することをおすすめします。</div>`;
}

// ---- エリアから探す ----
function areaNavBlock() {
  const pageAreas = areaList(VENUES, AREAS);
  const cards = pageAreas.map(a => {
    const count = areaVenues(VENUES, a).length;
    const intro = AREA_INTRO[a] || '';
    return `<div class="gd-card">
  <h3>${esc(a)}(${count}店舗)</h3>
  <p>${esc(intro)}</p>
  <a class="vlink" href="/areas/${AREA_SLUGS[a]}/">${esc(a)}エリアの店舗一覧 →</a>
</div>`;
  }).join('\n');
  // ページを持たない(店舗数1のため)エリアは末尾でまとめて案内する。実データから動的に出すので、
  // 該当エリアが増減しても手直し不要。
  const smallAreas = AREAS.filter(a => pageAreas.indexOf(a) < 0 && areaVenues(VENUES, a).length > 0);
  const smallAreasNote = smallAreas.length
    ? `<p class="lead">このほか、${smallAreas.map(esc).join('・')}エリアにも店舗があります。エリアごとの詳細は次の「福岡のポーカー店 全一覧」、または各店舗ページでご確認ください。</p>`
    : '';
  return `
<h2 class="day">エリアから探す</h2>
<p class="lead">店名ではなく「行きやすい場所」から探したい方向けに、主なエリアへのリンクをまとめました。各エリアページでは、そのエリアの店舗一覧と開催中の日程を確認できます。</p>
${cards}
${smallAreasNote}`;
}

// ---- 全店舗一覧表 ----
// 表示順は data.js の AREAS(サイト共通のエリア表記順)→エリア内は VENUES 登録順。
// 件数・アクセス・営業時間・リンク先は毎回 data.js から作り直すため、店舗を追加・削除しても
// このページの手直しは不要(再生成するだけで追随する)。
function fullListBlock() {
  const order = AREAS.slice();
  const listed = VENUES.filter(v => !v.preopen).slice().sort((a, b) => {
    const ia = order.indexOf(a.area), ib = order.indexOf(b.area);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const rows = listed.map(v => `    <tr>
      <td>${esc(v.area)}</td>
      <td><a href="/venues/${v.slug}/">${esc(v.name)}</a></td>
      <td>${esc(v.access || '情報なし')}</td>
      <td>${esc(v.hours || '情報なし')}${HOURS_THIRDPARTY_IDS.includes(v.id) ? '※' : ''}</td>
      <td class="gd-course">${BEGINNER_COURSE_IDS.includes(v.id) ? '○' : '情報なし'}</td>
    </tr>`).join('\n');
  return { html: `
<h2 class="day">福岡のポーカー店 全一覧</h2>
<p class="lead">掲載中の${listed.length}店舗を、エリア別に一覧でまとめました(オープン予定で未開店の店舗は除きます)。営業時間が空欄の店舗は「情報なし」としています。</p>
<div class="sched-wrap"><table class="gd-table">
  <thead>
    <tr><th>エリア</th><th>店名</th><th>アクセス</th><th>営業時間</th><th>初心者講習</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table></div>
<p class="lead">※ 営業時間は第三者媒体の情報をもとにしており、店舗による一次確認が取れていません。来店前に公式サイト・SNS等でご確認ください。</p>`, count: listed.length };
}

// ---- よくある質問(このページ専用。トップページの FAQ_ITEMS とは独立) ----
const FAQ_ITEMS = [
  {
    q: '福岡のポーカー店は無料で体験できますか?',
    a: '店舗によって異なります。「初心者講習」を掲げる店舗でも、参加条件(無料か有料か、入場料は別途かかるか等)は店舗ごとに異なるようです。来店前に各店舗の公式サイト・SNS等でご確認ください。'
  },
  {
    q: 'ポーカーのルールを全く知らなくても参加できますか?',
    a: '「初心者講習」「初心者プラン」を掲げる店舗であれば、ルールを知らない状態からの参加を想定して案内していることが多いようです。ただし対応できる範囲は店舗によって異なるため、事前にSNSのダイレクトメッセージ等で相談しておくと安心です。'
  },
  {
    q: '初心者講習は予約が必要ですか?',
    a: '店舗によって異なります。公式LINE・Instagram等で事前の連絡を案内している店舗もあるようですので、来店前に各店舗の公式情報でご確認ください。'
  },
  {
    q: '服装や持ち物に決まりはありますか?',
    a: '当サイトでは店舗ごとの服装規定までは把握していません。確実な情報は、来店前に各店舗の公式サイト・SNS等でご確認ください。'
  },
  {
    q: '一人で行っても大丈夫ですか?',
    a: '多くの店舗が一人での来店を受け入れているとみられますが、詳細は店舗によって異なります。不安な場合は、来店前に公式SNS等で一人でも参加できるか確認しておくと安心です。'
  }
].map(x => ({ q: x.q, aHtml: esc(x.a), aText: x.a }));

// ---- ページ全体 ----
const TITLE = '福岡のポーカー店の選び方｜初心者向け比較ガイド | ふくおかポーカーナビ';

function buildGuidePage() {
  const listedCount = VENUES.filter(v => !v.preopen).length;
  const DESC = `福岡には${listedCount}店舗のポーカー店があり、初めてだとどこに行けばいいか迷いがちです。初心者講習の有無・アクセス・営業時間の3つの軸で、福岡でポーカーを始めるときの店舗の選び方を解説します。`;

  const webPageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: '福岡でポーカーを始めるなら — 初心者向け店舗の選び方',
    description: DESC,
    url: CANONICAL,
    inLanguage: 'ja',
    isPartOf: { '@type': 'WebSite', name: 'ふくおかポーカーナビ', url: `${SITE}/` }
  };
  const breadcrumb = [
    { name: 'ふくおかポーカーナビ', url: `${SITE}/` },
    { name: '福岡のポーカー店の選び方', url: CANONICAL }
  ];

  const fullList = fullListBlock();
  const faq = faqBlock(FAQ_ITEMS, { headingId: 'guide-faq' });

  const body = `
<h1>福岡でポーカーを始めるなら — 初心者向け店舗の選び方</h1>
<p class="lead">福岡県内には、天神・中洲・北九州・久留米などのエリアを中心に${listedCount}店舗のポーカー店があります。数が多い分、「初めてで何も分からないけれど、どの店に行けばいいのか」と迷う方も多いのではないでしょうか。</p>
<p class="lead">結論から言うと、初心者が店を選ぶときに見るべきポイントは次の3つです。</p>
<div class="disclaimer">このページでは、初心者講習の有無・アクセス・営業時間の3つの軸で福岡のポーカー店を整理し、初心者講習を掲げている店舗の紹介、エリアごとの探し方、そして掲載中の全${listedCount}店舗の一覧をまとめています。当サイトは店舗の優劣を独自に採点・ランキング化するものではなく、各店舗が公式サイト・公式SNS等で発信している情報をそのまま整理してお伝えするものです。参加前には必ず各店舗の最新の公式情報をご確認ください。<br>${POSITIONING}</div>
${pointsBlock()}
${highlightStoresBlock()}
${areaNavBlock()}
${fullList.html}
${faq.html}
<h2 class="day">トーナメントに挑戦したくなったら</h2>
<p class="lead">店選びの参考になったら、次はぜひ実際の大会日程もチェックしてみてください。当サイトのトップページでは、福岡県内で開催されるポーカートーナメント・大会の日程を、日付・エリア・種類(サテライト/PLO/NLHなど)で絞り込んで一覧表示できます。</p>
<a class="cta" href="/">▶ 福岡のポーカートーナメント・大会日程一覧はこちら<small>日付・エリア・種類で絞り込んで表示</small></a>
<h2 class="day">まとめ</h2>
<ul style="margin:0 0 14px 1.3em;font-size:.9em;line-height:2">
  <li>福岡のポーカー店選びで迷ったら、<b>初心者講習の有無・アクセス・営業時間</b>の3つを確認するのがおすすめです。</li>
  <li>2026年9月時点で「初心者講習」「初心者プラン」の表記が確認できたのは、${HIGHLIGHT_STORES.filter(h => !h.noCourseBadge).map(h => esc(venueById(h.id).name)).join('・')}の${BEGINNER_COURSE_IDS.length}店舗です(${HIGHLIGHT_STORES.filter(h => h.noCourseBadge).map(h => esc(venueById(h.id).name)).join('・')}は「女性・初心者向け」の表記のみで、講習の実施明記はありません)。掲載店舗数が最多の中洲エリアには、該当する店舗は今のところありません。</li>
  <li>当サイトは店舗・主催者そのものではなく、公開されている情報をもとにまとめた案内サイトです。当サイトが店舗の優劣を判定・ランキング化することはありません。掲載内容は変更されることがあるため、来店前には必ず各店舗の公式サイト・SNS等で最新情報をご確認ください。</li>
</ul>
${faq.script}`;

  return pageHead({
    title: TITLE,
    desc: DESC,
    canonical: CANONICAL,
    jsonld: webPageJsonLd,
    breadcrumb,
    ogType: 'article',
    twitterCard: 'summary_large_image',
    extraCss: FAQ_CSS + GUIDE_CSS
  }) + body + pageFoot(null);
}

// ---- 検査 ----
function verify(files) {
  const problems = [];
  if (!files[GUIDE_PATH]) problems.push(`${GUIDE_PATH} が生成物に含まれていない`);
  const html = files[GUIDE_PATH] || '';
  const listedCount = VENUES.filter(v => !v.preopen).length;
  const linked = (html.match(/href="\/venues\/[^"]+\/"/g) || []).length;
  // 店舗ページへのリンクは「全店舗一覧表(未開店を除く全件)」＋「初心者講習ハイライト(6件)」の合計。
  if (linked !== listedCount + HIGHLIGHT_STORES.length) {
    problems.push(`店舗ページへのリンク数が ${linked} 件(期待値: 全一覧${listedCount}件 + ハイライト${HIGHLIGHT_STORES.length}件 = ${listedCount + HIGHLIGHT_STORES.length}件)`);
  }
  // 本文の「エリアから探す」カード(pageAreaCount件)に加えて、共通フッター(pageFootに渡した
  // FOOTER_AREA_LINKS)にも同じ対象が並ぶため、期待値は2倍になる(店舗ページ・エリアページの
  // 共通フッターと同じ構造)。
  const areaLinked = (html.match(/href="\/areas\/[^"]+\/"/g) || []).length;
  const pageAreaCount = areaList(VENUES, AREAS).length;
  if (areaLinked !== pageAreaCount * 2) {
    problems.push(`エリアページへのリンク数が ${areaLinked} 件(期待値: 本文${pageAreaCount}件 + フッター${pageAreaCount}件 = ${pageAreaCount * 2}件)`);
  }
  if (problems.length) {
    console.error('\n✗ ガイドページの生成物が data.js と一致しません:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log(`検査: ガイドページ(全一覧${listedCount}店舗・エリア導線${pageAreaCount}件)は data.js と一致`);
}

// ---- 書き出し / 検査 ----
const files = {};
files[GUIDE_PATH] = buildGuidePage();
Object.assign(files, sitemapFile(REPO));

verify(files);

if (CHECK) {
  const stale = Object.keys(files).filter(rel => {
    let cur = null;
    try { cur = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (e) { /* 未生成 */ }
    return cur !== files[rel];
  });
  if (stale.length) {
    console.error('\n✗ 生成物が最新ではありません（node tools/gen-guide-pages.js <repo> を実行してください）:\n  - ' + stale.join('\n  - '));
    process.exit(1);
  }
  console.log('検査: 生成物はすべて最新（' + Object.keys(files).length + 'ファイル）');
} else {
  let wrote = 0;
  Object.keys(files).forEach(rel => {
    const p = path.join(REPO, rel);
    let cur = null;
    try { cur = fs.readFileSync(p, 'utf8'); } catch (e) { /* 未生成 */ }
    if (cur === files[rel]) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel], 'utf8');
    wrote++;
  });
  console.log(`完了。ガイドページ 1件／ 書き換えたファイル ${wrote} 件`);
}
