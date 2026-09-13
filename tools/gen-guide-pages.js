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
 *   見出し構成（目的別カテゴリー(6分類) → 初心者講習明記6店の個別紹介 → エリア導線 →
 *   全34店舗一覧表 → FAQ → トップページ誘導）はそのまま踏襲する。
 *   ★2026-09-12改訂: 社長フィードバック「内容が薄すぎる」を受け、旧「初心者が選ぶときに
 *   見るべき3つのポイント」(一般論)を「福岡のポーカー店を目的別に探す」(店舗名・出典つきの
 *   具体的な紹介)に全面差し替え。
 *
 * 【data.js との突き合わせ方針】
 *   店名・スラッグ・エリア・アクセス・営業時間は data.js の VENUES からそのまま読み込む
 *   （原稿の該当欄を手で書き写すと、日次の自動取込で data.js が更新されるたびに
 *   このページだけ古い情報が残る）。実際に原稿作成時点(2026-09-12)の data.js と
 *   突き合わせた結果、アクセス・営業時間は全34店舗で一致していた（全角/半角の括弧の
 *   表記ゆれのみ）ことを確認済み。
 *   一方、「初心者講習の実施明記」「目的別カテゴリーの該当・出典・紹介文」「営業時間は
 *   第三者媒体の情報」というヘッジは data.js に対応するフラグを持たない編集判断のため
 *   （tools/venue-listing-rules.js と同じ考え方 ＝ その店の実態を人が確認していないと
 *   決められない情報を、note文字列の正規表現一致のような脆い方法で自動判定しない）、
 *   下記 HIGHLIGHT_STORES / BEGINNER_COURSE_IDS / HOURS_THIRDPARTY_IDS / CATEGORIES /
 *   NOT_FOUND_IDS に直接持つ。
 *   ★カテゴリー(CATEGORIES)の出典は主に外部レビューサイト(fukuoka-online.jp、
 *   light-three.com等)・業界メディア・店舗公式SNSで、data.js の note(店舗の一次情報)とは
 *   出典の性質が異なる。公開前に品質管理部での裏取りが必要（原稿冒頭の開発部向けメモを参照）。
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

// 「福岡のポーカー店を目的別に探す」のカテゴリー(6分類・原稿2026-09-12改訂版〔文章圧縮・
// カード化版〕)。各店舗の name/area/slug は venueById(id) で data.js からそのまま引く(手書きしない)。
// 【featured】ポイント箇条書き(2〜3点)＋出典を持つ店舗(カード表示)。
// 【chips】具体的な説明が原稿に無く、該当することだけを紹介する店舗(チップ/タグ表示)。
//   chipsIntro はチップ一覧の直前に置く前置き文(原稿の「このほか、〜」の一文)。
//   chips が無いカテゴリーは全店 featured のみ。
// 同じ店舗が複数カテゴリーに登場することがある(例: CRownCLownは3カテゴリー、
// KENポーカー(久留米)はカテゴリー1・2の両方)。原稿の実態どおり。
// icon はカテゴリー見出しに添える小さなSVGアイコンの種類(下記 ICONS を参照)。
const CATEGORIES = [
  {
    heading: 'トーナメントが強い・人気がある店を探すなら',
    icon: 'trophy',
    lead: '大会・トーナメントの盛り上がりについて、外部のレビューサイトや店舗公式SNS等で言及されている店舗です。',
    featured: [
      { id: 'v22', points: ['連日プレイヤーで賑わう白熱トーナメント', 'ハイレベルな対局と評判'], source: 'fukuoka-online.jp、light-three.comより' },
      { id: 'v5', points: ['トーナメントを毎日開催', '内容が安定しており集客力も高い'], source: '運営状況の確認情報' },
      { id: 'v21', points: ['JOPT・WJPTなど全国大会のサテライト会場', '店舗予選(DAY1)も継続開催'], source: '店舗公式情報より' },
      { id: 'v2', points: ['地域最大級の6テーブルを完備', '毎日トーナメントを開催'], source: '紹介記事より' },
      { id: 'v18', points: ['FST(大型連動大会)のDAY1会場を担当'], source: 'FST公式Xより' },
      { id: 'v34', points: ['4卓を使用する店舗', 'XPTなど全国大会のサテライトを頻繁開催'], source: '店舗公式Instagramより' }
    ]
  },
  {
    heading: 'リングゲーム、初心者でも安心して打ちたいなら',
    icon: 'cards',
    lead: 'リングゲームとは、好きなタイミングで出入りできる通常のポーカーのことです。「初心者でも入りやすい」「講習・接客が丁寧」といった口コミ・紹介記事が見られる店舗です(出典: 主にlight-three.com、fukuoka-online.jp等の外部レビューサイト)。中洲エリアの店舗もこのカテゴリーに含まれます。',
    featured: [
      { id: 'v21', points: ['リングゲームを毎日開催', '初心者講習も実施'], source: '運営状況の確認情報、店舗公式ライン案内' }
    ],
    chipsIntro: 'このほか、次の店舗も同じ理由でこのカテゴリーに含まれています。',
    chips: ['v25', 'v3', 'v13', 'v14', 'v7', 'v4', 'v6', 'v28', 'v23', 'v40', 'v41']
  },
  {
    heading: 'リングゲーム、腕試ししたい・ガチでやりたいなら',
    icon: 'cards',
    lead: '※リングゲームとは、好きなタイミングで出入りできる通常のポーカーのことです。遊技スタイルとして「上級者向け」「本格的」と紹介されている店舗です。「勝てる」「稼げる」という意味ではなく、あくまでゲームの雰囲気についての紹介である点にご留意ください。',
    featured: [
      { id: 'v22', points: ['上級者向けの遊技スタイル', 'ハイローラー向けイベントを定期開催'], source: '紹介記事より' },
      { id: 'v30', points: ['深いスタックの本格リングゲーム', '初心者講習もあり初級〜上級まで対応'], source: '紹介記事より' },
      { id: 'v16', points: ['「スポーツポーカー競技場」を自称', '戦略性・心理戦を重視するスタイル'], source: '口コミより' }
    ]
  },
  {
    heading: 'バカラ・ブラックジャックも遊びたいなら',
    icon: 'dice',
    lead: 'ポーカーのほかにバカラ・ブラックジャックなど複数のゲームを扱っていると案内されている店舗です。',
    featured: [
      { id: 'v5', points: ['福岡で唯一プログレッシブポーカーに対応'], source: '店舗紹介情報より' }
    ],
    chipsIntro: 'このほか、次の店舗でもバカラ・ブラックジャックが遊べると案内されています。',
    chips: ['v9', 'v3', 'v29', 'v39', 'v19', 'v37', 'v41']
  },
  {
    heading: 'お得にお酒も楽しみたいなら',
    icon: 'glass',
    lead: '飲み放題や均一料金など、お酒に関する案内がある店舗です。金額や条件は変わることがあるため、来店前に必ず最新情報をご確認ください。',
    featured: [
      { id: 'v23', points: ['入場料1,000円で飲み放題込み'], source: '店舗公式情報より' },
      { id: 'v5', points: ['1,000円で時間無制限の飲み放題'], source: '店舗公式情報より' },
      { id: 'v42', points: ['ソフトドリンクは12時間500円', 'アルコールは12時間1,500円'], source: '店舗公式情報より' }
    ],
    chipsIntro: 'このほか、次の店舗でもお酒に関する案内があります。',
    chips: ['v9', 'v39', 'v27', 'v41']
  },
  {
    heading: 'ミックスゲーム・PLOを打ちたいなら',
    icon: 'shuffle',
    lead: 'PLOやミックスゲームとは、テキサスホールデム以外のポーカーの種類のことです。ここでは、そうしたバリエーションに対応していると案内されている店舗を紹介します。',
    featured: [
      { id: 'v33', points: ['取り扱いゲームは「基本全部」', 'ミックスゲームにも対応'], source: '店舗公式情報より' },
      { id: 'v36', points: ['曜日を定めてPLOトーナメントを開催', '開催曜日・頻度は月によって変動(要確認)'], source: '店舗公式情報より' },
      { id: 'v22', points: ['Draw・PLOに対応'], source: '紹介記事より' },
      { id: 'v2', points: ['ゲーム種類は「基本全部」', '開催頻度は未確認(要確認)'], source: '紹介記事より' }
    ]
  }
];

// 上記6カテゴリーのいずれにも、裏付けとなる外部の紹介記事・口コミが見つからなかった店舗
// (原稿の方針: 無理に当てはめず率直に書く)。
const NOT_FOUND_IDS = ['v17', 'v26', 'v35', 'v38', 'v20', 'v8'];

// カテゴリー内の全店舗id(featured＋chips)を1つにまとめる。verify()の件数検査・
// validateCategoryCoverage() の両方から使う(同じ集め方を2箇所に書かない)。
function categoryStoreIds(c) {
  return [...c.featured.map(f => f.id), ...(c.chips || [])];
}

// 掲載中(未開店を除く)の全店舗が CATEGORIES か NOT_FOUND_IDS のどちらかに必ず含まれることを
// 検査する。新規開店・店舗追加は日次の自動取込(TOURNAMENTSのみ対象)では起きず人手で
// data.js に足すため、足した人がこの生成を実行した時点で「目的別カテゴリーへの割り当てを
// 忘れている」ことに気づけるようにする(気づかないと「該当なし」の案内にも載らないまま
// 目的別セクションから存在ごと漏れる=閲覧者からは何も見えない欠落になる)。
function validateCategoryCoverage() {
  const covered = new Set();
  CATEGORIES.forEach(c => categoryStoreIds(c).forEach(id => covered.add(id)));
  NOT_FOUND_IDS.forEach(id => covered.add(id));
  const missing = VENUES.filter(v => !v.preopen && !covered.has(v.id));
  if (missing.length) {
    throw new Error('gen-guide-pages.js: 「福岡のポーカー店を目的別に探す」のCATEGORIES/NOT_FOUND_IDSの'
      + 'どちらにも含まれていない店舗があります: ' + missing.map(v => `${v.id} ${v.name}`).join('、')
      + '(該当するカテゴリーに追記するか、特色が確認できていなければ NOT_FOUND_IDS に加えてください)');
  }
}
validateCategoryCoverage();

// エリアから探す(原稿の短い紹介文。gen-area-pages.js の AREA_CONTENT はエリアページ本体用の
// 長い紹介文で、こちらはこのガイドページ専用の一言。役割が違うので使い回さない)。
const AREA_INTRO = {
  '天神': '福岡随一の繁華街で、店舗数の多いエリアの一つです。',
  '中洲': '天神と並ぶ繁華街で、天神と同じく店舗数が多いエリアです。公式な初心者講習の明記がある店舗は今のところありませんが、外部レビューでは初心者でも入りやすいと紹介されている店舗もあります。',
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
  .gd-cat{margin-bottom:14px}
  .gd-cat h3{display:flex;align-items:center;gap:7px;font-size:.95em;font-weight:800;color:var(--felt);margin:18px 0 8px}
  .gd-cat-ic{flex:0 0 auto;width:19px;height:19px;color:var(--gold)}
  .gd-cat-ic svg{display:block;width:100%;height:100%}
  .gd-card-points{margin:6px 0 4px 1.15em;padding:0;font-size:.82em;line-height:1.6;color:var(--txt)}
  .gd-card-points li{margin-bottom:2px}
  .gd-card-src{font-size:.72em;color:var(--mut);margin-top:4px}
`;

// ---- カテゴリー見出しのアイコン(社長指示: ストローク系のインラインSVG・絵文字は使わない) ----
// 店舗ページ改修(PR #91 feat/venue-page-card-redesign)の ICONS/ICON_ATTR と同じ様式にそろえる
// (fill=none・stroke=currentColor・stroke-width 1.8・角丸のシンプルなピクトグラム)。
// ブランドロゴの模写はしない(同PRと同じ理由)。
const ICON_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  // トロフィー(トーナメント)
  trophy: `<svg ${ICON_ATTR}><path d="M7 4h10v3a5 5 0 0 1-10 0V4z"/><path d="M7 5H4.5A2.5 2.5 0 0 0 7 7.5"/><path d="M17 5h2.5A2.5 2.5 0 0 1 17 7.5"/><path d="M12 12v3"/><path d="M9 19h6"/><path d="M10.5 15h3l.8 4h-4.6l.8-4z"/></svg>`,
  // カードマーク(リングゲーム)
  cards: `<svg ${ICON_ATTR}><rect x="3.5" y="3" width="10" height="14" rx="1.6"/><rect x="10.5" y="7" width="10" height="14" rx="1.6"/></svg>`,
  // サイコロ(バカラ・ブラックジャック等のサイドゲーム)
  dice: `<svg ${ICON_ATTR}><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1" fill="currentColor" stroke="none"/></svg>`,
  // グラス(ドリンク)
  glass: `<svg ${ICON_ATTR}><path d="M6 3h12"/><path d="M6 3c0 4.5 2.5 7 6 7s6-2.5 6-7"/><path d="M12 10v7"/><path d="M8.5 21h7"/></svg>`,
  // シャッフル(ミックスゲーム・PLO)
  shuffle: `<svg ${ICON_ATTR}><path d="M4 6.5h3.2c1.8 0 2.8.8 3.6 2"/><path d="M4 17.5h3.2c1.8 0 2.8-.8 3.6-2"/><path d="M14 6.5h6"/><path d="M14 17.5h6"/><path d="M17.5 4l2.5 2.5L17.5 9"/><path d="M17.5 15l2.5 2.5-2.5 2.5"/></svg>`
};
function catIcon(name) { return ICONS[name] ? `<span class="gd-cat-ic">${ICONS[name]}</span>` : ''; }

// ============================================================
// 本文の組み立て
// ============================================================

// ---- 福岡のポーカー店を目的別に探す(6カテゴリー。2026-09-12改訂〔文章圧縮・カード化版〕で
//      「3つのポイント」から差し替え) ----
// featured: ポイント箇条書き＋出典を持つ店舗 → 店舗ページ(gen-venue-pages.js)の
//   「同じエリアの他のポーカー店」で使っている .vp-cards/.vp-card を土台にしたカードで表示する
//   (同じ見た目を複製せず、site-shell.js の BASE_CSS にある共通クラスをそのまま使う)。
//   カード自体は店舗ページへのリンク(<a class="vp-card">)なので、中に箇条書き(.gd-card-points)と
//   出典(.gd-card-src)だけをこのファイル側のCSSで足す。
function categoryFeaturedCards(featured) {
  // 既定の .vp-cards は minmax(150px,1fr)(店舗ページの「同じエリアの他のポーカー店」= 店名＋駅名
  // 1行だけの軽いカード向け)。ここは箇条書き2〜3点＋出典まで入るため、既定のまま複数列に詰めると
  // 窮屈になる。.vp-cards 自体(店舗ページ等と共有)は変えず、この一覧だけ幅を広げる
  // (店舗ページ改修〔PR #91〕の .vp-info-grid が採る 230px と同じ値にそろえる)。
  return `<div class="vp-cards" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">
${featured.map(f => {
    const v = venueById(f.id);
    const pts = f.points.map(p => `<li>${esc(p)}</li>`).join('');
    return `  <a class="vp-card" href="/venues/${v.slug}/">
    <div class="vp-card-name">${esc(v.name)}</div>
    <div class="vp-card-sub">${esc(v.area)}</div>
    <ul class="gd-card-points">${pts}</ul>
    <div class="gd-card-src">出典: ${esc(f.source)}</div>
  </a>`;
  }).join('\n')}
</div>`;
}

// chips: 具体的な説明が原稿に無く、該当することだけを紹介する店舗 → 店舗ページ(gen-venue-pages.js)の
//   「同じエリアの他のポーカー店」と同じ ul.vp-list(チップ/タグ)で表示する(文章を作らず簡素に)。
function categoryChips(ids) {
  return `<ul class="vp-list">
${ids.map(id => {
    const v = venueById(id);
    return `  <li><a href="/venues/${v.slug}/">${esc(v.name)}（${esc(v.area)}）</a></li>`;
  }).join('\n')}
</ul>`;
}

function categoryBlock(c) {
  const chipsPart = c.chips && c.chips.length
    ? `${c.chipsIntro ? `<p class="lead">${esc(c.chipsIntro)}</p>` : ''}${categoryChips(c.chips)}`
    : '';
  return `<div class="gd-cat">
  <h3>${catIcon(c.icon)}${esc(c.heading)}</h3>
  <p class="lead">${esc(c.lead)}</p>
  ${categoryFeaturedCards(c.featured)}
  ${chipsPart}
</div>`;
}

// 6カテゴリーいずれにも該当が見つからなかった店舗の案内(原稿の方針: 無理に一覧化・当てはめず、
// 「確認できていないだけ」と率直に書く)。店名はチップ形式で先に見せ、文章側は「上記の店舗」と
// 参照する(店名を文章中に列挙すると「文字だらけ」に戻るため、社長指摘〔2026-09-12〕を踏まえて分離)。
function notFoundBlock() {
  const listedCount = VENUES.filter(v => !v.preopen).length;
  return `<div class="gd-cat">
  <h3>上記のカテゴリーに当てはまらなかった店舗について</h3>
  ${categoryChips(NOT_FOUND_IDS)}
  <p class="lead">上記の店舗については、当サイトが調査した時点では、上記のような特色を裏付ける外部の紹介記事・口コミは見つかりませんでした。特色がないという意味ではなく、当サイトが確認できていないだけですので、無理に当てはめず率直にお伝えします。これらの店舗も含めた掲載中の全${listedCount}店舗は、この後の「福岡のポーカー店 全一覧」でご覧いただけます。</p>
</div>`;
}

function categoriesBlock() {
  const cats = CATEGORIES.map(categoryBlock).join('\n');
  return `
<h2 class="day">福岡のポーカー店を目的別に探す</h2>
<p class="lead">福岡のポーカー店は、それぞれ得意なスタイルや雰囲気が異なります。ここでは外部のレビューサイト・紹介記事・店舗公式SNS等をもとに、目的別に店舗を整理し、各店の特徴を簡潔な「ポイント」にまとめました。当サイトが独自に採点・順位付けしたものではなく、あくまで公開されている情報の紹介です。とくに確度が高いとまでは言えない情報には「(要確認)」を添えています。実際の運営状況・イベント内容は変更されることがあるため、参加前には必ず各店舗の公式サイト・SNS等で最新情報をご確認ください。</p>
${cats}
${notFoundBlock()}`;
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
  // 「初心者でも入りやすい」と外部レビューで紹介されている中洲エリアの店舗(前段の
  // カテゴリー「リングゲーム、初心者でも安心して打ちたいなら」で紹介済み)を実データから拾い、
  // 文中で名指しする2店を検算する(手で書いた店名が原稿・実データとズレるのを防ぐ)。
  const nakasuFriendlyInCategory = categoryStoreIds(CATEGORIES[1])
    .map(id => venueById(id))
    .filter(v => v.area === '中洲');
  if (nakasuFriendlyInCategory.length < 2) {
    throw new Error('gen-guide-pages.js: 「中洲エリアについて」の文言が名指しする2店(m HOLD\'EM 中洲・ONECASINO 福岡中洲)を'
      + 'カテゴリーデータから拾えませんでした。CATEGORIES[1](リングゲーム、初心者でも安心して打ちたいなら)を確認してください。');
  }
  const nakasuFriendlyNames = nakasuFriendlyInCategory.slice(0, 2)
    .map(v => `<a href="/venues/${v.slug}/">${esc(v.name)}</a>`).join('や ');
  return `
<h2 class="day">初心者講習が明記されている福岡のポーカー店</h2>
<p class="lead">以下の6店舗は、公式サイトや公式SNS等で「初心者講習」「初心者プラン」といった表記が確認できた店舗です。当サイトが独自に優劣を判定したものではなく、各店舗自身が発信している情報をそのまま紹介しています。内容は変更されることがあるため、来店前には必ず各店舗の最新の公式情報をご確認ください。</p>
${cards}
<div class="disclaimer">中洲エリア(${nakasuCount}店舗)には、公式サイト・SNS等で「初心者講習」の実施を明記している店舗は2026年9月時点で確認できていません。ただし、前述の「福岡のポーカー店を目的別に探す」でご紹介した通り、外部のレビューサイトでは ${nakasuFriendlyNames} などが「初心者でも入りやすい」と紹介されている例があります。公式な講習の実施有無と、来店者からの評判は別の情報のため、中洲エリアで初めての来店を検討する場合は、事前に各店舗の公式SNS等で初心者対応の可否を直接確認することをおすすめします。</div>`;
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
const TITLE = '福岡のポーカー店の選び方｜目的別おすすめ・初心者向け比較ガイド | ふくおかポーカーナビ';

function buildGuidePage() {
  const listedCount = VENUES.filter(v => !v.preopen).length;
  const DESC = `福岡には${listedCount}店舗のポーカー店があり、初めてだとどこに行けばいいか迷いがちです。トーナメント重視・リングゲームでじっくり・お酒も楽しみたいなど目的別のおすすめ店舗と、初心者講習を実施している店舗、エリア別の探し方をまとめて紹介します。`;

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
<p class="lead">福岡県内には、天神・中洲・北九州・久留米などのエリアを中心に${listedCount}店舗のポーカー店があります。「お店が多すぎて、初心者はどこに行けばいいか分からない」――そう感じる方も多いのではないでしょうか。</p>
<p class="lead">そこでこのページでは、「トーナメント重視」「リングゲームでじっくり」「お酒も楽しみたい」など、遊び方の目的別に、各店舗がどんな特色で紹介されているかをカテゴリーごとに整理しました。あわせて、公式に初心者講習を掲げている店舗の紹介、エリアごとの探し方、掲載中の全${listedCount}店舗の一覧も用意しています。</p>
<div class="disclaimer">当サイトは店舗の優劣を独自に採点・ランキング化するものではなく、各店舗の公式情報や、外部のレビューサイト・紹介記事で語られている内容を整理してお伝えするものです。参加前には必ず各店舗の最新の公式情報をご確認ください。<br>${POSITIONING}</div>
${categoriesBlock()}
${highlightStoresBlock()}
${areaNavBlock()}
${fullList.html}
${faq.html}
<h2 class="day">トーナメントに挑戦したくなったら</h2>
<p class="lead">店選びの参考になったら、次はぜひ実際の大会日程もチェックしてみてください。当サイトのトップページでは、福岡県内で開催されるポーカートーナメント・大会の日程を、日付・エリア・種類(サテライト/PLO/NLHなど)で絞り込んで一覧表示できます。</p>
<a class="cta" href="/">▶ 福岡のポーカートーナメント・大会日程一覧はこちら<small>日付・エリア・種類で絞り込んで表示</small></a>
<h2 class="day">まとめ</h2>
<ul style="margin:0 0 14px 1.3em;font-size:.9em;line-height:2">
  <li>福岡のポーカー店選びで迷ったら、まずは「トーナメント重視」「リングゲームでじっくり」「お酒も楽しみたい」など、自分の目的に合ったカテゴリーから探すのがおすすめです。</li>
  <li>公式サイト・SNS等で「初心者講習」「初心者プラン」の実施が明記されているのは、2026年9月時点で${HIGHLIGHT_STORES.filter(h => !h.noCourseBadge).map(h => esc(venueById(h.id).name)).join('・')} の${BEGINNER_COURSE_IDS.length}店舗です(${HIGHLIGHT_STORES.filter(h => h.noCourseBadge).map(h => esc(venueById(h.id).name)).join('・')}は「女性・初心者向け」の表記のみで、講習の実施明記はありません)。中洲エリアには公式な講習明記店はありませんが、外部レビューでは初心者でも入りやすいと紹介されている店舗もあります。</li>
  <li>当サイトは店舗・主催者そのものではなく、公式情報や外部の紹介記事・口コミをもとにまとめた案内サイトです。当サイトが店舗の優劣を判定・ランキング化することはありません。掲載内容は変更されることがあるため、来店前には必ず各店舗の公式サイト・SNS等で最新情報をご確認ください。</li>
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
  // 店舗ページへのリンクは「全店舗一覧表(未開店を除く全件)」＋「目的別カテゴリー(6分類、延べ件数。
  // 同じ店舗が複数カテゴリーに登場する分もそのまま数える)」＋「該当なし店舗の案内(NOT_FOUND_IDS)」＋
  // 「初心者講習ハイライト(6件)」＋「『中洲エリアについて』が名指しする2件」の合計。
  const categoryLinkCount = CATEGORIES.reduce((sum, c) => sum + categoryStoreIds(c).length, 0);
  const nakasuMentionLinkCount = 2;
  const expectedVenueLinks = listedCount + categoryLinkCount + NOT_FOUND_IDS.length
    + HIGHLIGHT_STORES.length + nakasuMentionLinkCount;
  if (linked !== expectedVenueLinks) {
    problems.push(`店舗ページへのリンク数が ${linked} 件(期待値: 全一覧${listedCount}件 + カテゴリー延べ${categoryLinkCount}件`
      + ` + 該当なし${NOT_FOUND_IDS.length}件 + ハイライト${HIGHLIGHT_STORES.length}件 + 中洲言及${nakasuMentionLinkCount}件`
      + ` = ${expectedVenueLinks}件)`);
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
