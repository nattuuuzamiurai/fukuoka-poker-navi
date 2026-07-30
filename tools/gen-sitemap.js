#!/usr/bin/env node
/**
 * gen-sitemap.js — sitemap.xml の【唯一の所有者】
 *
 * 【なぜ独立したファイルなのか】
 *   sitemap.xml に載せるURLは2種類のソースにまたがる:
 *     - 大型イベントページ … big-events.js のレジストリ(featureUrl が /events/ で始まるもの)
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
 * 使い方:
 *   node gen-sitemap.js <リポジトリのパス>            … sitemap.xml を書き出す
 *   node gen-sitemap.js <リポジトリのパス> --check     … 書き込まず、ディスクの内容と一致するかだけ見る
 */

const fs = require('fs');
const path = require('path');
const shell = require('./site-shell.js');
const { SITE } = shell;

// URLごとの changefreq / priority。日付には依存させない(上記の理由)。
const HOME = { freq: 'daily', pri: '1.0' };
const EVENT = { freq: 'weekly', pri: '0.8' };
const VENUE = { freq: 'weekly', pri: '0.7' };

/** sitemap.xml の中身(文字列)を組み立てる。REPO は絶対パスで渡すこと。 */
function buildSitemap(REPO) {
  const BIG = require(path.join(REPO, 'big-events.js'));
  const DATA = require(path.join(REPO, 'data.js'));

  // slug が欠けている・重複している状態の sitemap は公開してはいけないので、ここでも止める。
  shell.validateVenueSlugs(DATA.VENUES);

  const urls = [{ loc: `${SITE}/`, ...HOME }];

  // 大型イベント: 静的ページを持つものだけ(featureUrl がハッシュURLの大会はトップの一部なので載せない)。
  // 会期の古い順。レジストリに大会を足して静的ページを作れば、ここにも自動で増える。
  BIG.BIG_EVENTS
    .slice()
    .sort((a, b) => String(BIG.eventFirstDay(a.days)).localeCompare(String(BIG.eventFirstDay(b.days))))
    .filter(e => e.featureUrl && e.featureUrl.startsWith('/events/'))
    .forEach(e => urls.push({ loc: SITE + e.featureUrl, ...EVENT }));

  // 店舗ページ: data.js の VENUES 全件。店を足せば自動で増える。
  DATA.VENUES.forEach(v => urls.push({ loc: `${SITE}/venues/${v.slug}/`, ...VENUE }));

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.freq}</changefreq>
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
