#!/usr/bin/env node
/**
 * gen-sitemap.js — sitemap.xml の【唯一の所有者】
 *
 * 【なぜ独立したファイルなのか】
 *   sitemap.xml に載せるURLは3種類のソースにまたがる:
 *     - 大型イベントページ … big-events.js のレジストリ(featureUrl が /events/ で始まるもの)
 *     - 単発の店舗プロモーション … promo-banners.js のレジストリ(href が /events/ で始まるもの。
 *       2026-09-02追加。BIG_EVENTSとは別レジストリだが、静的ページを持つ点は同じなので
 *       sitemapの掲載元としては同列に扱う)
 *     - 店舗ページ         … data.js の VENUES(slug)
 *   これを gen-event-pages.js と gen-venue-pages.js がそれぞれ自前で組み立てると、
 *   「後に実行したほうが相手のURLを消す」奪い合いになる。
 *   そこで sitemap.xml の中身を決める場所をこのファイル1つに限定した。
 *
 * 【どの順で実行しても同じ内容に収束する理由】
 *   gen-event-pages.js と gen-venue-pages.js は、自分では1行も組み立てず
 *   このファイルの sitemapFile(REPO) を呼んで結果をそのまま書く。
 *   入力(big-events.js / data.js)が同じなら出力は同じ文字列になるので、
 *   どちらをどの順に実行しても、何回実行しても、内容は変わらない。
 *   「片方を実行し忘れて sitemap が古くなる」も起きない(どちらを実行しても全URLが揃う)。
 *
 * 【changefreq / priority を日付で変えない理由】
 *   終了した大会を monthly / 低優先度に落とす、という条件分岐は入れていない。
 *   「実行した日によって出力が変わる」＝ データを1文字も触っていないのに翌日には
 *   --check が落ちる、ということになり、検査そのものが信用できなくなるため。
 *   changefreq・priority はいずれもクローラへの弱いヒントで、Googleはほぼ見ていない。
 *
 * 【lastmod の決め方(GEO監査2026-09-03 3章②への対応)】
 *   実行日には一切依存させない(上記の理由と同じ)。代わりに、そのURLの中身の元になっている
 *   データソースの【git履歴上の最終更新コミット日時】(`git log -1 --format=%cI -- <ファイル>`)を使う。
 *   同じgit履歴に対しては何度実行しても同じ値が返るため、`--check` の決定論性は壊れない
 *   (実行者のタイムゾーン・実行時刻には依存しない。%cI はコミット時のタイムゾーン付きISO8601)。
 *   対応表:
 *     - トップ             … data.js 全体の最終更新コミット日時
 *     - 大型イベントページ … そのURLに対応するデータファイル(jopt-data.js / nippon-series-data.js /
 *                            fst-schedule-data.js 等)と big-events.js(会期・レジストリ)の
 *                            最終更新コミット日時のうち新しい方
 *       ★WJPTだけは専用データファイルを持たず index.html 内の `const WJPT` に直書きされているが、
 *         index.html 自体は無関係な変更(フッター同期・他イベントのバナー追加等)で毎日のように
 *         変わるため、そのままlastmodに使うと「更新していないのに毎回今日に見える」という
 *         誤った鮮度シグナルになる(嘘の鮮度は無いより悪い)。そのためWJPTは big-events.js
 *         (会期・サテライト実績等のレジストリ)だけを見る。将来 WJPT 用の専用データファイルを
 *         切り出したら、そのファイルを対象に加えること。
 *     - 単発の店舗プロモーションページ(promo-banners.js) … promo-banners.js の最終更新コミット日時
 *     - 店舗ページ         … data.js と fukuoka-venues.json のうち新しい方(店舗ごとの個別コミット
 *                            ではなく、両ファイルを合わせた全店共通の値。全店のデータが同じ2ファイルに
 *                            同居しているため、これ以上の店舗単位の分解は行わない)
 *     - エリアページ       … 店舗ページと同じ2ファイル(該当エリアの店舗データも同じ2ファイルに
 *                            含まれるため、店舗ページと同じ値になる。これは不正確ではなく、
 *                            「実際に区別できる粒度がそこまで」という実態を正直に表している)
 *     - /about.html        … about.html 自体の最終更新コミット日時
 *   git が使えない(浅いクローン等でコミットが見つからない)場合は lastmod を省略する
 *   (無い方が「嘘の日付」を出すより安全)。CI(GitHub Actions)側は既に
 *   `actions/checkout@v4` に `fetch-depth: 0` を指定済み(このsitemap生成を呼ぶ
 *   import-waitinglist.yml / import-texaspoker.yml / monitor-instagram-apify.yml の3ワークフロー
 *   いずれも設定済み。2026-09-03 dev-lead確認)。
 *
 * 使い方:
 *   node gen-sitemap.js <リポジトリのパス>            … sitemap.xml を書き出す
 *   node gen-sitemap.js <リポジトリのパス> --check     … 書き込まず、ディスクの内容と一致するかだけ見る
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const shell = require('./site-shell.js');
const { SITE } = shell;
// 「その店に掲載中の日程があるか」の判定は venue-schedule.js が所有する。
// gen-venue-pages.js の title/description の分岐と同じ基準を使うため。
const { hasSchedule } = require('./venue-schedule.js');
// 「どのエリアにページがあるか」「そのエリアに掲載中の日程があるか」の判定は
// area-schedule.js が所有する。gen-area-pages.js の生成対象と同じ基準を使うため
// (基準が2箇所に分かれると「sitemapには載っているのにページが無い」が起きる)。
const { AREA_SLUGS, areaVenues, areaList, hasAreaSchedule } = require('./area-schedule.js');

// URLごとの changefreq / priority。日付には依存させない(上記の理由)。
const HOME = { freq: 'daily', pri: '1.0' };
const EVENT = { freq: 'weekly', pri: '0.8' };
const VENUE = { freq: 'weekly', pri: '0.7' };
// エリアページは複数店を束ねるので、単独の店舗ページより上位の受け皿にあたる。
// ただし priority は Google がほぼ見ないヒントなので、序列の宣言以上の意味は持たせない。
const AREA = { freq: 'weekly', pri: '0.8' };
// 運営者情報ページ(依頼3・GEO監査2026-09-03)。更新頻度は低いページなので monthly・低priorityにする。
const ABOUT = { freq: 'monthly', pri: '0.3' };

// ---- lastmod: git履歴ベースで決定論的に求める ----
// big-events.js の各イベントの id → そのイベント固有のデータファイル(会期・共通レジストリの
// big-events.js とは別に、そのイベント専用の中身を持つファイル)。
// ここに無いidは big-events.js だけを見る(=WJPTのように専用ファイルを持たないケース。
// 理由はファイル冒頭のコメント「lastmod の決め方」を参照)。
const EVENT_DATA_FILES = {
  jopt: ['jopt-data.js'],
  nippon: ['nippon-series-data.js'],
  fst: ['fst-schedule-data.js']
};

/**
 * 指定ファイル群の【最終更新コミット日時】(ISO8601・コミット時のタイムゾーン付き)を返す。
 * 複数ファイルを渡した場合は、そのうち最も新しいコミット日時(=そのURLの実質的な最終更新日)。
 * git を実行できない/対象コミットが見つからない場合は null(=lastmodを省略する)。
 * 【決定論性】実行時刻には一切依存しない。同じgit履歴に対しては常に同じ値を返す。
 */
function lastCommitDate(REPO, files) {
  let latest = null;
  for (const f of files) {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', f], { cwd: REPO, encoding: 'utf8' }).trim();
      if (out && (!latest || out > latest)) latest = out;
    } catch (e) {
      // git 不在・対象外リポジトリ等。この1ファイルぶんだけ諦めて他のファイルで判定を続ける。
    }
  }
  return latest;
}

/** sitemap.xml の中身(文字列)を組み立てる。REPO は絶対パスで渡すこと。 */
function buildSitemap(REPO) {
  // 同一ファイル群に対する git log 呼び出しは1回の buildSitemap 実行内で使い回す
  // (店舗ページ・エリアページは全件が同じ2ファイルを参照するため、店舗数ぶん重複実行しない)。
  const lastmodCache = new Map();
  const lastmodFor = files => {
    const key = files.join('|');
    if (!lastmodCache.has(key)) lastmodCache.set(key, lastCommitDate(REPO, files));
    return lastmodCache.get(key);
  };
  const BIG = require(path.join(REPO, 'big-events.js'));
  const PROMO = require(path.join(REPO, 'promo-banners.js'));
  const DATA = require(path.join(REPO, 'data.js'));

  // slug が欠けている・重複している状態の sitemap は公開してはいけないので、ここでも止める。
  shell.validateVenueSlugs(DATA.VENUES);

  // トップ: data.js 全体(VENUES/TOURNAMENTS/RECURRING/AREAS)の最終更新コミット日時。
  const urls = [{ loc: `${SITE}/`, lastmod: lastmodFor(['data.js']), ...HOME }];

  // 大型イベント: 静的ページを持つものだけ(featureUrl がハッシュURLの大会はトップの一部なので載せない)。
  // 会期の古い順。レジストリに大会を足して静的ページを作れば、ここにも自動で増える。
  // lastmod は big-events.js(共通レジストリ) + そのイベント専用のデータファイル(あれば)のうち新しい方。
  BIG.BIG_EVENTS
    .slice()
    .sort((a, b) => String(BIG.eventFirstDay(a.days)).localeCompare(String(BIG.eventFirstDay(b.days))))
    .filter(e => e.featureUrl && e.featureUrl.startsWith('/events/'))
    .forEach(e => urls.push({
      loc: SITE + e.featureUrl,
      lastmod: lastmodFor(['big-events.js', ...(EVENT_DATA_FILES[e.id] || [])]),
      ...EVENT
    }));

  // 単発の店舗プロモーションページ(promo-banners.js。2026-09-02追加): 静的ページを持つものだけ。
  // BIG_EVENTSと同じ理由(掲載中/終了で出し分けない。上記「changefreq/priorityを日付で変えない理由」参照)で、
  // 掲載ウィンドウ(visiblePromoBanners)には縛られず、レジストリにある間は常にsitemapへ載せ続ける。
  // lastmod は promo-banners.js(このレジストリがプロモの中身そのものを持つ)の最終更新コミット日時。
  PROMO.PROMO_BANNERS
    .filter(p => p.href && p.href.startsWith('/events/'))
    .forEach(p => urls.push({ loc: SITE + p.href, lastmod: lastmodFor(['promo-banners.js']), ...EVENT }));

  // 店舗ページ: 掲載中の日程が1件以上ある店だけ。
  // 【なぜ全件載せないか】このサイトの現時点の収益ゲートは検索順位ではなく AdSense審査で、
  //   審査はサイト全体のコンテンツ量・質を見る(不承認理由の最頻出が「価値の低い広告枠」)。
  //   日程0件の店のページは実質「住所＋アクセス＋SNS＋noteの1行」しかなく、
  //   これが全URLの3割を占める状態で審査を受けるリスクを避ける[社長判断・2026-07-30]。
  //   ページ自体は生成・公開し、トップの店舗リンク行(#venueLinks)からも辿れるので、
  //   URLの早期確定と被リンクの受け皿という狙いは sitemap 掲載と独立に達成できる。
  //   日程が1件でも入れば次の生成で自動的に載る(手当ては不要)。
  // 【判定の所有者】venue-schedule.js の hasSchedule()。gen-venue-pages.js の
  //   title/description の分岐とまったく同じ基準を使う(基準が分かれるとズレる)。
  //   判定に使う期間も hasSchedule() の中(venueRange)で決まる。ここで期間を作って渡すと、
  //   店舗別になった期間の作り方が2箇所に分かれて、また基準がズレる。
  // lastmod は data.js + fukuoka-venues.json のうち新しい方(店舗ごとの個別コミットへの
  // 分解はしない。理由はファイル冒頭のコメント「lastmod の決め方」参照)。
  const VENUE_LASTMOD = lastmodFor(['data.js', 'fukuoka-venues.json']);
  DATA.VENUES
    .filter(v => hasSchedule(DATA.TOURNAMENTS, DATA.RECURRING, v.id))
    .forEach(v => urls.push({ loc: `${SITE}/venues/${v.slug}/`, lastmod: VENUE_LASTMOD, ...VENUE }));

  // エリアページ: 2店舗以上あり(=ページが存在する)、かつ掲載中の日程が1件以上あるエリアだけ。
  // 店舗ページと同じ考え方で、日程0件のページを審査対象の全URLに混ぜない[社長判断・2026-07-30]。
  // ページ自体は生成され、トップのエリアリンク行(#areaLinks)から辿れる。
  // lastmod は店舗ページと同じ2ファイル(該当エリアの店舗データも同じファイルに同居しているため)。
  areaList(DATA.VENUES, DATA.AREAS)
    .filter(a => hasAreaSchedule(DATA.TOURNAMENTS, DATA.RECURRING, areaVenues(DATA.VENUES, a)))
    .forEach(a => urls.push({ loc: `${SITE}/areas/${AREA_SLUGS[a]}/`, lastmod: VENUE_LASTMOD, ...AREA }));

  // 運営者情報ページ(依頼3・GEO監査2026-09-03)。ファイル自体が存在するときだけ載せる
  // (このリポジトリを使う別環境・過去のコミット等でファイルが無い場合に壊れないようにするため)。
  if (fs.existsSync(path.join(REPO, 'about.html'))) {
    urls.push({ loc: `${SITE}/about.html`, lastmod: lastmodFor(['about.html']), ...ABOUT });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <changefreq>${u.freq}</changefreq>
    <priority>${u.pri}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

/**
 * 他の生成スクリプトの files マップにそのまま混ぜるための形。
 * 呼び出し側は中身を一切加工せずに書き出すこと(加工すると所有者が2つになる)。
 */
function sitemapFile(REPO) {
  return { 'sitemap.xml': buildSitemap(REPO) };
}

module.exports = { buildSitemap, sitemapFile };

// ---- CLI ----
// require されただけでは何も起きない。--check のつもりで読み込んで上書きする事故を防ぐため。
if (require.main === module) {
  const args = process.argv.slice(2);
  const CHECK = args.includes('--check');
  const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
  if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
  const REPO = path.resolve(REPO_ARG);

  const want = buildSitemap(REPO);
  const p = path.join(REPO, 'sitemap.xml');
  let cur = null;
  try { cur = fs.readFileSync(p, 'utf8'); } catch (e) { /* 未生成 */ }
  const count = (want.match(/<loc>/g) || []).length;

  if (CHECK) {
    if (cur !== want) {
      console.error('\n✗ sitemap.xml が最新ではありません（node tools/gen-sitemap.js <repo> を実行してください）');
      process.exit(1);
    }
    console.log('検査: sitemap.xml は最新（' + count + 'URL）');
  } else if (cur === want) {
    console.log('据置: sitemap.xml (' + count + 'URL・変更なし)');
  } else {
    fs.writeFileSync(p, want, 'utf8');
    console.log('生成: sitemap.xml (' + count + 'URL)');
  }
}
