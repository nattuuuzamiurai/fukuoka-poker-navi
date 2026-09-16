#!/usr/bin/env node
/**
 * guide-categories.js
 *
 * 「福岡のポーカー店を目的別に探す」(6分類)の定義そのもの。
 * 元々は tools/gen-guide-pages.js の中にだけ置いてあったが、店舗静的ページ
 * (tools/gen-venue-pages.js)からも「この店はどの目的別カテゴリーに載っているか」を
 * 引けるようにするため、このファイルに切り出した(2026-09-13・内部リンク追加)。
 *
 * 【なぜ data.js / fukuoka-venues.json に guideCategories のような新フィールドを
 *   追加しなかったか】
 *   店舗→カテゴリーの対応表そのものは、この CATEGORIES(featured/chips)が既に唯一の
 *   正である。これを data.js 側に「複製」すると、CATEGORIES を直したときに
 *   data.js 側を直し忘れる事故(2箇所が食い違う)が起きる。それを避けるため、対応表を
 *   複製せず CATEGORIES 自体を独立ファイルに出し、gen-guide-pages.js と
 *   gen-venue-pages.js の両方がここから読む(area-schedule.js・venue-schedule.js が
 *   複数の生成スクリプトから共有される既存のパターンと同じ考え方＝「判定を1箇所に集める」)。
 *   ★ data.js のスキーマ・VENUES の項目には一切手を入れない、という
 *     gen-guide-pages.js の既存方針(切り出し前からのヘッダーコメント参照)もそのまま守っている。
 *
 * 【中身・出典・確度】featured/chips の店舗構成そのものは、この切り出しで一切変えていない
 *   (構成の移動のみ)。出典・確度についての注記は tools/gen-guide-pages.js 側のヘッダー
 *   コメント(「CATEGORIES(カテゴリー)の出典は主に外部レビューサイト…」)を参照。
 *
 * 【shortLabel(2026-09-13新設)】店舗ページの「関連ガイド」リンクでだけ使う短い言い回し。
 *   ガイドページ本体の見出し(heading)はリンクの文脈では長すぎるため
 *   (例: heading「リングゲーム、初心者でも安心して打ちたいなら」に対し
 *   shortLabel「リング・初心者」)、リンクテキスト専用の短縮ラベルを別に持たせてある。
 *   heading の要約ではなく言い換えなので、heading を変えても shortLabel は自動追随しない
 *   (見出しの表現を変えたときは、リンク文言として不自然になっていないか合わせて見直すこと)。
 */

const CATEGORIES = [
  {
    id: 'cat-tournament',
    heading: 'トーナメントが強い・人気がある店を探すなら',
    shortLabel: 'トーナメント',
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
    id: 'ring-beginner',
    heading: 'リングゲーム、初心者でも安心して打ちたいなら',
    shortLabel: 'リング・初心者',
    icon: 'cards',
    lead: 'リングゲームとは、好きなタイミングで出入りできる通常のポーカーのことです。リングゲームを実施している店舗です。うち一部については「初心者でも入りやすい」「講習・接客が丁寧」といった口コミ・紹介記事も見られます(出典: 主にlight-three.com、fukuoka-online.jp等の外部レビューサイト)。',
    // 【2026-09-13・運営指摘によりfeatured→chips統合】以前はv21のみfeaturedのカード表示で、
    // 残り11店舗がchipsという、カード1枚+文字だけの列挙という偏った見た目だった。
    // カテゴリー内バランスを取るため、v21もchipsに統合した(featuredは空)。
    // 【2026-09-14・掲載漏れ3店を追加】v27(THE DOJO)・v33(Poker room SKY)・v42(DreaM CASINO BAR)は
    // data.js上ring:trueだが本カテゴリーにもring-advancedにも未掲載だった(コンテンツ制作の
    // 調査で発覚。validateCategoryCoverage()に引っかからなかったのは、それぞれ他カテゴリー
    // 〔v27はcat-drink、v33はcat-mix、v42はcat-drink〕に既に登場していたため)。
    // 3店とも初心者/上級者の明確な外部評価が無い(v42は2026年9月グランドオープンの新店で
    // 外部レビュー自体がまだ無い)ため、featuredのカード化はせずchipsにとどめる。
    // 【2026-09-17・v2を追加】v2(KKPOKER FUKUOKA)は2026年9月の料金改定の告知でリングチップの
    // 料金が判明し data.js で ring:true になった。上の3店と同じく初心者/上級者の外部評価は
    // 無いため、同じ基準でchipsにとどめる。
    featured: [],
    chips: ['v21', 'v25', 'v3', 'v13', 'v14', 'v7', 'v4', 'v6', 'v28', 'v23', 'v40', 'v41', 'v27', 'v33', 'v42', 'v2']
  },
  {
    id: 'ring-advanced',
    heading: 'リングゲーム、腕試ししたい・ガチでやりたいなら',
    shortLabel: 'リング・上級者',
    icon: 'cards',
    lead: '※リングゲームとは、好きなタイミングで出入りできる通常のポーカーのことです。遊技スタイルとして「上級者向け」「本格的」と紹介されている店舗です。「勝てる」「稼げる」という意味ではなく、あくまでゲームの雰囲気についての紹介である点にご留意ください。',
    // 【2026-09-13・v30(ARIA中洲)を削除】運営からの情報により閉店した可能性がある(data.js側で
    // "closed": true・要確認)。chipsに落とすのではなく、閉店の可能性がある店を積極的に
    // おすすめする形自体をやめるため、このカテゴリーから削除した(他カテゴリーにも未掲載)。
    featured: [
      { id: 'v22', points: ['上級者向けの遊技スタイル', 'ハイローラー向けイベントを定期開催'], source: '紹介記事より' },
      { id: 'v16', points: ['「スポーツポーカー競技場」を自称', '戦略性・心理戦を重視するスタイル'], source: '口コミより' }
    ]
  },
  {
    id: 'cat-baccarat',
    heading: 'バカラ・ブラックジャックも遊びたいなら',
    shortLabel: 'バカラ・ブラックジャック',
    icon: 'dice',
    lead: 'ポーカーのほかにバカラ・ブラックジャックなど複数のゲームを扱っていると案内されている店舗です。',
    // 【2026-09-13・運営指摘によりfeatured→chips統合】上のリングゲームカテゴリーと同じ理由で、
    // v5もchipsに統合した(featuredは空)。
    featured: [],
    chips: ['v5', 'v9', 'v3', 'v29', 'v39', 'v19', 'v37', 'v41']
  },
  {
    id: 'cat-drink',
    heading: 'お得にお酒も楽しみたいなら',
    shortLabel: 'ドリンク',
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
    id: 'cat-mix',
    heading: 'ミックスゲーム・PLOを打ちたいなら',
    shortLabel: 'ミックス・PLO',
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

// カテゴリー内の全店舗id(featured＋chips)を1つにまとめる。gen-guide-pages.js の
// verify()・validateCategoryCoverage() と、このファイルの categoriesByVenueId() の
// 両方から使う(同じ集め方を2箇所に書かない)。
function categoryStoreIds(c) {
  return [...c.featured.map(f => f.id), ...(c.chips || [])];
}

// 店舗id → 所属カテゴリー(複数可)の配列。順序は CATEGORIES の定義順
// (同じ店が複数カテゴリーに登場する場合、店舗ページ側のリンクもこの順で並ぶ)。
// 該当カテゴリーが無い店(NOT_FOUND_IDS・未開店・閉店の可能性がある店など)は
// このMapにエントリを持たない(呼び出し側は get() の戻り値が undefined/空配列になる想定で書く)。
function categoriesByVenueId() {
  const map = new Map();
  CATEGORIES.forEach(c => {
    categoryStoreIds(c).forEach(id => {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(c);
    });
  });
  return map;
}

module.exports = { CATEGORIES, categoryStoreIds, categoriesByVenueId };
