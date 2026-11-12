#!/usr/bin/env node
/**
 * gen-event-pages.js
 *
 * 検索流入用に、大型イベント(JOPT / WJPT / NIPPON SERIES / FST / SPADIE)のクローラブルな静的ページを生成する。
 * SPAのハッシュURL(#jopt 等)は個別ページとしてインデックスされないため、
 * /events/<slug>/index.html という実URLの静的ページを用意する。
 *
 * データは既存の検証済みソースからそのまま読み込む(数値を手打ちしない):
 *   - JOPT:          jopt-data.js (window.JOPT_DATA / module.exports)
 *   - WJPT:          index.html 内の const WJPT = {...} を抽出
 *   - NIPPON SERIES: nippon-series-data.js
 *   - FST:           index.html 内の const FST = {...} を抽出
 *   - SPADIE:        spadie-data.js (2026-11-12、公式Players Guideで全トーナメントが判明したため追加)
 *
 * 生成物:
 *   - events/jopt-2026-fukuoka-01/index.html
 *   - events/wjpt-2026/index.html
 *   - events/nippon-series-2026-fukuoka/index.html
 *   - events/fst-2026-fukuoka/index.html
 *   - events/spadie-fukuoka-1st/index.html … 2026-09-08追加(SPADIE FUKUOKA 1st)
 *   - sitemap.xml … 中身は tools/gen-sitemap.js が決める(店舗ページのURLも入るため)。
 *                    このスクリプトは受け取った文字列をそのまま書くだけで、組み立てない。
 *   - index.html の【恒久リンク行(#evtLinks)だけ】を上書き同期する
 *       … このスクリプトが index.html を触るのはこの1行だけ。他の箇所には一切手を出さない。
 *
 * 使い方:
 *   node gen-event-pages.js <リポジトリのパス>            … 生成/同期する
 *   node gen-event-pages.js <リポジトリのパス> --check     … 書き込まず、ディスクの内容と一致するかだけ見る
 *                                                          (一致しなければ非ゼロ終了。CI・レビュー用)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
// ★ 受け取ったパスは必ず絶対パスに直す。
//   path.join('.', 'jopt-data.js') は './jopt-data.js' ではなく 'jopt-data.js' に正規化されるため、
//   require() がファイルではなく【パッケージ名】として解決しようとして MODULE_NOT_FOUND になる。
//   READMEに書いてある `node tools/gen-event-pages.js .` が実際にそれで動かなかった。
const REPO = path.resolve(REPO_ARG);

// ページの外側(<head>・GA4・CSS・ヘッダー・フッター・自社広告・恒久リンク行)と
// 共通ユーティリティは tools/site-shell.js に寄せてある。
// 店舗ページ(tools/gen-venue-pages.js)がまったく同じ骨格を使うため、複製せず共有する。
const shell = require('./site-shell.js');
const { SITE, POSITIONING, esc, fmtDate, LINK_SEP, pageHead, FAQ_CSS, faqBlock, adCard, ADCARD_CSS, BANNER_CSS, siteBannerSection } = shell;
// sitemap.xml の唯一の所有者。中身はここでは組み立てず、丸ごと受け取って書くだけ。
const { sitemapFile } = require('./gen-sitemap.js');

// ---- データ読み込み ----
const JOPT = require(path.join(REPO, 'jopt-data.js'));
// 大型イベントのレジストリ(会期・掲載期間ルール)。ブラウザ側と同じファイルを使う。
const BIG = require(path.join(REPO, 'big-events.js'));
// サイト全体のバナー(トップページ最上部と同じ内容)を大会ページ上部にも出す(2026-09-26)。
const SITE_BANNER = require(path.join(REPO, 'site-banner.js'));
const NIPPON = require(path.join(REPO, 'nippon-series-data.js'));
// FST 5.0 メイン会場(ホテルニューオータニ博多)の全日程。出典・注意点はファイル冒頭のコメントを参照。
const FST_SCHEDULE = require(path.join(REPO, 'fst-schedule-data.js'));

// index.html に直接書かれている大会データ(const WJPT / const FST)を、値を手打ちせずに取り出す。
// 対象は「行頭から2スペース字下げの `};` で閉じるオブジェクトリテラル」= index.html の書式。
// days は big-events.js のレジストリを参照しているため、同じ関数を sandbox に渡す。
function extractConst(indexSrc, name) {
  const m = indexSrc.match(new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\n  \\});'));
  if (!m) throw new Error(`index.html から ${name} を抽出できませんでした`);
  const sandbox = { bigEventDays: BIG.bigEventDays };
  vm.createContext(sandbox);
  return vm.runInContext('(' + m[1] + ')', sandbox);
}
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const WJPT = extractConst(INDEX_SRC, 'WJPT');
const FST = extractConst(INDEX_SRC, 'FST');
// FST 5.0「Main House Day1」(店舗開催のMAIN EVENT Day1フライト。サテライトではない)。
// 出典・venueId の突き合わせ方針は index.html の const FST_MAIN_HOUSE_DAY1 直前のコメントを参照。
const FST_MAIN_HOUSE_DAY1 = extractConst(INDEX_SRC, 'FST_MAIN_HOUSE_DAY1');

// ---- 大会ページ → 店舗のトーナメント日程への導線 ----
// 【なぜ必要か】検索からのアクセスの多くが大会ページ(/events/)に着地している(2026-08-18)。
//   ところが大会ページから外に出るリンクは他の大会ページと「/」への1行だけで、
//   【当サイトの本体である店舗のトーナメント日程に人が流れていない】。大型大会は年に数回
//   しかないので、大会ページを増やす方向に寄せるとサイトの趣旨(店舗のトーナメントを調べる)
//   から外れる。そこで逆に、大会ページを本体への入口として使う。
// 【終了した大会でも効く】JOPT(会期 7/30〜8/2)は終了後も検索結果への表示が続いていて
//   クリックはほぼ無い。「終わった大会を見に来た人がそのまま帰る」状態なので、
//   その人たちに「福岡では毎日どこかの店でやっている」を見せる。
// 【日付に依存させない】件数・エリアは data.js から決まるので、実行日が変わっても出力は同じ
//   (このリポジトリの生成物の原則。gen-venue-pages.js の同じ箇所のコメントを参照)。
const DATA = require(path.join(REPO, 'data.js'));
const { AREA_SLUGS, areaVenues, areaList, footerAreaLinksHtml } = require('./area-schedule.js');
// フッターの「エリアから探す」リンク行(2026-08-28追加)。全大会ページで内容は共通なので1回だけ組み立てる。
const FOOTER_AREA_LINKS = footerAreaLinksHtml(DATA.VENUES, DATA.AREAS);
// サイト全体のバナー。全大会ページで内容は共通なので1回だけ組み立てる。
const SITE_BANNER_SECTION = siteBannerSection(SITE_BANNER);

function venueScheduleBlock() {
  const areas = areaList(DATA.VENUES, DATA.AREAS);
  return `
<h2 class="day">福岡の店舗で開催されているポーカートーナメント</h2>
<p class="lead">大型大会の期間外も、福岡県内のアミューズメントポーカー店では日々トーナメントが開催されています（当サイト掲載: ${DATA.VENUES.length}店舗）。<a href="/">トップページで全店舗の日程を一覧</a>できるほか、エリアごとの日程はこちらから確認できます。</p>
<ul class="evt-areas">
${areas.map(a => `  <li><a href="/areas/${AREA_SLUGS[a]}/">${esc(a)}（${areaVenues(DATA.VENUES, a).length}店舗）</a></li>`).join('\n')}
</ul>`;
}

// ---- ページの骨格・恒久リンク行(site-shell.js) ----
// pageHead / pageFoot / permanentEventLinks の実体は tools/site-shell.js にある。
// 呼び出し側の書き方を変えずに済むよう、BIG(レジストリ)を束ねただけの薄いラッパを置く。
const permanentEventLinksList = () => shell.permanentEventLinksList(BIG);
const permanentEventLinks = currentPath => shell.permanentEventLinks(BIG, currentPath);
// currentPath: そのページ自身のパス(自己リンクを避けるため)。省略すると全件がリンクになる。
// extraScripts に SITE_BANNER_SECTION.scripts を常に足す(サイト全体のバナーのカルーセルを
// 有効にするため。0件時もinitBigEventCarouselがno-opになるだけで無害)。
const pageFoot = currentPath => shell.pageFoot(BIG, currentPath, SITE_BANNER_SECTION.scripts, FOOTER_AREA_LINKS);

// パンくずリスト(2026-08-28追加): トップ > 大会 > 大会名。
// 「大会」はトップページ内の大型一覧(#majors)へのアンカー(専用ページを持たないため)。
// label は各大会のレジストリ表示名(big-events.js の BIG_EVENTS.label。恒久リンク行と同じ出どころ)。
const pageBreadcrumb = (id, canonical) => [
  { name: 'ふくおかポーカーナビ', url: `${SITE}/` },
  { name: '大会', url: `${SITE}/#majors` },
  { name: BIG.bigEventById(id).label, url: canonical }
];

// ---- トップページ(index.html)の恒久リンク行(#evtLinks)を同期する ----
// 【なぜスクリプト側でやるのか】
//   静的ページの恒久リンク行は permanentEventLinks() が自動生成するのに、トップの #evtLinks だけは
//   「HTMLにも1行足しておくこと」という手作業の運用だった。忘れると、画面はJS(mountBigEventLinks)が
//   描き直すので正常に見えるのに、JSを実行しないクローラに対してだけリンクが欠ける。
//   ＝ 目視で気づけない壊れ方をするうえ、実際に2回発生している(1回目=両方、2回目=トップだけ見落とし)。
//   そこで「人が覚えている」に頼るのをやめ、リンクの出どころを permanentEventLinks() 1つに統一した。
//   大会を追加したときにやることは「big-events.js に1エントリ足して、このスクリプトを実行する」だけ。
const INDEX_LINKS_PREFIX = '大会ページ: ';
// 置換対象は「行頭にある <div id="evtLinks" …>…</div> の1行」だけ。
// ★ 行頭アンカー(^ + m フラグ)は必須。これが無いと、HTMLコメントの中に書いた
//   `<div id="evtLinks">` という【説明のための文字列】にまで当たってコメントごと破壊する
//   (このスクリプトを書いた当日に実際にやらかした)。
const INDEX_LINKS_RE = /^(\s*<div id="evtLinks"[^>]*>)([^\n]*?)(<\/div>)$/m;
const INDEX_LINKS_RE_G = new RegExp(INDEX_LINKS_RE.source, 'gm');
function buildIndexHtml() {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  // 「見つからない」も「複数見つかる」も、どちらも意図しない状態なので黙って通さず必ず落とす。
  const hits = src.match(INDEX_LINKS_RE_G) || [];
  if (hits.length !== 1) {
    throw new Error(`index.html の恒久リンク行(<div id="evtLinks">…</div>)が ${hits.length} 件見つかりました。`
      + '1件だけ、独立した1行として置いてください（トップの恒久リンク行を同期できません）。');
  }
  return src.replace(INDEX_LINKS_RE, (_m, open, _inner, close) =>
    open + INDEX_LINKS_PREFIX + permanentEventLinks() + close);
}

// ---- 検査: 生成物とトップの恒久リンク行がレジストリと一致しているか ----
// 生成(または --check)の最後に必ず走らせる。1件でも食い違ったら異常終了させ、
// 「気づかないまま公開される」経路を塞ぐ。人の記憶ではなくこの検査が最後の砦。
function parseLinkRow(segment, selfUrl) {
  return segment.split(LINK_SEP).map(chunk => {
    const a = chunk.match(/<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (a) return { url: a[1], label: a[2] };
    const s = chunk.match(/<span aria-current="page"[^>]*>([\s\S]*?)<\/span>/);
    if (s) return { url: selfUrl, label: s[1] };
    return { url: null, label: chunk };
  });
}
function verifyPermanentLinks(files) {
  const expected = JSON.stringify(permanentEventLinksList());
  const problems = [];
  const check = (name, actual) => {
    const got = JSON.stringify(actual);
    if (got !== expected) problems.push(`${name}\n    期待: ${expected}\n    実際: ${got}`);
  };

  const im = files['index.html'].match(INDEX_LINKS_RE);
  if (!im) problems.push('index.html: #evtLinks が見つからない');
  else if (im[2].indexOf(INDEX_LINKS_PREFIX) !== 0) problems.push('index.html: #evtLinks の見出し文字列が想定と違う');
  else check('index.html #evtLinks', parseLinkRow(im[2].slice(INDEX_LINKS_PREFIX.length), null));

  Object.keys(files).filter(f => f.startsWith('events/')).forEach(rel => {
    const m = files[rel].match(/<a href="\/">トップ<\/a>　\|　([\s\S]*?)<\/div>/);
    if (!m) { problems.push(`${rel}: 恒久リンク行が見つからない`); return; }
    check(`${rel} 恒久リンク行`, parseLinkRow(m[1], '/' + rel.replace(/index\.html$/, '')));
  });

  if (problems.length) {
    console.error('\n✗ 恒久リンク行がレジストリと一致しません:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('検査: 恒久リンク行はトップ・静的ページとも一致（' + permanentEventLinksList().length + '件）');
}

// ---- Event 構造化データの推奨項目(image / organizer / offers / performer) ----
// Search Console が4ページで「performer / offers / image / organizer がありません」と警告している。
// いずれも Google が【重大ではない問題 = 推奨項目】と明記しているもので、欠けていても
// ページや検索機能が出なくなることはない。したがって「警告を消すために値を作る」ことはせず、
// 実データで裏が取れているものだけを埋め、取れないものは空欄のまま残す。
//
// 【performer は入れない(4ページとも)】
//   schema.org の performer は「出演者(プレゼンター・音楽グループ・俳優など)」。
//   ポーカートーナメントに出演者に当たる実体が無い。参加者は事前に確定しておらず、
//   出演契約を結んだ演者でもない(そもそも当サイトは参加者名簿を持たない)。
//   主催団体を performer とみなす案も検討したが、schema.org は organizer を別に持っており、
//   主催者を「出演者」として宣言するのは意味が違う(Googleの表示上も出演者として扱われる)。
//   結局どう埋めても当サイトが作った値になる = Google に対する虚偽の構造化データになるため入れない。
//
// 【offers.availability / offers.validFrom は入れない】
//   availability(いま申し込めるか)と validFrom(受付開始日)は実行日に依存する主張で、
//   静的ページに焼き込むと会期後には必ず嘘になる。受付開始日は公表もされていない。
//   当リポジトリは生成物を実行日に依存させない方針(README「sitemap.xml の所有者」)でもある。
//   どちらも推奨項目なので、欠けたままにしておく。
//
// 【image】og:image と同じ画像を絶対URLで入れる(Googleは構造化データの相対URLを受け付けない)。
//   構造化データの画像に SVG は使えないため、SVG版のあるものも .jpg を指す。
const abs = p => `${SITE}/${String(p).replace(/^\//, '')}`;

// エントリー額の表記から Offer を作る。Offer.price は単一の数値なので、
// 【現金だけで完結する選択肢がちょうど1つに定まるときだけ】作る。
//   「¥12,000」                              → 12000
//   「2 Tickets + ¥8,000 or ¥80,000」        → 80000（現金のみの選択肢は ¥80,000 の1つ）
//   「¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚」→ 50000（同上）
//   「Qualifier（通過者のみ）」「¥40,000（+施設料 ¥5,000）」「5,000 + 1,000」→ 作らない
// 複数のエントリー方法が併記されている大会でも、当サイトが金額を計算・解釈して
// 作り出すことはしない(チケットは円に換算できない／内訳の解釈は公式に明記が無い)。
// 区切り文字にカンマを入れないこと。金額の桁区切り(¥10,000)を割ってしまう。
const YEN_ONLY = /^¥([\d,]+)$/;
const ENTRY_SPLIT = /\s*(?:／|\bor\b)\s*/;
function cashOffer(name, entry, url) {
  const cash = String(entry == null ? '' : entry).trim()
    .split(ENTRY_SPLIT)
    .map(s => s.trim())
    .filter(s => YEN_ONLY.test(s));
  if (cash.length !== 1) return null;   // 0=現金だけでは入れない / 2以上=金額が一意に決まらない
  const o = {
    '@type': 'Offer',
    name,
    price: YEN_ONLY.exec(cash[0])[1].replace(/,/g, ''),
    priceCurrency: 'JPY'
  };
  if (url) o.url = url;   // 「どこで申し込めるか」= 主催者の公式ページ。当サイトは受付を行わない
  return o;
}

// ---- スケジュール表(日別) ----
function schedTable(tournaments) {
  // 日ごとにグループ化(元データの順序を保持)
  const byDay = {};
  const order = [];
  tournaments.forEach(t => { if (!byDay[t.day]) { byDay[t.day] = []; order.push(t.day); } byDay[t.day].push(t); });
  order.sort();
  return order.map(day => {
    const f = fmtDate(day);
    const rows = byDay[day].map(t => {
      const no = t.no ? '#' + esc(t.no) : (t.name && /sit ?& ?go/i.test(t.name) ? 'SNG' : '—');
      const gtd = t.gtd ? `<span class="gtd">${esc(t.gtd)} GTD</span>` : '';
      const tags = (t.tags && t.tags.length) ? `　<span style="color:var(--mut);font-size:.9em">${t.tags.map(esc).join('・')}</span>` : '';
      return `<tr>
        <td class="no">${no}</td>
        <td class="start">${esc(t.start || '—')}</td>
        <td>${esc(t.name)}${gtd}${tags}</td>
        <td class="buyin">${esc(t.buyin || '—')}</td>
        <td class="buyin">${esc(t.stack || '—')}</td>
      </tr>`;
    }).join('\n');
    return `<h2 class="day">${f.m}月${f.d}日（${f.wd}）</h2>
<div class="sched-wrap"><table class="sched">
  <thead><tr><th>No.</th><th>開始</th><th>トーナメント</th><th>バイイン</th><th>スタック</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>`;
  }).join('\n');
}

// ---- JOPTページ ----
// JOPT 2026 Fukuoka #01 の結果(終了済み大会。数値は一次情報ではなく出典記事からの転記)。
// 値の実体は jopt-result-data.js に切り出してある(2026-08-28。tools/gen-ogp-images.js でも
// 同じ値を使うため。詳しい理由はそちらのファイル冒頭のコメントを参照)。
const JOPT_RESULT = require(path.join(REPO, 'jopt-result-data.js'));

function buildJopt() {
  const canonical = `${SITE}/events/jopt-2026-fukuoka-01/`;
  // OGP専用画像(1200x630。2026-08-28追加)。本文中のバナー(.evt-banner、1024x412)とは別物。
  const image = 'img/jopt/jopt-og.jpg';
  // ★ title/description微調整(2026-08-28)
  //   「会場」「賞金」を知りたい検索意図が強いと判断した一方、
  //   旧titleは59文字で「会場」ワードを含まず切れやすかった。「会場」をtitle冒頭30文字以内に足し、
  //   60文字以内に収める。descriptionも前方100文字以内で会場情報の露出を強化する。
  //   ★ここは文言の並べ替え・追記のみで、結果コンテンツ(JOPT_RESULT)自体は増やさない
  //   (WJPT・日本シリーズには結果調査を追加していないが、JOPTは既に結果コンテンツ追加済み)。
  const title = `JOPT 2026 Fukuoka #01 結果・会場（7/30〜8/2 福岡・大名）| ふくおかポーカーナビ`;
  const desc = `JOPT 2026 Fukuoka #01の結果・会場まとめ。会場は${JOPT.venue}（${JOPT.area}）、開催日は2026年7月30日〜8月2日。`
    + `Main Event優勝は${JOPT_RESULT.winner}（エントリー${JOPT_RESULT.totalEntries}／プライズ保証1,500万円）。全${JOPT.tournaments.length}トーナメントのタイムスケジュール・バイインも掲載。`;
  const descLd = `JOPT 2026 Fukuoka #01の結果・会場まとめ。会場は${JOPT.venue}（2026年7月30日〜8月2日・${JOPT.address || '福岡県福岡市中央区大名1-3-36'}）。`
    + `Main Event優勝は${JOPT_RESULT.winner}（エントリー${JOPT_RESULT.totalEntries}／プライズ保証1,500万円）。全${JOPT.tournaments.length}トーナメントのタイムスケジュール・バイイン・スタックも一覧掲載。`;
  // 各トーナメントのバイインを Offer にする(1トーナメント=1エントリー商品)。
  // 現金だけの金額が定まらないもの(サテライト通過者限定・Day2など)は落ちる。
  const offers = JOPT.tournaments
    .map(t => cashOffer(t.name, t.buyin, JOPT.guideUrl))
    .filter(Boolean);
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "JOPT 2026 Fukuoka #01",
    "image": abs(image),
    "startDate": "2026-07-30",
    "endDate": "2026-08-02",
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": JOPT.venue || "UNITEDLAB",
      "address": { "@type": "PostalAddress", "streetAddress": (JOPT.address || ""), "addressRegion": "福岡県", "addressLocality": "福岡市中央区", "addressCountry": "JP" }
    },
    "organizer": { "@type": "Organization", "name": "Japan Open Poker Tour", "url": "https://japanopenpoker.com/" },
    "offers": offers,
    "description": descLd,
    "url": canonical,
    "isAccessibleForFree": false
  };
  const body = `
${SITE_BANNER_SECTION.html}<h1>JOPT 2026 Fukuoka #01 結果・優勝者 ＆ タイムスケジュール</h1>
<p class="lead">Japan Open Poker Tour 2026 福岡 #01（2026年7月30日〜8月2日）の結果まとめと、全${JOPT.tournaments.length}トーナメントの日程</p>
<div class="archived"><b>このイベントは終了しました。</b>Main Event優勝は<b>${esc(JOPT_RESULT.winner)}</b>（エントリー${esc(JOPT_RESULT.totalEntries)}）でした。詳しい結果は下記「結果・優勝者」をご覧ください。以下は開催当時のタイムスケジュールの記録です。今後のトーナメントは<a href="/">トップページ</a>をご確認ください。</div>
<div class="evt-meta">
  <b>会期</b>　2026年7月30日（木）〜8月2日（日）<br>
  <b>会場</b>　${esc(JOPT.venue || 'UNITEDLAB')}（${esc(JOPT.address || '福岡県福岡市中央区大名1-3-36')}）<br>
  <b>メインイベント</b>　<span class="prize">プライズ保証 ¥15,000,000</span>
</div>
<h2 class="day">結果・優勝者（Main Event）</h2>
<div class="sched-wrap"><table class="sched">
  <tbody>
    <tr><th>優勝</th><td class="fst-prize">${esc(JOPT_RESULT.winner)}</td></tr>
    <tr><th>準優勝</th><td>${esc(JOPT_RESULT.runnerUp)}</td></tr>
    <tr><th>総エントリー数</th><td>${esc(JOPT_RESULT.totalEntries)}</td></tr>
    <tr><th>プライズ保証</th><td>¥15,000,000</td></tr>
  </tbody>
</table></div>
<p class="lead" style="margin-top:10px">${JOPT_RESULT.notable}</p>
<p class="lead" style="margin-top:-6px">出典：<a href="${esc(JOPT_RESULT.sourceUrl)}" target="_blank" rel="noopener">${esc(JOPT_RESULT.sourceLabel)}</a>${esc(JOPT_RESULT.sourceDate)}</p>
<a class="cta" href="/#jopt">▶ 各トーナメントのブラインドストラクチャーを見る／日付で絞り込む<small>インタラクティブ版(全ストラクチャー表つき)</small></a>
<p class="lead" style="margin:18px 0 -4px">以下は開催当時の全${JOPT.tournaments.length}トーナメントのタイムスケジュールの記録です。</p>
${schedTable(JOPT.tournaments)}
${pastSatelliteVenuesBlock(BIG.bigEventById('jopt'), 'JOPT 2026 Fukuoka #01')}
${venueScheduleBlock()}
${adCard()}
<div class="disclaimer">当サイトはJOPTの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載内容は2026年7月時点の公式情報にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。プライズ額は主催者発表で、JOPTではプライズは賞金ではなく選手契約として扱われます。参加前に必ず<a href="${esc(JOPT.guideUrl)}" target="_blank" rel="noopener">公式サイト</a>をご確認ください。<br>${POSITIONING}</div>

<div class="links">
  ▶ <a href="${esc(JOPT.guideUrl)}" target="_blank" rel="noopener">JOPT公式サイト</a>${JOPT.scheduleUrl ? `　／　<a href="${esc(JOPT.scheduleUrl)}" target="_blank" rel="noopener">公式スケジュール</a>` : ''}<br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld, image, extraCss: ADCARD_CSS + BANNER_CSS, breadcrumb: pageBreadcrumb('jopt', canonical) }) + body + pageFoot('/events/jopt-2026-fukuoka-01/');
}

// ---- WJPTページ(終了済み=アーカイブ) ----
function buildWjpt() {
  const canonical = `${SITE}/events/wjpt-2026/`;
  // OGP専用画像(1200x630。2026-08-28追加)。本文中のバナー(1024x412)とは別物。
  const image = 'img/wjpt/wjpt-og.jpg';
  const title = 'WJPT 2026（West Japan Poker Tour 7/18〜7/20 北九州）タイムスケジュール | ふくおかポーカーナビ';
  const desc = 'WJPT（West Japan Poker Tour）2026年7月18日〜20日・北九州で開催された全' + WJPT.tournaments.length + 'トーナメントのタイムスケジュール・バイイン・スタックの記録。';
  // ★ この大会は終了済み(アーカイブ)。
  //   - offers は入れない。エントリーはもう買えないので、価格を出すと「まだ申し込める」という
  //     誤ったシグナルになる(availability を入れない方針とも整合しない)。当時のバイインは
  //     本文の表に記録として残してある。
  //   - organizer も入れない。当サイトが持っている出典は第三者のテキスト共有サービス上に置かれた
  //     公式プレイヤーズガイドだけで、主催団体の名称・公式サイトを裏付ける材料がない。
  //     大会名(West Japan Poker Tour)をそのまま主催者として名乗らせることはしない。
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "WJPT 2026 (West Japan Poker Tour)",
    "image": abs(image),
    "startDate": "2026-07-18",
    "endDate": "2026-07-20",
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": { "@type": "Place", "name": "北九州", "address": { "@type": "PostalAddress", "addressRegion": "福岡県", "addressLocality": "北九州市", "addressCountry": "JP" } },
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  const body = `
${SITE_BANNER_SECTION.html}<h1>WJPT 2026 タイムスケジュール</h1>
<p class="lead">West Japan Poker Tour 2026（北九州）の全${WJPT.tournaments.length}トーナメント日程</p>
<div class="archived"><b>このイベントは終了しました。</b>以下は2026年7月18日〜20日に北九州で開催された当時の日程・内容の記録です。今後のトーナメントは<a href="/">トップページ</a>をご確認ください。</div>
<div class="evt-meta">
  <b>会期</b>　2026年7月18日（土）〜7月20日（月・祝）<br>
  <b>エリア</b>　${esc(WJPT.area || '北九州')}
</div>
<a class="cta" href="/#wjpt">▶ 各トーナメントの公式ストラクチャー画像を見る<small>インタラクティブ版(告知シート画像つき)</small></a>
${schedTable(WJPT.tournaments)}
${pastSatelliteVenuesBlock(BIG.bigEventById('wjpt'), 'WJPT 2026')}
${venueScheduleBlock()}
${adCard()}
<div class="disclaimer">当サイトはWJPTの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載内容は開催当時の公式情報にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。イベント終了後は内容を更新していません。掲載元: <a href="${esc(WJPT.guideUrl)}" target="_blank" rel="noopener">公式プレイヤーズガイド</a>（開催当時）。<br>${POSITIONING}</div>

<div class="links">
  ▶ <a href="/">福岡の今後のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld, image, extraCss: ADCARD_CSS + BANNER_CSS, breadcrumb: pageBreadcrumb('wjpt', canonical) }) + body + pageFoot('/events/wjpt-2026/');
}

// ---- NIPPON SERIES ページ ----
// 列がJOPT/WJPT(バイイン・スタック)と違う(Fee / Reg Close / Prize)ため専用の表を作る。
// Fee・Prize は公式表記のまま出す(「+ 1,000」の内訳や「保証」等の解釈を足さない)。
function schedTableNippon(events) {
  const byDay = {};
  const order = [];
  events.forEach(e => { if (!byDay[e.day]) { byDay[e.day] = []; order.push(e.day); } byDay[e.day].push(e); });
  order.sort();
  return order.map(day => {
    const f = fmtDate(day);
    const rows = byDay[day]
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(e => `      <tr>
        <td class="no">#${esc(e.no)}<br><span style="color:var(--mut);font-size:.85em">${esc(e.variant)}</span></td>
        <td class="start">${esc(e.start)}</td>
        <td>${esc(e.name)}</td>
        <td class="buyin">${esc(e.fee)}</td>
        <td class="buyin">${esc(e.regClose)}</td>
        <td>${esc(e.prize)}</td>
      </tr>`).join('\n');
    return `<h2 class="day">${f.m}月${f.d}日（${f.wd}）</h2>
<div class="sched-wrap"><table class="sched">
  <thead><tr><th>No.</th><th>開始</th><th>トーナメント</th><th>Fee</th><th>Reg Close</th><th>Prize</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>`;
  }).join('\n');
}

function buildNippon() {
  const canonical = `${SITE}/events/nippon-series-2026-fukuoka/`;
  // OGP専用画像(1200x630。2026-08-28追加)。本文中のバナー(.evt-banner、1024x412)とは別物。
  const image = 'img/nippon-series/nippon-series-og.jpg';
  // ★ title/description文言調整(2026-08-28)
  //   会期(8/11〜8/16)は既に終了しているのに、旧titleの「タイムスケジュール」表記が開催前提の
  //   ままで検索意図とズレていた。結果情報は追加しない方針(2026-08-28: WJPT・日本シリーズは
  //   大会結果調査を追加していない)。ここでの調整は文言のみ:
  //   ①「タイムスケジュール」を、結果を書かなくても成立する中立的な表記(「大会情報」)に変更
  //   ②検索クエリに含まれる和文「日本シリーズ」をtitleに追加
  //   ③66文字→60文字以内に短縮
  const title = 'NIPPON SERIES（日本シリーズ）福岡2026 大会情報（8/11〜8/16）| ふくおかポーカーナビ';
  const desc = `NIPPON SERIES FUKUOKA 2026（日本シリーズ／2026年8月11日〜16日・福岡 トヨタホールスカラエスパシオ）の大会情報。`
    + `全${NIPPON.eventCount}イベントのFee・登録締切・Prizeを一覧掲載。MAIN EVENT（#17）は Prize 5,000,000。`;
  // ★ offers は入れない。
  //   公式の Fee 表記は「5,000 + 1,000」の形で、内訳(何に対する +1,000 か)は公式に明記がない。
  //   Offer.price は単一の数値なので、5,000 と 6,000 のどちらを出すにしても当サイトが
  //   公式表記を解釈し直すことになる。本文でも「+ 1,000 を言い換えない」と明記している方針
  //   (README・ページ内の免責)と矛盾するため、正確に表せない以上は出さない。
  //
  // ★ organizer は大会シリーズ自身を Organization として入れる。
  //   url は当サイトが出典として持っている公式イベントページと同じドメイン(=公式サイト)を
  //   そこから導出する。運営法人の名称は当サイトの手元に無いので名乗らせない。
  const organizerUrl = new URL(NIPPON.siteUrl).origin + '/';
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": NIPPON.name,
    "image": abs(image),
    "startDate": NIPPON.days[0],
    "endDate": NIPPON.days[NIPPON.days.length - 1],
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": NIPPON.venue,
      "address": { "@type": "PostalAddress", "streetAddress": "渡辺通4-8-28 F.Tビル 地下2階", "addressRegion": "福岡県", "addressLocality": "福岡市中央区", "postalCode": "810-0004", "addressCountry": "JP" }
    },
    "organizer": { "@type": "Organization", "name": "NIPPON SERIES", "url": organizerUrl },
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  const body = `
${SITE_BANNER_SECTION.html}<h1>NIPPON SERIES FUKUOKA 2026 タイムスケジュール</h1>
<p class="lead">${esc(NIPPON.name)} の全${NIPPON.eventCount}イベント日程（#1〜#38）</p>
<div class="evt-meta">
  <b>会期</b>　2026年8月11日（火）〜8月16日（日）<br>
  <b>会場</b>　${esc(NIPPON.venue)}（${esc(NIPPON.address)}）<br>
  <b>アクセス</b>　${esc(NIPPON.access)}<br>
  <b>MAIN EVENT（#17）</b>　<span class="prize">Prize 5,000,000 ＋ inゼリー １年分</span>
</div>
<a class="cta" href="/#nippon">▶ 日付で絞り込んで見る<small>インタラクティブ版（日別タブ・各イベントの公式ストラクチャーへのリンクつき）</small></a>
${schedTableNippon(NIPPON.events)}
<p class="lead" style="margin-top:14px">※ MAIN EVENT（#17）は Day 1A〜Day 1D Last Chance と Day 2 &amp; FINAL に分かれているため、同じ番号が複数の日に登場します。ブラインドストラクチャーは公式の各トーナメントページをご確認ください。</p>
${pastSatelliteVenuesBlock(BIG.bigEventById('nippon'), 'NIPPON SERIES FUKUOKA 2026')}
${venueScheduleBlock()}
${adCard()}
<div class="disclaimer">当サイトはNIPPON SERIESの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載内容は<b>2026年7月29日時点</b>の公式情報にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。Fee・Prize は公式表記のまま掲載しており、「+ 1,000」の内訳は公式に明記がないため当サイトでは言い換えていません。参加前に必ず<a href="${esc(NIPPON.siteUrl)}" target="_blank" rel="noopener">公式イベントページ</a>をご確認ください。<br>${POSITIONING}</div>

<div class="links">
  ▶ <a href="${esc(NIPPON.siteUrl)}" target="_blank" rel="noopener">NIPPON SERIES 公式イベントページ</a>　／　<a href="${esc(NIPPON.guidePdfUrl)}" target="_blank" rel="noopener">公式Players Guide(PDF)</a><br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld, image, extraCss: ADCARD_CSS + BANNER_CSS, breadcrumb: pageBreadcrumb('nippon', canonical) }) + body + pageFoot('/events/nippon-series-2026-fukuoka/');
}

// ---- FST 5.0 ページ「よくある質問」(FAQ) ----
// ★ ここも推測を足さない原則は本文と同じ。断定できない項目(buy-in未発表・初心者/経験者向けの言及なし等)は
//   「店舗・大会により異なる」「公式発表をご確認ください」等でヘッジする(2026-08-27)。
// 見た目(<details>/<summary>)とFAQPage構造化データの生成ロジックは tools/site-shell.js の
// faqBlock()/FAQ_CSS に集約してある(2026-09-03、FST専用にハードコードされていたものを切り出し。
// トップページ(index.html)のFAQも同じ関数を使う。
// tools/gen-top-faq.js を参照)。このファイルには「FSTの質問配列を組み立てる」ことだけを残す。
// FST(index.html の const FST)を受け取って質問配列を組み立てる。
// aHtml … 画面表示用(リンクつき)。aText … FAQPage構造化データ用のプレーンテキスト(HTMLタグを持たない)。
function fstFaqItems(FST, main, champ) {
  const xLink = `<a href="${esc(FST.x)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>`;
  return [
    {
      q: 'アミューズメントポーカー大会に初めて参加します。当日の流れや注意点は？',
      aHtml: `一般的にアミューズメントポーカー店・大会は、現金を賭けるのではなく、エントリー時に受け取るチップ（店舗内でのみ有効なポイント）を使ってプレイし、そのチップを現金に換金することはできない仕組みで運営されています。これは風営法の規制を踏まえた、多くのアミューズメントポーカー店に共通する運営形態です。身分証の提示や年齢確認の要否、当日の受付手順などは<b>店舗・大会により異なる</b>ため、初参加の場合は事前に${xLink}等の公式情報で最新のルールをご確認ください。`,
      aText: '一般的にアミューズメントポーカー店・大会は、現金を賭けるのではなく、エントリー時に受け取るチップ(店舗内でのみ有効なポイント)を使ってプレイし、そのチップを現金に換金することはできない仕組みで運営されています。これは風営法の規制を踏まえた、多くのアミューズメントポーカー店に共通する運営形態です。身分証の提示や年齢確認の要否、当日の受付手順などは店舗・大会により異なるため、初参加の場合は事前に公式X(@fst_202408)等の公式情報で最新のルールをご確認ください。'
    },
    {
      q: 'buy-in（参加費）の目安は？',
      aHtml: `MAIN EVENT・CHAMPIONSHIPの概要のbuy-inは次のとおりです。<br>・MAIN EVENT：${esc(main.entry)}<br>・CHAMPIONSHIP：${esc(champ.entry)}<br>MAIN EVENT・CHAMPIONSHIPとも、各Day1フライト（Day1A〜E）のエントリーは、上記概要と同額であることを確認済みです。<br>上記以外の個別トーナメント（サイドイベント等）を含む全56トーナメントのbuy-inは、${esc(FST.asOf)}時点の公式スケジュールにもとづき<a href="#all-schedule">下記の全日程（タイムスケジュール）</a>に掲載済みです。最新情報は${xLink}等の公式発表もあわせてご確認ください。`,
      aText: `MAIN EVENT・CHAMPIONSHIPの概要のbuy-inは、MAIN EVENTが${main.entry}、CHAMPIONSHIPが${champ.entry}です。MAIN EVENT・CHAMPIONSHIPとも、各Day1フライト(Day1A〜E)のエントリーは上記概要と同額であることを確認済みです。上記以外の個別トーナメント(サイドイベント等)を含む全56トーナメントのbuy-inは、${FST.asOf}時点の公式スケジュールにもとづき本ページの全日程(タイムスケジュール)に掲載済みです。`
    },
    {
      q: '予約・エントリー方法は？',
      aHtml: `予約・エントリー方法は、公式SNS上で随時案内されています。参加を検討する場合は${xLink}・<a href="${esc(FST.instagram)}" target="_blank" rel="noopener">公式Instagram（@fst_fukuoka）</a>・<a href="${esc(FST.linktree)}" target="_blank" rel="noopener">公式Linktree</a>を確認のうえ、案内に沿ってお申し込みください。MAIN EVENT・CHAMPIONSHIPは現金のほか、県内各店で開催されるサテライト（チケット獲得トーナメント）で獲得できる「FSTチケット」でもエントリーできます（<a href="/#fst">サイト内のFSTサテライト情報</a>）。`,
      aText: '予約・エントリー方法は公式SNS(公式X @fst_202408、公式Instagram @fst_fukuoka、公式Linktree)で随時案内されています。参加を検討する場合はこれらの公式情報を確認のうえお申し込みください。MAIN EVENT・CHAMPIONSHIPは現金のほか、県内各店のサテライト(チケット獲得トーナメント)で獲得できるFSTチケットでもエントリーできます。'
    },
    {
      q: '初心者でも参加できますか？経験者向けの大会ですか？',
      aHtml: '該当する公式アナウンスは、当サイトでは確認できていません。一般的に大型のアミューズメントポーカートーナメントは経験者だけでなく初心者も参加できる形で運営されることが多く、参加のハードルを下げる仕組みとして県内各店でのサテライト（チケット獲得トーナメント）が用意されているのもその一例です。初参加で不安がある場合は、まず<a href="/">福岡県内の店舗トーナメント</a>で経験を積んでから大型大会に臨むのも一つの方法です。',
      aText: '初心者向け・経験者向けと明言している公式情報は確認できていません。一般的に大型のアミューズメントポーカートーナメントは経験者だけでなく初心者も参加できる形で運営されることが多く、参加のハードルを下げる仕組みとして県内各店でのサテライトが用意されているのもその一例です。初参加で不安がある場合は、まず福岡県内の店舗トーナメントで経験を積んでから大型大会に臨むのも一つの方法です。'
    }
  ];
}
function fstFaqBlock(FST, main, champ) {
  return faqBlock(fstFaqItems(FST, main, champ));
}

// ---- サテライト開催店舗カード(2026-08-27追加 / 2026-08-28で過去形にも対応) ----
// big-events.js の各大会エントリが持つ venueId のリストを店舗データと突き合わせてカードにする。
// ここでは venueId のリストを信じるだけで、判定ロジック自体は複製しない。
//   - FST(現在進行形)   … satelliteVenueIds を渡す。文言は「開催されています」の現在形
//   - WJPT/JOPT(終了済み)… pastSatelliteVenueIds を渡す。文言は「開催されていました」の過去形
//     (会期が終わった大会に「現在開催中」の現在形を使わないため。venue-schedule.js のコメントを参照)
function satelliteVenuesBlock(ids, opts) {
  if (!ids || !ids.length) return '';
  const venues = DATA.VENUES.filter(v => ids.indexOf(v.id) >= 0);
  return `
<h2 class="day">${esc(opts.heading)}</h2>
<p class="lead">${opts.lead(venues.length)}</p>
<div class="vp-cards">
${venues.map(v => `  <a class="vp-card" href="/venues/${v.slug}/">
    <div class="vp-card-name">${esc(v.name)}</div>
    <div class="vp-card-sub">${esc(v.area)}</div>
  </a>`).join('\n')}
</div>`;
}
// 終了済み大会(WJPT/JOPT)向けの過去形ラッパ。見出し・文言をここで固定し、
// buildWjpt()/buildJopt() 側では大会名とデータだけを渡す形にする(文言を2箇所に書かない)。
function pastSatelliteVenuesBlock(reg, eventLabel) {
  return satelliteVenuesBlock((reg && reg.pastSatelliteVenueIds) || [], {
    heading: 'サテライト開催店舗（開催実績）',
    lead: n => `下記の店舗では、${esc(eventLabel)}の開催期間にチケット獲得を目的としたサテライト（チケット獲得トーナメント）が開催されていました（当サイト掲載データより集計・${n}店舗。当時の記録です）。現在の開催状況は各店舗のページ・公式情報・SNSでご確認ください。`
  });
}

// ---- FST 5.0 全日程スケジュール表(日別) ----
// 出典・注意点は fst-schedule-data.js 冒頭のコメントを参照。列がJOPT/WJPT(バイイン・スタック)とも
// NIPPON SERIES(Fee/Reg Close/Prize)とも違う(No./START/CLOSE/エントリー)ため専用の表を作る。
// entry は number(円建て) / string(複合表記) / null(不明) の3種類を取りうる
// (fst-schedule-data.js 冒頭コメント参照)。
//   - number → fstMoney() で「¥●●●」表示。
//   - string → すでに「¥50,000 ／ …」のような完成した表記のため、円マーク等を二重に付けず
//     エスケープしてそのまま表示(MAIN EVENTの各Day1フライトが該当。確認・2026-09-01)。
//   - null   → PDF側で金額が数値ではなくアイコン/バッジ表記だった行。★推測で埋めず、
//     「PDF未記載」と分かる文言にする(index.html の fstScheduleCards() と同じ扱い。文言も揃えてある)。
function fstMoney(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }
const FST_ENTRY_UNKNOWN_HTML = '<span style="color:#8e1524">PDF未記載（本ページのMain Event/Championship概要をご確認ください）</span>';
function schedTableFst(tournaments) {
  const byDay = {};
  const order = [];
  tournaments.forEach(t => { if (!byDay[t.day]) { byDay[t.day] = []; order.push(t.day); } byDay[t.day].push(t); });
  order.sort();
  return order.map(day => {
    const f = fmtDate(day);
    const rows = byDay[day].map(t => {
      // series はPDFのTOURNAMENT列先頭に付いていた角カッコバッジ([EC]/[F100]/[XPT])をそのまま掲載。
      // 正式名称・詳細は公式に未確認のため、当サイトで意味を補って言い換えない(fst-schedule-data.js 注3)。
      const badge = t.series ? `<span style="color:#33409e;font-weight:700;font-size:.85em">[${esc(t.series)}]</span> ` : '';
      const entry = (t.entry === null) ? FST_ENTRY_UNKNOWN_HTML
        : esc(typeof t.entry === 'string' ? t.entry : fstMoney(t.entry));
      return `      <tr>
        <td class="no">${esc(t.no)}</td>
        <td class="start">${esc(t.start)}</td>
        <td>${badge}${esc(t.name)}</td>
        <td class="start">${esc(t.close)}</td>
        <td class="buyin">${entry}</td>
      </tr>`;
    }).join('\n');
    return `<h2 class="day">${f.m}月${f.d}日（${f.wd}）</h2>
<div class="sched-wrap"><table class="sched">
  <thead><tr><th>No.</th><th>START</th><th>トーナメント</th><th>CLOSE</th><th>エントリー</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>`;
  }).join('\n');
}

// ---- FST 5.0「Main House Day1」(店舗開催のMAIN EVENT Day1フライト) ----
// ★これはサテライト(チケット獲得トーナメント)ではない。venueId が null の行(候補が複数あり
//   断定できないもの)は店舗ページへリンクしない(index.html の const FST_MAIN_HOUSE_DAY1 直前の
//   コメント・fst-main-house-day1-2026-09-01.json の _important_distinction を参照)。
function mainHouseDay1Table(mh) {
  const rows = mh.days.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
  const trs = rows.map(r => {
    const f = fmtDate(r.date);
    let house;
    if (r.venueId) {
      const v = DATA.VENUES.find(x => x.id === r.venueId);
      const suffix = r.confidence === 'medium' ? '・店舗名要確認' : '';
      house = v ? `<a href="/venues/${esc(v.slug)}/">${esc(r.houseName)}</a>（${esc(v.name)}${suffix}）` : esc(r.houseName);
    } else {
      house = `${esc(r.houseName)}<span style="color:#8e1524">（店舗未確定）</span>`;
    }
    return `      <tr>
        <td class="start">${f.m}/${f.d}（${f.wd}）</td>
        <td class="start">${esc(r.start)}〜${esc(r.close)}</td>
        <td>${house}</td>
      </tr>`;
  }).join('\n');
  return `<div class="sched-wrap"><table class="sched">
  <thead><tr><th>日付</th><th>時間</th><th>開催店舗（Main House）</th></tr></thead>
  <tbody>
${trs}
  </tbody>
</table></div>`;
}
function mainHouseDay1Block(mh) {
  if (!mh || !Array.isArray(mh.days) || !mh.days.length) return '';
  return `
<h2 class="day">店舗開催のMain Event Day1（Main House）</h2>
<p class="lead">メイン会場とは別に、県内一部店舗でMAIN EVENTのDay1フライトが開催されます。<b>チケット獲得を目的としたサテライトではなく、MAIN EVENT本戦のDay1フライトそのもの</b>です。ここで獲得したスタックはメイン会場のDay2（9/21 13:00開始）に引き継がれます。出典は主催者公式Linktreeに掲載の画像「FST Main House Day1」（${esc(mh.asOf)}時点）。</p>
${mainHouseDay1Table(mh)}
<div class="evt-meta">${mh.footerNotes.map(esc).join('<br>')}</div>`;
}

// ---- FST 5.0 ページ ----
// 会期・会場・発表済みの2大会(MAIN EVENT / CHAMPIONSHIP)の概要に加え、メイン会場の全日程表(上記
// schedTableFst)を掲載する。個別トーナメントのブラインドストラクチャーは引き続き未発表。
// ★ ここに推測を足さないこと。概要の値は index.html の const FST、全日程は fst-schedule-data.js
//   (いずれも一次情報で裏取り済み)からそのまま取る。
function buildFst() {
  const canonical = `${SITE}/events/fst-2026-fukuoka/`;
  // OGP専用画像(1200x630。2026-08-28追加)。本文中のバナー(SVG、1024x412)とは別物。
  const image = 'img/fst/fst-og.jpg';
  const reg = BIG.bigEventById('fst');
  const first = BIG.eventFirstDay(FST.days), last = BIG.eventLastDay(FST.days);
  const f1 = fmtDate(first), f2 = fmtDate(last);
  const main = FST.events[0];
  const title = `FST 5.0（FUKUOKA SUPER TOURNAMENT）2026 福岡 全日程（${f1.m}/${f1.d}〜${f2.m}/${f2.d} ホテルニューオータニ博多）| ふくおかポーカーナビ`;
  const desc = `FST 5.0（FUKUOKA SUPER TOURNAMENT／2026年${f1.m}月${f1.d}日〜${f2.m}月${f2.d}日・ホテルニューオータニ博多）の開催概要と全日程。`
    + `MAIN EVENT は Prize Total ${main.prize}、CHAMPIONSHIP は Prize Total ${FST.events[1].prize}。メイン会場で行われる全${FST_SCHEDULE.tournaments.length}トーナメントのタイムスケジュールを掲載。`;
  // entry は「¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚」の形。
  // 現金のみで入れる額だけを Offer にする(申込先の案内は公式X。この大会は公式サイトを持たない)。
  const offers = FST.events
    .map(e => cashOffer(e.name, e.entry, FST.x))
    .filter(Boolean);
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "FST 5.0 (FUKUOKA SUPER TOURNAMENT)",
    "image": abs(image),
    "startDate": first,
    "endDate": last,
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": "ホテルニューオータニ博多",
      "address": { "@type": "PostalAddress", "streetAddress": "渡辺通1-1-2", "addressRegion": "福岡県", "addressLocality": "福岡市中央区", "postalCode": "810-0004", "addressCountry": "JP" }
    },
    "organizer": { "@type": "Organization", "name": FST.organizer, "url": FST.x },
    "offers": offers,
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  // 発表済みの2大会。1大会=1テーブルの「項目 / 内容」形式にする。
  // JOPT・NIPPON のような横並びの表にすると、エントリー欄(「¥50,000 ／ FSTチケット2枚 ／ …」)が
  // 狭い画面で数文字ごとに折り返して読めなくなるため(375pxで実測)。
  const tables = FST.events.map(e => `<h2 class="day">${esc(e.name)}</h2>
<div class="sched-wrap"><table class="sched">
  <tbody>
    <tr><th>Prize Total</th><td class="fst-prize">${esc(e.prize)}</td></tr>
    <tr><th>エントリー</th><td>${esc(e.entry)}</td></tr>
${e.itm ? `    <tr><th>インマネ</th><td>${esc(e.itm)}</td></tr>\n` : ''}${e.sched.map(([k, v]) => `    <tr><th>${esc(k)}</th><td class="start">${esc(v)}</td></tr>`).join('\n')}
  </tbody>
</table></div>`).join('\n');
  // よくある質問(FAQ)。開催前で検索意欲が高まる時期(9/19〜9/23開催・掲載時点で開催前)に、
  // 検索から来た人が知りたいこと(参加の流れ・buy-in目安・予約方法・初心者可否)にその場で答える。
  const faq = fstFaqBlock(FST, main, FST.events[1]);
  // ★venueScheduleBlock() より下(全56トーナメントの日程表)は、店舗・エリアへの内部リンクを
  //   上に出したあとに続く。
  // 【並び順を変更した理由・2026-09-07】回遊が薄いことが分かったため、店舗・エリアへの内部リンクを
  //   全日程表より前に配置した。この並び替えはFST固有の対応とする(他3大会のbuildXxx()は変更していない)。
  // ★このコメントは function 定義の外側(JS の // コメント)に置くこと。以前 <!-- --> の
  //   HTMLコメントとしてbody(テンプレートリテラル)の中に書いていたため、生成後の公開ページ
  //   (events/fst-2026-fukuoka/index.html)のHTMLソースにそのまま出力されていた(2026-09-26是正)。
  const body = `
${SITE_BANNER_SECTION.html}<h1>FST 5.0（FUKUOKA SUPER TOURNAMENT）2026 福岡 開催概要</h1>
<p class="lead">2026年${f1.m}月${f1.d}日（${f1.wd}）〜${f2.m}月${f2.d}日（${f2.wd}）／ホテルニューオータニ博多（福岡市中央区渡辺通）</p>
<img class="evt-banner" src="/${esc(FST.banner)}" width="1024" height="412" alt="${esc(reg && reg.bannerAlt ? reg.bannerAlt : FST.name)}">
<div class="evt-meta">
  <b>大会名</b>　${esc(FST.edition)}（FUKUOKA SUPER TOURNAMENT）<br>
  <b>会期</b>　2026年9月19日（土）・20日（日）・21日（月）・22日（火）・23日（水）の5日間<br>
  <b>会場</b>　${esc(FST.venue)}<br>
  <b>住所</b>　${esc(FST.address)}<br>
  <b>主催</b>　${esc(FST.organizer)}<br>
  <b>MAIN EVENT</b>　<span class="prize">Prize Total ${esc(main.prize)}</span>
</div>
<p class="lead" style="margin-top:-6px">※ 公式では「FST5.0」（スペースなし）とも表記されます。</p>
<div class="tba"><b>${esc(FST.asOf)}時点で、メイン会場の全日程（タイムスケジュール）が判明しました。</b>ブラインドストラクチャー等の詳細は引き続き公式から発表されていません。下表は現時点で公表されている MAIN EVENT と CHAMPIONSHIP の概要です。</div>
<a class="cta" href="/#fst">▶ サイト内のFSTサテライト（チケット獲得トーナメント）を見る<small>インタラクティブ版（日付・店舗つきで直近の開催予定を表示）</small></a>
${tables}
<p class="lead" style="margin-top:14px">※ エントリー方法の「FSTチケット」は、県内各店で開催されるサテライトで獲得できるチケットを指します。サテライトの開催予定は<a href="/#fst">トップページのFSTページ</a>に掲載しています。</p>
${mainHouseDay1Block(FST_MAIN_HOUSE_DAY1)}
${satelliteVenuesBlock((reg && reg.satelliteVenueIds) || [], {
  heading: 'サテライト開催店舗',
  lead: n => `下記の店舗では、FSTチケット（獲得するとMAIN EVENT・CHAMPIONSHIPにエントリーできます）が懸かったサテライト（チケット獲得トーナメント）が開催されています（当サイト掲載データより集計・${n}店舗）。日程・詳細は各店舗のページでご確認ください。`
})}
${venueScheduleBlock()}
<h2 class="day" id="all-schedule">全日程（タイムスケジュール）</h2>
<p class="lead">メイン会場（${esc(FST.venue)}）で行われる全${FST_SCHEDULE.tournaments.length}トーナメントのSTART・CLOSE・エントリーです。出典: 主催者公式Linktreeに掲載のPDF「EVENT SCHEDULE 2026.09.19-23」（${esc(FST.asOf)}時点）。エントリー欄が「PDF未記載」の行は、PDF側でエントリー欄が数値ではなくアイコン/バッジ表記になっており、当サイトで金額を読み取れなかった行です（推測で埋めていません）。CLOSE欄が「-」の回はレイトレジ無し（最後まで続行）です。［EC］［F100］［XPT］は公式PDFのTOURNAMENT列に付いていたバッジ表記をそのまま掲載しており、正式名称・詳細は当サイトでは確認できていません。</p>
${schedTableFst(FST_SCHEDULE.tournaments)}
${faq.html}
${adCard()}
<div class="disclaimer">当サイトはFSTの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載しているバナーは当サイトが作成したもので、ロゴ・大会名等の権利は主催者に帰属します。掲載内容は<b>${esc(FST.asOf)}時点</b>の公式告知にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。発表済みの内容も変更される場合があります。参加前に必ず<a href="${esc(FST.x)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>等の公式情報をご確認ください。<br>${POSITIONING}</div>

<div class="links">
  ▶ <a href="${esc(FST.x)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>　／　<a href="${esc(FST.linktree)}" target="_blank" rel="noopener">公式Linktree</a>　／　<a href="${esc(FST.instagram)}" target="_blank" rel="noopener">公式Instagram</a><br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>
${faq.script}`;
  return pageHead({ title, desc, canonical, jsonld, image, extraCss: FAQ_CSS + ADCARD_CSS + BANNER_CSS, breadcrumb: pageBreadcrumb('fst', canonical) }) + body + pageFoot('/events/fst-2026-fukuoka/');
}

// ---- SPADIE FUKUOKA 1st ページ ----
// 2026-11-12(開催初日)に公式Players Guide(Webアプリ)で全トーナメントが判明したため、
// WJPT/JOPTと同じく【日程ごとに各トーナメントの詳細】(開始・締切・参加費・スタック・プライズ・
// ストラクチャー)を載せる形に作り替えた。値は spadie-data.js(出典・転記方針はファイル冒頭)からそのまま取る。
// ★大型大会の恒久ルール(README「大型大会ページの書き方」): 日程が出ていれば日別に全トーナメントの詳細を、
//   出ていなければ「未発表」であることを日別に明記する。
const SPADIE = require(path.join(REPO, 'spadie-data.js'));
const SPADIE_X = SPADIE.x;
// 情報取得基準日。disclaimer・tba・FAQの全箇所からここを参照する(公式の更新を反映したら当日の日付に直すこと)。
const SPADIE_AS_OF = SPADIE.asOf;
// 公式シートの仮レート(円/$)で円換算した目安。シートの注記どおり確定額ではないので「約」「仮レート換算」を必ず付ける。
function spadieYen(usd) {
  const n = Number(String(usd).replace(/[$,]/g, ''));
  if (!isFinite(n)) return '';
  const man = Math.round(n * SPADIE.fxTemp / 10000);
  return `約${man.toLocaleString('ja-JP')}万円`;
}
// 「この Lv から何分」の並び → 「20分」「Lv.1〜10は20分、Lv.11以降は15分」
function spadieMinutesText(st) {
  const ms = st.minutes;
  if (ms.length === 1) return `${ms[0][1]}分`;
  return ms.map(([from, min], i) => {
    const next = ms[i + 1];
    return next ? `Lv.${from}〜${next[0] - 1}は${min}分` : `Lv.${from}以降は${min}分`;
  }).join('、');
}
function spadieMinutesAt(st, lv) {
  let min = st.minutes[0][1];
  st.minutes.forEach(([from, m]) => { if (lv >= from) min = m; });
  return min;
}
function spadieStructureTable(st) {
  const ladder = SPADIE.ladders[st.ladder];
  const rows = ladder.map((b, i) => {
    const lv = st.firstLevel + i;
    const [sb, bb] = b.split('-');
    const brk = st.breaksAfter.includes(lv) ? '<br><small>この後ブレイク</small>' : '';
    return `      <tr><td class="no">${lv}</td><td class="start">${esc(sb)} - ${esc(bb)}</td>${st.ante ? `<td class="start">${esc(bb)}</td>` : ''}<td>${spadieMinutesAt(st, lv)}分${brk}</td></tr>`;
  }).join('\n');
  return `<div class="sched-wrap"><table class="sched">
    <thead><tr><th>Lv</th><th>ブラインド</th>${st.ante ? '<th>BBアンティ</th>' : ''}<th>時間</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>`;
}
const spadieTitle = t => `#${t.no} ${t.name}${t.flight ? ` ${t.flight}` : ''}`;
const spadieEventOf = t => SPADIE.events.find(e => e.no === t.no);
// 「翌02:00」のような表記を、実際の日付(その夜が始まる日の翌日)つきの文に直す。
function spadieWhen(t) {
  const f = fmtDate(t.day);
  const base = `${f.m}月${f.d}日（${f.wd}）`;
  if (!/^翌/.test(t.start)) return `${base}${t.start}`;
  const [y, mo, d] = t.day.split('-').map(Number);
  const nx = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${base}の深夜 ${t.start}（${nx.getUTCMonth() + 1}/${nx.getUTCDate()} ${t.start.replace('翌', '')}）`;
}
// JSON-LD用の開始日時(+09:00)
function spadieStartIso(t) {
  const [y, mo, d] = t.day.split('-').map(Number);
  const late = /^翌/.test(t.start);
  const dt = new Date(Date.UTC(y, mo - 1, d + (late ? 1 : 0)));
  const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return `${ds}T${t.start.replace('翌', '')}:00+09:00`;
}
function spadiePrizeHtml(p) {
  return p.seat
    ? `${esc(p.seat)}<br><small>通過枠: ${esc(p.itm)}</small>`
    : `Prize Total ${esc(p.total)}<br><small>${spadieYen(p.total)}（仮レート${SPADIE.fxTemp}円/$で当サイト換算）</small>${p.gtd ? `<br><small>${esc(p.gtd)}</small>` : ''}<br><small>入賞: ${esc(p.itm)}まで</small>`;
}
function spadieRegText(t) {
  return [t.regOpen ? `受付開始 ${esc(t.regOpen)}` : '', t.regClose ? `締切 ${esc(t.regClose)}${t.closeLv ? `（Lv.${t.closeLv}終了時）` : ''}` : ''].filter(Boolean).join('<br>') || '—';
}
function spadieStructSummary(st) {
  const ladder = SPADIE.ladders[st.ladder];
  const lastLv = st.firstLevel + ladder.length - 1;
  const brk = st.breaksAfter.length ? `Lv.${st.breaksAfter.join('・')}の後` : 'シート上の記載なし';
  return `Lv.${st.firstLevel}〜${lastLv}（${ladder.length}レベル）／${spadieMinutesText(st)}／${st.ante ? 'BBアンティあり' : 'アンティなし'}<br><small>ブレイク: ${brk}</small>`;
}
const SPADIE_CSS = `
  .sp-daynav{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 14px;padding:0;list-style:none}
  .sp-daynav a{display:inline-block;padding:6px 12px;border:1px solid var(--bor);border-radius:16px;font-size:.88em;font-weight:700;text-decoration:none;background:var(--sur)}
  h2.day{scroll-margin-top:70px}
  ul.sp-list{list-style:none;padding:0;margin:0 0 8px;border:1px solid var(--bor);border-radius:var(--r);overflow:hidden;background:var(--sur);box-shadow:var(--sha)}
  ul.sp-list li+li{border-top:1px solid var(--bor)}
  ul.sp-list a{display:flex;align-items:center;gap:10px;padding:11px 12px;text-decoration:none;color:var(--txt)}
  ul.sp-list a:active{background:#eef3f1}
  .sp-time{flex:0 0 auto;min-width:3.6em;font-family:"IBM Plex Mono",monospace;font-weight:700;font-variant-numeric:tabular-nums;font-size:.92em}
  .sp-body{flex:1 1 auto;min-width:0}
  .sp-name{display:block;font-weight:800;font-size:.92em;line-height:1.35}
  .sp-sub{display:block;font-size:.78em;color:var(--mut);margin-top:2px}
  .sp-go{flex:0 0 auto;font-size:.78em;font-weight:800;color:var(--gold-ink);white-space:nowrap}
  a.sp-back{display:inline-block;margin:4px 0 10px;padding:7px 12px;border:1px solid var(--bor);border-radius:16px;font-size:.86em;font-weight:800;text-decoration:none;background:var(--sur)}
  .sp-pn{display:flex;gap:8px;margin:16px 0 8px}
  .sp-pn a,.sp-pn span{flex:1 1 0;display:block;padding:10px 11px;border:1px solid var(--bor);border-radius:var(--r);background:var(--sur);text-decoration:none;font-size:.8em;line-height:1.4;color:var(--txt);min-width:0}
  .sp-pn span{visibility:hidden}
  .sp-pn small{display:block;color:var(--mut);font-weight:700}
  .sp-pn .nx{text-align:right}
`;
// 全日程ページの日別リスト。1行まるごとが個別ページへのリンク(どこを押せばいいか迷わせない)。
function spadieDaySections() {
  const byDay = {};
  SPADIE.tournaments.forEach(t => { (byDay[t.day] = byDay[t.day] || []).push(t); });
  return SPADIE.days.map(day => {
    const f = fmtDate(day);
    const list = byDay[day] || [];
    const lis = list.map(t => {
      const ev = spadieEventOf(t);
      const anchor = t.flight ? '#' + t.flight.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
      const sub = [t.entry, t.stack !== '—' ? `スタック ${t.stack}` : '', t.prize && t.prize.total ? `Prize ${t.prize.total}` : ''].filter(Boolean).join('／');
      return `  <li><a href="${esc(ev.path + anchor)}"><span class="sp-time">${esc(t.start)}</span><span class="sp-body"><span class="sp-name">#${esc(t.no)} ${esc(t.name)}${t.flight ? `（${esc(t.flight)}）` : ''}</span><span class="sp-sub">${esc(sub)}</span></span><span class="sp-go">詳細 ›</span></a></li>`;
    }).join('\n');
    return `<h2 class="day" id="day-${day}">${f.m}月${f.d}日（${f.wd}）（${list.length}件）</h2>
<ul class="sp-list">
${lis}
</ul>`;
  }).join('\n');
}
function spadieFaqItems() {
  const xLink = `<a href="${esc(SPADIE_X)}" target="_blank" rel="noopener">公式X（@SPADIE_FUKUOKA）</a>`;
  const n = SPADIE.tournaments.filter(t => !t.flight || t.flight === 'Day 1A').length;
  return [
    {
      q: 'SPADIE FUKUOKA 1stはいつ・どこで開催されますか？',
      aHtml: `2026年11月12日（木）〜15日（日）の4日間、福岡市中央区大名のUNITEDLAB（〒810-0041 福岡県福岡市中央区大名1-3-36）で開催されます（公式Players Guideより）。`,
      aText: '2026年11月12日(木)〜15日(日)の4日間、福岡市中央区大名のUNITEDLAB(〒810-0041 福岡県福岡市中央区大名1-3-36)で開催されます(公式Players Guideより)。'
    },
    {
      q: 'どんなトーナメントがありますか？',
      aHtml: `メインイベント（#01 NLH Main Event）を含む全${n}イベントが予定されています。参加費は¥5,000〜¥150,000で、NLHのほかPLO、FL 2-7 Triple Draw & Badugi、2人1組のタッグ戦、3人1組のチーム戦、レディース戦、サテライトもあります。日程ごとの一覧から各トーナメントの専用ページに移動できます。`,
      aText: `メインイベント(#01 NLH Main Event)を含む全${n}イベントが予定されています。参加費は5,000円〜150,000円で、NLHのほかPLO、FL 2-7 Triple Draw & Badugi、タッグ戦、チーム戦、レディース戦、サテライトもあります。`
    },
    {
      q: 'メインイベントの参加方法・プライズは？',
      aHtml: `参加費は「SPADIEチケット2枚＋¥5,000」です。Day 1はA（11/12 18:00）・B（11/13 13:00）・C（11/14 11:00）・D Turbo（11/14 17:00）の4フライトで、Day 2は11/15 11:00再開です。プライズは公式トーナメントリストで「1000万GTD」（公式シートではPrize Total $61,278.21・仮レート163.19円/$）と案内され、80位までが入賞です。プライズは賞金ではなく選手契約（委託料）として扱われます。`,
      aText: '参加費は「SPADIEチケット2枚＋5,000円」です。Day 1は4フライト(A:11/12 18:00、B:11/13 13:00、C:11/14 11:00、D Turbo:11/14 17:00)、Day 2は11/15 11:00再開です。プライズは1000万円保証(Prize Total $61,278.21・仮レート163.19円/$)で80位までが入賞。プライズは賞金ではなく選手契約(委託料)として扱われます。'
    },
    {
      q: 'ドリンク代はかかりますか？',
      aHtml: 'ほとんどのトーナメントでファーストエントリー時に別途ドリンク代1,000円がかかります（タッグ戦はエントリーごとに2,000円、チーム戦は3,000円、Supernovaはドリンク飲み放題でドリンク代の記載なし）。各トーナメントの「備考」欄に公式シートの記載をまとめています。',
      aText: 'ほとんどのトーナメントでファーストエントリー時に別途ドリンク代1,000円がかかります(タッグ戦はエントリーごとに2,000円、チーム戦は3,000円)。'
    },
    {
      q: '初めてアミューズメントポーカー大会に参加します。当日の流れや注意点は？',
      aHtml: `一般的にアミューズメントポーカー店・大会は、現金を賭けるのではなく、エントリー時に受け取るチップ（店舗内でのみ有効なポイント）を使ってプレイし、そのチップを現金に換金することはできない仕組みで運営されています。身分証の提示や年齢確認の要否、当日の受付手順などは大会により異なるため、初参加の場合は事前に${xLink}や<a href="${esc(SPADIE.guideUrl)}" target="_blank" rel="noopener">公式Players Guide</a>で最新のルールをご確認ください。`,
      aText: '一般的にアミューズメントポーカー店・大会は、現金を賭けるのではなく、エントリー時に受け取るチップ(店舗内でのみ有効なポイント)を使ってプレイし、そのチップを現金に換金することはできない仕組みで運営されています。初参加の場合は事前に公式X(@SPADIE_FUKUOKA)や公式Players Guideで最新のルールをご確認ください。'
    }
  ];
}

function buildSpadie() {
  const canonical = `${SITE}/events/spadie-fukuoka-1st/`;
  // OGP専用画像(1200x630)。本文中のバナー(SVG、1024x412)とは別物(他イベントと同じ作法)。
  const image = 'img/spadie/spadie-og.jpg';
  const reg = BIG.bigEventById('spadie');
  const first = BIG.eventFirstDay(SPADIE.days), last = BIG.eventLastDay(SPADIE.days);
  const nEvents = SPADIE.tournaments.filter(t => !t.flight || t.flight === 'Day 1A').length;
  // ★固有語(「SPADIE FUKUOKA 1st」)を先頭に据え、一般語(「福岡 ポーカー トーナメント」)を単独で
  //   強く打ち出さない方針は従来どおり(FSTページが一般語検索でトップと競合した問題を踏まえたもの)。
  const title = 'SPADIE FUKUOKA 1st 全日程・タイムスケジュール（11/12〜15 福岡・大名 UNITEDLAB）| ふくおかポーカーナビ';
  const desc = `SPADIE FUKUOKA 1st（2026年11月12日〜15日・福岡・大名 UNITEDLAB）の全${nEvents}イベントを日程ごとに掲載。`
    + '各トーナメントの開始時刻・受付締切・参加費・スタック・プライズ・ストラクチャーを公式Players Guideからまとめています。';
  // 現金だけで入れるトーナメントを Offer にする(メインイベント=チケット制などは落ちる)。
  const seen = new Set();
  const offers = SPADIE.tournaments
    .filter(t => !t.flight && !seen.has(t.no) && seen.add(t.no))
    .map(t => cashOffer(spadieTitle(t), t.entry.replace(/（.*?）/g, ''), SPADIE.scheduleUrl))
    .filter(Boolean);
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "SPADIE FUKUOKA 1st",
    "image": abs(image),
    "startDate": first,
    "endDate": last,
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": "UNITEDLAB",
      "address": { "@type": "PostalAddress", "streetAddress": "大名1-3-36", "addressRegion": "福岡県", "addressLocality": "福岡市中央区", "postalCode": "810-0041", "addressCountry": "JP" }
    },
    "offers": offers,
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  // 個別ページの一覧(ItemList)。親ページから各トーナメントページへの関係を検索エンジンに伝える。
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "SPADIE FUKUOKA 1st トーナメント一覧",
    "itemListElement": SPADIE.events.map((e, i) => ({ "@type": "ListItem", "position": i + 1, "name": `#${e.no} ${e.name}`, "url": SITE + e.path }))
  };
  const faq = faqBlock(spadieFaqItems(), { headingId: 'spadie-faq' });
  const dayNav = SPADIE.days.map(d => { const f = fmtDate(d); return `<li><a href="#day-${d}">${f.m}/${f.d}（${f.wd}）</a></li>`; }).join('');
  const body = `
${SITE_BANNER_SECTION.html}<h1>SPADIE FUKUOKA 1st 全日程（2026年11月12日〜15日・UNITEDLAB）</h1>
<p class="lead">会期: 2026年11月12日（木）〜15日（日）／会場: UNITEDLAB（福岡市中央区大名）／全${nEvents}イベント</p>
<img class="evt-banner" src="/${esc(reg.banner)}" width="1024" height="412" alt="${esc(reg.bannerAlt)}">
<div class="evt-meta">
  <b>大会名</b>　SPADIE FUKUOKA 1st<br>
  <b>会期</b>　2026年11月12日（木）・13日（金）・14日（土）・15日（日）の4日間<br>
  <b>会場</b>　UNITEDLAB（ユナイテッドラボ）<br>
  <b>住所</b>　〒810-0041 福岡県福岡市中央区大名1-3-36<br>
  <b>アクセス</b>　地下鉄空港線 天神駅から徒歩約10分／西鉄福岡（天神）駅から徒歩約11分<br>
  <b>メインイベント</b>　<span class="prize">1,000万円保証</span>（参加費: SPADIEチケット2枚＋¥5,000）
</div>
<div class="tba"><b>${SPADIE_AS_OF}時点の公式Players Guideにもとづき、全${nEvents}イベントを日程ごとに掲載しています。</b>トーナメントの行をタップすると、そのトーナメントの専用ページ（開始・受付締切・終了予定・参加費・スタック・プライズ・全レベルのストラクチャー）に移動します。プライズは公式表記の米ドルで、円の目安は公式シートの仮レート（${SPADIE.fxTemp}円/$）で当サイトが換算したものです（確定額は実施日3日前に発表される固定レートで再計算されます）。深夜開始の大会は、その夜が始まる日の枠に「翌0:00」のように載せています。</div>
<ul class="sp-daynav">${dayNav}</ul>
${spadieDaySections()}
<p class="lead" style="margin-top:14px">※ #34 NLH Employees（11/15 19:00）は本大会の勤務者限定のため掲載していません。プライズは賞金ではなく、対象ポーカートーナメントへの参加補助が受けられる任意の選手契約（委託料）です。ルールはJOPT Official Ruleが採用されています。</p>
<h2 class="day">SPADIEシリーズとは</h2>
<p class="lead">SPADIEは、一般社団法人日本ポーカー連盟が主催すると案内されているアミューズメントポーカーの大型トーナメントシリーズです。これまで東京で開催され、2026年6月に大阪へ拡大（SPADIE OSAKA）、そして今回2026年11月に福岡・大名のUNITEDLABで「SPADIE FUKUOKA 1st」として開催されます。主催者・関連媒体は本大会を「SPADIEシリーズ初の九州開催」と位置づけています。会場のUNITEDLABでは、2026年7月30日〜8月2日に<a href="/events/jopt-2026-fukuoka-01/">JOPT 2026 Fukuoka #01</a>（Main Event ${esc(JOPT_RESULT.totalEntries)}エントリー）も開催されました。</p>
${faq.html}
${venueScheduleBlock()}
${adCard()}
<div class="disclaimer">当サイトはSPADIE FUKUOKA 1stの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載しているバナーは当サイトが作成したもので、ロゴ・大会名等の権利は主催者に帰属します。掲載内容は<b>${SPADIE_AS_OF}時点</b>の公式Players Guide（画像で公開されているシートを当サイトが転記）にもとづきますが、転記の誤りが含まれる可能性があります。発表済みの内容も変更される場合があります。参加前に必ず<a href="${esc(SPADIE.guideUrl)}" target="_blank" rel="noopener">公式Players Guide</a>・<a href="${esc(SPADIE_X)}" target="_blank" rel="noopener">公式X（@SPADIE_FUKUOKA）</a>をご確認ください。<br>${POSITIONING}</div>

<div class="links">
  ▶ <a href="${esc(SPADIE.scheduleUrl)}" target="_blank" rel="noopener">公式トーナメントリスト</a>　／　<a href="${esc(SPADIE_X)}" target="_blank" rel="noopener">公式X（@SPADIE_FUKUOKA）</a><br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>
${faq.script}`;
  return pageHead({ title, desc, canonical, jsonld: [jsonld, itemList], image, extraCss: FAQ_CSS + ADCARD_CSS + BANNER_CSS + SPADIE_CSS, breadcrumb: pageBreadcrumb('spadie', canonical) }) + body + pageFoot('/events/spadie-fukuoka-1st/');
}


// ---- SPADIE トーナメント個別ページ(/events/spadie-fukuoka-1st/<slug>/。2026-11-12) ----
// 全日程ページに39件の詳細を縦に並べると「どこを押せばいいか分からない」「上に戻るのが大変」だったため
// (運営指摘)、1トーナメント=1ページに分けた。全日程ページの各行はここへの行リンク。
// SEO: 「SPADIE FUKUOKA <トーナメント名>」「<トーナメント名> ストラクチャー」等の個別検索を受けるため、
//   title/description/H1 にトーナメント名・日時・参加費・プライズを入れ、Event構造化データ
//   (superEvent=SPADIE FUKUOKA 1st)とパンくず(4階層)を持たせる。sitemap.xml にも載せる(gen-sitemap.js)。
function spadieStructureBlocks(ev) {
  // 同じストラクチャーのフライトは1つの表にまとめる(Main Event の Day 1A〜1C 等)。
  const groups = [];
  ev.flights.forEach(t => {
    const key = JSON.stringify(t.structure);
    const g = groups.find(x => x.key === key);
    if (g) g.flights.push(t); else groups.push({ key, st: t.structure, flights: [t] });
  });
  return groups.map(g => {
    const label = ev.flights.length > 1 ? `（${g.flights.map(t => t.flight).join('・')}）` : '';
    return `<h2 class="day">ブラインドストラクチャー${esc(label)}</h2>
<p class="lead">${spadieStructSummary(g.st)}</p>
${spadieStructureTable(g.st)}`;
  }).join('\n');
}
function spadieOneDetailTable(t, ev) {
  const p = t.prize || {};
  const extra = (p.extra || []).map(x => `    <tr><th>賞品</th><td>${esc(x)}</td></tr>`).join('\n');
  return `<div class="sched-wrap"><table class="sched">
  <tbody>
    <tr><th>開始</th><td>${esc(spadieWhen(t))}</td></tr>
    <tr><th>受付</th><td>${spadieRegText(t)}</td></tr>
    <tr><th>終了予定</th><td>${esc(t.end || '—')}</td></tr>
    <tr><th>参加費</th><td>${esc(t.entry)}</td></tr>
    <tr><th>スタック</th><td>${esc(t.stack)}</td></tr>
    <tr><th>プライズ</th><td class="fst-prize">${spadiePrizeHtml(p)}</td></tr>
${extra ? extra + '\n' : ''}    <tr><th>ストラクチャー</th><td>${spadieStructSummary(t.structure)}<br><small><a href="#structure">全レベルの表を見る ↓</a></small></td></tr>
${t.notes && t.notes.length ? `    <tr><th>備考</th><td>${t.notes.map(esc).join('<br>')}</td></tr>\n` : ''}    <tr><th>会場</th><td>${esc(SPADIE.venue)}（${esc(SPADIE.address)}）</td></tr>
  </tbody>
</table></div>`;
}
function spadieFlightsTable(ev) {
  return `<h2 class="day">フライト別の日程</h2>
<div class="sched-wrap"><table class="sched">
  <thead><tr><th>フライト</th><th>開始</th><th>受付</th><th>終了予定</th></tr></thead>
  <tbody>
${ev.flights.map(t => `    <tr id="${t.flight.toLowerCase().replace(/[^a-z0-9]+/g, '')}"><td class="no">${esc(t.flight)}</td><td>${esc(spadieWhen(t))}</td><td>${spadieRegText(t)}</td><td>${esc(t.end || '—')}</td></tr>`).join('\n')}
  </tbody>
</table></div>`;
}
function buildSpadieEventPage(ev, idx) {
  const base = `${SITE}${SPADIE.basePath}`;
  const canonical = `${SITE}${ev.path}`;
  const image = 'img/spadie/spadie-og.jpg';
  const t0 = ev.flights[0];
  const tl = ev.flights[ev.flights.length - 1];
  const p = t0.prize || {};
  const multi = ev.flights.length > 1;
  const f0 = fmtDate(t0.day);
  const whenShort = multi
    ? `${f0.m}/${f0.d}〜${fmtDate(tl.day).m}/${fmtDate(tl.day).d}`
    : `${f0.m}/${f0.d} ${t0.start.replace('翌', '翌')}`;
  const prizeShort = p.seat ? p.seat.replace(/（.*?）/g, '') : `Prize Total ${p.total}（${spadieYen(p.total)}）`;
  const title = `${ev.name}（#${ev.no}）SPADIE FUKUOKA 1st ${whenShort} 参加費・ストラクチャー | ふくおかポーカーナビ`;
  const desc = `SPADIE FUKUOKA 1st（福岡・大名 UNITEDLAB）の #${ev.no} ${ev.name}。`
    + `${multi ? `Day 1は${ev.flights.filter(t => /Day 1/.test(t.flight)).length}フライト、` : `${spadieWhen(t0)}開始、`}参加費${t0.entry}、スタック${t0.stack}、${prizeShort}。`
    + '受付締切・終了予定・全レベルのブラインドストラクチャーを公式Players Guideからまとめています。';
  const cash = cashOffer(`#${ev.no} ${ev.name}`, String(t0.entry).replace(/（.*?）/g, ''), SPADIE.scheduleUrl);
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": `SPADIE FUKUOKA 1st #${ev.no} ${ev.name}`,
    "image": abs(image),
    "startDate": spadieStartIso(t0),
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": "UNITEDLAB",
      "address": { "@type": "PostalAddress", "streetAddress": "大名1-3-36", "addressRegion": "福岡県", "addressLocality": "福岡市中央区", "postalCode": "810-0041", "addressCountry": "JP" }
    },
    "superEvent": { "@type": "Event", "name": "SPADIE FUKUOKA 1st", "url": base, "startDate": BIG.eventFirstDay(SPADIE.days), "endDate": BIG.eventLastDay(SPADIE.days) },
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  if (cash) jsonld.offers = cash;
  const breadcrumb = pageBreadcrumb('spadie', base).concat([{ name: `#${ev.no} ${ev.name}`, url: canonical }]);
  const backHref = `${SPADIE.basePath}#day-${t0.day}`;
  const prev = SPADIE.events[idx - 1], next = SPADIE.events[idx + 1];
  const pn = `<nav class="sp-pn" aria-label="前後のトーナメント">
  ${prev ? `<a href="${esc(prev.path)}"><small>‹ 前のトーナメント</small>#${esc(prev.no)} ${esc(prev.name)}</a>` : '<span></span>'}
  ${next ? `<a class="nx" href="${esc(next.path)}"><small>次のトーナメント ›</small>#${esc(next.no)} ${esc(next.name)}</a>` : '<span></span>'}
</nav>`;
  const sameDay = SPADIE.events.filter(e => e !== ev && e.flights.some(t => t.day === t0.day));
  const guides = t0.guide.map((g, i) => `<a href="${esc(SPADIE.guideImgBase + g + '.webp')}" target="_blank" rel="noopener">公式シート画像${t0.guide.length > 1 ? (i + 1) : ''}</a>`).join('・');
  const body = `
${SITE_BANNER_SECTION.html}<a class="sp-back" href="${esc(backHref)}">‹ SPADIE FUKUOKA 1st 全日程に戻る</a>
<h1>#${esc(ev.no)} ${esc(ev.name)}（SPADIE FUKUOKA 1st）</h1>
<p class="lead">${multi ? `${f0.m}月${f0.d}日〜${fmtDate(tl.day).m}月${fmtDate(tl.day).d}日（全${ev.flights.length}フライト）` : esc(spadieWhen(t0)) + '開始'}／UNITEDLAB（福岡市中央区大名）</p>
${multi ? spadieFlightsTable(ev) : ''}
<h2 class="day">トーナメント概要</h2>
${multi ? spadieOneDetailTable(Object.assign({}, t0, { start: t0.start, end: '各フライトの表を参照' }), ev).replace(/<tr><th>開始<\/th>.*?<\/tr>\n\s*<tr><th>受付<\/th>.*?<\/tr>\n/s, '') : spadieOneDetailTable(t0, ev)}
<div id="structure"></div>
${spadieStructureBlocks(ev)}
<p class="lead" style="margin-top:10px">出典: <a href="${esc(SPADIE.scheduleUrl)}" target="_blank" rel="noopener">SPADIE FUKUOKA 公式トーナメントリスト</a>・${guides}（${esc(SPADIE_AS_OF)}時点）。プライズは公式表記の米ドルで、円は公式シートの仮レートによる目安です。</p>
${pn}
${sameDay.length ? `<h2 class="day">同じ日（${f0.m}/${f0.d}）のほかのトーナメント</h2>
<ul class="sp-list">
${sameDay.map(e => { const t = e.flights.find(x => x.day === t0.day); return `  <li><a href="${esc(e.path)}"><span class="sp-time">${esc(t.start)}</span><span class="sp-body"><span class="sp-name">#${esc(e.no)} ${esc(e.name)}${t.flight ? `（${esc(t.flight)}）` : ''}</span><span class="sp-sub">${esc(t.entry)}</span></span><span class="sp-go">詳細 ›</span></a></li>`; }).join('\n')}
</ul>` : ''}
<a class="sp-back" href="${esc(backHref)}">‹ SPADIE FUKUOKA 1st 全日程に戻る</a>
${adCard()}
<div class="disclaimer">当サイトはSPADIE FUKUOKA 1stの主催者・公式媒体ではありません。公式Players Guide（画像で公開されているシート）を当サイトが転記した<b>非公式のまとめ</b>で、転記の誤りが含まれる可能性があります。プライズは賞金ではなく、対象ポーカートーナメントへの参加補助が受けられる任意の選手契約（委託料）です。参加前に必ず公式情報をご確認ください。<br>${POSITIONING}</div>`;
  return pageHead({ title, desc, canonical, jsonld, image, extraCss: ADCARD_CSS + BANNER_CSS + SPADIE_CSS, breadcrumb }) + body + pageFoot(ev.path);
}
function spadieEventFiles() {
  const out = {};
  SPADIE.events.forEach((ev, i) => { out[ev.path.replace(/^\//, '') + 'index.html'] = buildSpadieEventPage(ev, i); });
  return out;
}

// ---- 大型大会: 日程(トーナメント別スケジュール)が未発表の日の書き方(2026-11-12・運営の恒久ルール) ----
// 大型大会ページは「日程ごとに各トーナメントの詳細」を載せる(SPADIE/JOPT/WJPTの形)。まだ発表されていない
// 大会でも日別の見出しは立て、その日のトーナメントが【未発表であること】を明記する(README「大型大会ページの
// 書き方」)。発表されたら、その大会の xxx-data.js を作って SPADIE と同じ日別カード表示に置き換える。
function tbdDaySections(days, asOf, officialLinkHtml) {
  return `<h2 class="day">日程ごとのトーナメント</h2>
<p class="lead">${esc(asOf)}時点で、各日のトーナメント（イベント名・開始時刻・参加費・プライズ・ストラクチャー）は公式から発表されていません。発表され次第、日程ごとに各トーナメントの詳細を掲載します。</p>
<div class="sched-wrap"><table class="sched">
  <thead><tr><th>日程</th><th>トーナメント</th></tr></thead>
  <tbody>
${days.map(d => { const f = fmtDate(d); return `    <tr><td class="no">${f.m}/${f.d}（${f.wd}）</td><td>未発表<br><small>開始時刻・参加費・プライズ・ストラクチャーとも未発表。最新情報は${officialLinkHtml}でご確認ください。</small></td></tr>`; }).join('\n')}
  </tbody>
</table></div>`;
}

// ---- FST in KITAKYUSHU 2027 ページ(2026-11-09追加) ----
// メインイベントの詳細は未発表のため、SPADIEページと同じく「判明している事実＋未発表の整理」の形。
// このページの主目的は【店舗サテライトへの送客】: FSTチケットを獲得できる県内店舗の日程を一覧にし、
// 各店舗ページへリンクする。出典は big-events.js の fstkq エントリのコメントを参照。
const FSTKQ_X = 'https://x.com/fst_202408';
const FSTKQ_AS_OF = '2026年11月9日';
// 店舗サテライトの開始日(主催者告知を紹介する媒体による)。これより前の行はFST 5.0向けなので含めない。
const FSTKQ_SAT_FROM = '2026-10-12';
const { isFstSatelliteEntry } = require('./venue-schedule.js');
const FST_TICKET_RE = /FST\s*(チケット|TICKET)/i;
// 「FSTチケットを獲得できるトーナメント」の判定。ブラウザ側(下の描き直しスクリプト)にも同じ規則を
// 文字列で埋め込むので、規則を変えるときは fstkqKindJs も合わせて直すこと。
function fstkqKind(t) {
  if ((t.tags || []).includes('店舗DAY1')) return null;
  if (isFstSatelliteEntry(t)) return 'サテライト';
  if (FST_TICKET_RE.test(t.name || '') || FST_TICKET_RE.test(t.prize || '')) return '賞品にFSTチケット';
  return null;
}
const fstkqKindJs = `function(t){var tg=t.tags||[];if(tg.indexOf('店舗DAY1')>=0)return null;
var sat=/サテライト|satellite/i,fst=/FST/i,tk=/FST\\s*(チケット|TICKET)/i,any=function(re){return re.test(t.name||'')||tg.some(function(x){return re.test(x);});};
if(any(sat)&&any(fst))return 'サテライト';if(tk.test(t.name||'')||tk.test(t.prize||''))return '賞品にFSTチケット';return null;}`;
function fstkqRows(from, until) {
  return DATA.TOURNAMENTS
    .filter(t => t.date >= from && t.date <= until && fstkqKind(t))
    .sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
}
function fstkqTableHtml(rows) {
  const vmap = Object.fromEntries(DATA.VENUES.map(v => [v.id, v]));
  const wd = ['日', '月', '火', '水', '木', '金', '土'];
  if (!rows.length) return '<p class="lead">現在、掲載中のサテライト日程はありません。各店舗の公式情報・SNSをご確認ください。</p>';
  return `<div class="sched-wrap"><table class="sched">
  <thead><tr><th>日時</th><th>店舗</th><th>トーナメント</th></tr></thead>
  <tbody>
${rows.map(t => {
    const v = vmap[t.venueId] || { name: '', slug: '' };
    const [y, m, d] = t.date.split('-').map(Number);
    const w = wd[new Date(y, m - 1, d).getDay()];
    const fee = t.buyin == null ? '店舗SNSで確認' : t.buyin === 0 ? '無料' : '¥' + Number(t.buyin).toLocaleString('ja-JP');
    return `    <tr><td class="no">${m}/${d}（${w}）<br>${t.start ? esc(t.start) : '<small>詳細は店舗SNSにて</small>'}</td><td><a href="/venues/${esc(v.slug)}/">${esc(v.name)}</a></td><td>${esc(t.name)}<br><small>参加費: ${esc(fee)}${fstkqKind(t) === '賞品にFSTチケット' ? '／賞品にFSTチケット' : ''}</small></td></tr>`;
  }).join('\n')}
  </tbody>
</table></div>`;
}
function fstkqFaqItems() {
  const xLink = `<a href="${esc(FSTKQ_X)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>`;
  return [
    {
      q: 'FST in KITAKYUSHUはいつ・どこで開催されますか？',
      aHtml: '2027年1月22日（金）〜24日（日）の3日間、北九州・小倉のアートホテル小倉 ニュータガワ（福岡県北九州市小倉北区古船場町3-46）で開催されると案内されています。',
      aText: '2027年1月22日(金)〜24日(日)の3日間、北九州・小倉のアートホテル小倉 ニュータガワ(福岡県北九州市小倉北区古船場町3-46)で開催されると案内されています。'
    },
    {
      q: 'FSTチケットはどうやって手に入れますか？',
      aHtml: '県内のアミューズメントポーカー店で開催されるサテライト（チケット獲得トーナメント）で獲得できます。当サイトに掲載中のサテライト日程は本ページの「今後のFSTサテライト日程」にまとめています。必要枚数・参加費は店舗ごとに異なるため、各店舗の告知をご確認ください。',
      aText: '県内のアミューズメントポーカー店で開催されるサテライト(チケット獲得トーナメント)で獲得できます。必要枚数・参加費は店舗ごとに異なるため、各店舗の告知をご確認ください。'
    },
    {
      q: '獲得したチケットはFST6.0でも使えますか？',
      aHtml: `主催者の告知を紹介する媒体によると、FSTチケットは北九州大会と2027年3月のFST6.0（ホテルニューオータニ博多）で共通して使えると案内されています。条件の詳細は${xLink}でご確認ください。`,
      aText: '主催者の告知を紹介する媒体によると、FSTチケットは北九州大会と2027年3月のFST6.0(ホテルニューオータニ博多)で共通して使えると案内されています。条件の詳細は公式Xでご確認ください。'
    },
    {
      q: 'メインイベントの参加費やプライズは？',
      aHtml: `${FSTKQ_AS_OF}時点では未発表です。発表され次第、本ページを更新します。最新情報は${xLink}でご確認ください。`,
      aText: `${FSTKQ_AS_OF}時点では未発表です。最新情報は公式Xでご確認ください。`
    }
  ];
}
function buildFstKitakyushu() {
  const canonical = `${SITE}/events/fst-kitakyushu-2027/`;
  const image = 'img/fst-kitakyushu/fst-kitakyushu-og.jpg';
  const reg = BIG.bigEventById('fstkq');
  const first = BIG.eventFirstDay(reg.days), last = BIG.eventLastDay(reg.days);
  const rows = fstkqRows(FSTKQ_SAT_FROM, last);
  const title = 'FST in KITAKYUSHU 2027（1/22〜24 アートホテル小倉）開催概要とFSTサテライト日程 | ふくおかポーカーナビ';
  const desc = 'FST（FUKUOKA SUPER TOURNAMENT）の北九州大会「FST in KITAKYUSHU」（2027年1月22日〜24日・アートホテル小倉 ニュータガワ）の開催概要と、'
    + 'FSTチケットを獲得できる福岡県内の店舗サテライト日程をまとめて掲載します。';
  // organizer・offers は出さない(主催者名の正式表記・参加費が未確認/未発表のため)。
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "FST in KITAKYUSHU 2027 (FUKUOKA SUPER TOURNAMENT)",
    "image": abs(image),
    "startDate": first,
    "endDate": last,
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": "アートホテル小倉 ニュータガワ",
      "address": { "@type": "PostalAddress", "streetAddress": "古船場町3-46", "addressRegion": "福岡県", "addressLocality": "北九州市小倉北区", "addressCountry": "JP" }
    },
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  const faq = faqBlock(fstkqFaqItems(), { headingId: 'fstkq-faq' });
  const vlist = DATA.VENUES.map(v => [v.id, { n: v.name, s: v.slug }]);
  const body = `
${SITE_BANNER_SECTION.html}<h1>FST in KITAKYUSHU 2027（1月22日〜24日・アートホテル小倉）開催概要とサテライト日程</h1>
<p class="lead">会期: 2027年1月22日（金）〜24日（日）／会場: アートホテル小倉 ニュータガワ（北九州市小倉北区）</p>
<img class="evt-banner" src="/${esc(reg.banner)}" width="1024" height="412" alt="${esc(reg.bannerAlt)}">
<div class="evt-meta">
  <b>大会名</b>　FST in KITAKYUSHU（FUKUOKA SUPER TOURNAMENT 北九州大会）<br>
  <b>会期</b>　2027年1月22日（金）〜24日（日）の3日間<br>
  <b>会場</b>　アートホテル小倉 ニュータガワ<br>
  <b>住所</b>　福岡県北九州市小倉北区古船場町3-46<br>
  <b>アクセス</b>　JR小倉駅から徒歩約8分／北九州モノレール 旦過駅から徒歩約2分<br>
  <b>参加方法</b>　店舗サテライトでFSTチケットを獲得（2026年10月12日から順次開催と案内）
</div>
<div class="tba"><b>${FSTKQ_AS_OF}時点で、メインイベントの参加費・プライズ・タイムスケジュールは未発表です。</b>判明次第、当ページを更新します。最新情報は<a href="${esc(FSTKQ_X)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>でご確認ください。</div>
${tbdDaySections(reg.days, FSTKQ_AS_OF, `<a href="${esc(FSTKQ_X)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>`)}
<h2 class="day" id="satellites">今後のFSTサテライト日程</h2>
<p class="lead">FSTチケットを獲得できる、福岡県内の店舗のトーナメントです（当サイト掲載データから自動集計）。店名から各店舗の料金・アクセス・全日程を確認できます。参加費・必要枚数・賞品の条件は店舗ごとに異なるため、参加前に店舗の告知をご確認ください。</p>
<p class="lead" id="fstkq-sched-note" style="margin-top:-6px"><small>${fmtDate(FSTKQ_SAT_FROM).m}/${fmtDate(FSTKQ_SAT_FROM).d}以降の掲載データ（${rows.length}件）を表示しています。JavaScriptが有効な環境では、読み込み時に最新の掲載データから<b>今日以降</b>の日程に差し替わります。</small></p>
<div id="fstkq-sched">${fstkqTableHtml(rows)}</div>
${satelliteVenuesBlock(reg.satelliteVenueIds, {
    heading: 'FSTサテライト開催店舗',
    lead: n => `下記の店舗では、FSTチケットを獲得できるサテライトが開催されています（当サイト掲載データより集計・${n}店舗）。最新の開催状況は各店舗のページ・公式情報・SNSでご確認ください。`
  })}
<h2 class="day">FSTチケットはFST6.0と共通</h2>
<p class="lead">主催者の告知を紹介する媒体によると、店舗サテライトで獲得したFSTチケットは、この北九州大会と、2027年3月19日（金）〜22日（月・振休）にホテルニューオータニ博多で開催予定のFST6.0の両方で使えると案内されています。両大会では、FSTチケットでのみ参加できるトーナメントも予定されているとのことです。前回大会の様子は<a href="/events/fst-2026-fukuoka/">FST 5.0（2026年9月・ホテルニューオータニ博多）</a>のページをご覧ください。</p>
<h2 class="day">現時点で発表されている情報／発表されていない情報</h2>
<div class="sched-wrap"><table class="sched">
  <tbody>
    <tr><th>会期</th><td>2027年1月22日（金）〜24日（日）</td></tr>
    <tr><th>会場</th><td>アートホテル小倉 ニュータガワ（北九州市小倉北区古船場町3-46）</td></tr>
    <tr><th>店舗サテライト</th><td>2026年10月12日から順次開催（県内各店）</td></tr>
    <tr><th>FSTチケット</th><td>北九州大会・FST6.0（2027年3月）で共通</td></tr>
    <tr><th>メインイベントの参加費</th><td>未発表</td></tr>
    <tr><th>プライズ</th><td>未発表</td></tr>
    <tr><th>タイムスケジュール</th><td>未発表</td></tr>
  </tbody>
</table></div>
${faq.html}
${venueScheduleBlock()}
${adCard()}
<div class="disclaimer">当サイトはFST（FUKUOKA SUPER TOURNAMENT）の主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。大会名・会場・チケットの扱いは主催者の告知を紹介する媒体の情報にもとづきます。掲載しているバナーは当サイトが作成したもので、ロゴ・大会名等の権利は主催者に帰属します。掲載内容は<b>${FSTKQ_AS_OF}時点</b>の情報で、当サイトによる転記の誤りが含まれる可能性があります。サテライト日程は各店舗の告知を当サイトが転記したものです。参加前に必ず<a href="${esc(FSTKQ_X)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>・各店舗の公式情報をご確認ください。<br>${POSITIONING}</div>

<div class="links">
  ▶ <a href="${esc(FSTKQ_X)}" target="_blank" rel="noopener">FST 公式X（@fst_202408）</a><br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>
${faq.script}`;
  // 閲覧時の描き直し(店舗ページと同じ考え方): /data.js を読み直して今日以降のサテライトだけにする。
  const scripts = `<script src="/data.js"></script>
<script>
(function(){
  if (typeof TOURNAMENTS === 'undefined') return;
  var el = document.getElementById('fstkq-sched'); if (!el) return;
  var kind = ${fstkqKindJs};
  var V = {}; ${JSON.stringify(vlist)}.forEach(function(p){ V[p[0]] = p[1]; });
  var pad = function(x){ return String(x).padStart(2, '0'); };
  var n = new Date(), today = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  var until = ${JSON.stringify(last)};
  var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
  var rows = TOURNAMENTS.filter(function(t){ return t.date >= today && t.date <= until && kind(t); })
    .sort(function(a, b){ return (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')); });
  var wd = ['日','月','火','水','木','金','土'];
  if (!rows.length) { el.innerHTML = '<p class="lead">現在、掲載中のサテライト日程はありません。各店舗の公式情報・SNSをご確認ください。</p>'; }
  else el.innerHTML = '<div class="sched-wrap"><table class="sched"><thead><tr><th>日時</th><th>店舗</th><th>トーナメント</th></tr></thead><tbody>'
    + rows.map(function(t){
        var v = V[t.venueId] || {n:'', s:''}; var p = t.date.split('-').map(Number);
        var w = wd[new Date(p[0], p[1] - 1, p[2]).getDay()];
        var fee = t.buyin == null ? '店舗SNSで確認' : t.buyin === 0 ? '無料' : '¥' + Number(t.buyin).toLocaleString('ja-JP');
        return '<tr><td class="no">' + p[1] + '/' + p[2] + '（' + w + '）<br>' + (t.start ? esc(t.start) : '<small>詳細は店舗SNSにて</small>') + '</td><td><a href="/venues/' + esc(v.s) + '/">' + esc(v.n) + '</a></td><td>' + esc(t.name) + '<br><small>参加費: ' + esc(fee) + (kind(t) === '賞品にFSTチケット' ? '／賞品にFSTチケット' : '') + '</small></td></tr>';
      }).join('') + '</tbody></table></div>';
  var note = document.getElementById('fstkq-sched-note'); if (note) note.innerHTML = '<small>今日以降の掲載データ（' + rows.length + '件）を表示しています。</small>';
})();
</script>
${SITE_BANNER_SECTION.scripts}`;
  return pageHead({ title, desc, canonical, jsonld, image, extraCss: FAQ_CSS + ADCARD_CSS + BANNER_CSS, breadcrumb: pageBreadcrumb('fstkq', canonical) })
    + body + shell.pageFoot(BIG, '/events/fst-kitakyushu-2027/', scripts, FOOTER_AREA_LINKS);
}

// ---- 書き出し / 検査 ----
// 出力はいったん全部メモリ上で組み立ててから、まとめて書く(--check のときは書かずに突き合わせる)。
// --check は「big-events.js を直したのに再生成を忘れた」「生成物を手で書き換えた」を検出するためのもの。
const files = {
  'events/jopt-2026-fukuoka-01/index.html': buildJopt(),
  'events/wjpt-2026/index.html': buildWjpt(),
  'events/nippon-series-2026-fukuoka/index.html': buildNippon(),
  'events/fst-2026-fukuoka/index.html': buildFst(),
  'events/spadie-fukuoka-1st/index.html': buildSpadie(),
  ...spadieEventFiles(),   // トーナメント個別ページ(35件)
  'events/fst-kitakyushu-2027/index.html': buildFstKitakyushu(),
  'index.html': buildIndexHtml(),     // 恒久リンク行(#evtLinks)だけを差し替えたもの
  // sitemap.xml の中身は tools/gen-sitemap.js が決める(このスクリプトは組み立てない)。
  // イベントページと店舗ページの両方のURLが必要なので、片方の生成スクリプトが自前で
  // 作ると相手のURLを消してしまう。ここでは受け取った文字列をそのまま書くだけ。
  ...sitemapFile(REPO)
};

verifyPermanentLinks(files);

if (CHECK) {
  const stale = Object.keys(files).filter(rel => {
    let cur = null;
    try { cur = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (e) { /* 未生成 */ }
    return cur !== files[rel];
  });
  if (stale.length) {
    console.error('\n✗ 生成物がレジストリと一致しません（node tools/gen-event-pages.js <repo> を実行してください）:\n  - ' + stale.join('\n  - '));
    process.exit(1);
  }
  console.log('検査: 生成物はすべて最新（' + Object.keys(files).length + 'ファイル）');
} else {
  Object.keys(files).forEach(rel => {
    const p = path.join(REPO, rel);
    let cur = null;
    try { cur = fs.readFileSync(p, 'utf8'); } catch (e) { /* 未生成 */ }
    if (cur === files[rel]) { console.log('据置:', rel, `(${files[rel].length} 文字・変更なし)`); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel], 'utf8');
    console.log('生成:', rel, `(${files[rel].length} 文字)`);
  });
  console.log('完了。JOPT', JOPT.tournaments.length, '件 / WJPT', WJPT.tournaments.length, '件 / NIPPON SERIES', NIPPON.events.length, '行');
}
