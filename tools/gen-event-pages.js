#!/usr/bin/env node
/**
 * gen-event-pages.js
 *
 * 検索流入用に、大型イベント(JOPT / WJPT / NIPPON SERIES / FST)のクローラブルな静的ページを生成する。
 * SPAのハッシュURL(#jopt 等)は個別ページとしてインデックスされないため、
 * /events/<slug>/index.html という実URLの静的ページを用意する。
 *
 * データは既存の検証済みソースからそのまま読み込む(数値を手打ちしない):
 *   - JOPT:          jopt-data.js (window.JOPT_DATA / module.exports)
 *   - WJPT:          index.html 内の const WJPT = {...} を抽出
 *   - NIPPON SERIES: nippon-series-data.js
 *   - FST:           index.html 内の const FST = {...} を抽出
 *
 * 生成物:
 *   - events/jopt-2026-fukuoka-01/index.html
 *   - events/wjpt-2026/index.html
 *   - events/nippon-series-2026-fukuoka/index.html
 *   - events/fst-2026-fukuoka/index.html
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
const { SITE, POSITIONING, esc, fmtDate, LINK_SEP, pageHead } = shell;
// sitemap.xml の唯一の所有者。中身はここでは組み立てず、丸ごと受け取って書くだけ。
const { sitemapFile } = require('./gen-sitemap.js');

// ---- データ読み込み ----
const JOPT = require(path.join(REPO, 'jopt-data.js'));
// 大型イベントのレジストリ(会期・掲載期間ルール)。ブラウザ側と同じファイルを使う。
const BIG = require(path.join(REPO, 'big-events.js'));
const NIPPON = require(path.join(REPO, 'nippon-series-data.js'));

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

// ---- ページの骨格・恒久リンク行(site-shell.js) ----
// pageHead / pageFoot / permanentEventLinks の実体は tools/site-shell.js にある。
// 呼び出し側の書き方を変えずに済むよう、BIG(レジストリ)を束ねただけの薄いラッパを置く。
const permanentEventLinksList = () => shell.permanentEventLinksList(BIG);
const permanentEventLinks = currentPath => shell.permanentEventLinks(BIG, currentPath);
// currentPath: そのページ自身のパス(自己リンクを避けるため)。省略すると全件がリンクになる。
const pageFoot = currentPath => shell.pageFoot(BIG, currentPath);

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
function buildJopt() {
  const canonical = `${SITE}/events/jopt-2026-fukuoka-01/`;
  const title = 'JOPT 2026 Fukuoka #01 タイムスケジュール（7/30〜8/2 福岡・大名）| ふくおかポーカーナビ';
  const desc = 'JOPT 2026 Fukuoka #01（2026年7月30日〜8月2日・UNITEDLAB 福岡市中央区大名）の全' + JOPT.tournaments.length + 'トーナメントのタイムスケジュール・バイイン・スタックを一覧掲載。メインイベントはプライズ保証1,500万円。';
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "JOPT 2026 Fukuoka #01",
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
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  const body = `
<h1>JOPT 2026 Fukuoka #01 タイムスケジュール</h1>
<p class="lead">Japan Open Poker Tour 2026 福岡 #01 の全${JOPT.tournaments.length}トーナメント日程</p>
<div class="evt-meta">
  <b>会期</b>　2026年7月30日（木）〜8月2日（日）<br>
  <b>会場</b>　${esc(JOPT.venue || 'UNITEDLAB')}（${esc(JOPT.address || '福岡県福岡市中央区大名1-3-36')}）<br>
  <b>メインイベント</b>　<span class="prize">プライズ保証 ¥15,000,000</span>
</div>
<div class="disclaimer">当サイトはJOPTの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載内容は2026年7月時点の公式情報にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。プライズ額は主催者発表で、JOPTではプライズは賞金ではなく選手契約として扱われます。参加前に必ず<a href="${esc(JOPT.guideUrl)}" target="_blank" rel="noopener">公式サイト</a>をご確認ください。<br>${POSITIONING}</div>
<a class="cta" href="/#jopt">▶ 各トーナメントのブラインドストラクチャーを見る／日付で絞り込む<small>インタラクティブ版(全ストラクチャー表つき)</small></a>
${schedTable(JOPT.tournaments)}
<div class="links">
  ▶ <a href="${esc(JOPT.guideUrl)}" target="_blank" rel="noopener">JOPT公式サイト</a>${JOPT.scheduleUrl ? `　／　<a href="${esc(JOPT.scheduleUrl)}" target="_blank" rel="noopener">公式スケジュール</a>` : ''}<br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld }) + body + pageFoot('/events/jopt-2026-fukuoka-01/');
}

// ---- WJPTページ(終了済み=アーカイブ) ----
function buildWjpt() {
  const canonical = `${SITE}/events/wjpt-2026/`;
  const title = 'WJPT 2026（West Japan Poker Tour 7/18〜7/20 北九州）タイムスケジュール | ふくおかポーカーナビ';
  const desc = 'WJPT（West Japan Poker Tour）2026年7月18日〜20日・北九州で開催された全' + WJPT.tournaments.length + 'トーナメントのタイムスケジュール・バイイン・スタックの記録。';
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "WJPT 2026 (West Japan Poker Tour)",
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
<h1>WJPT 2026 タイムスケジュール</h1>
<p class="lead">West Japan Poker Tour 2026（北九州）の全${WJPT.tournaments.length}トーナメント日程</p>
<div class="archived"><b>このイベントは終了しました。</b>以下は2026年7月18日〜20日に北九州で開催された当時の日程・内容の記録です。今後のトーナメントは<a href="/">トップページ</a>をご確認ください。</div>
<div class="evt-meta">
  <b>会期</b>　2026年7月18日（土）〜7月20日（月・祝）<br>
  <b>エリア</b>　${esc(WJPT.area || '北九州')}
</div>
<div class="disclaimer">当サイトはWJPTの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載内容は開催当時の公式情報にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。イベント終了後は内容を更新していません。掲載元: <a href="${esc(WJPT.guideUrl)}" target="_blank" rel="noopener">公式プレイヤーズガイド</a>（開催当時）。<br>${POSITIONING}</div>
<a class="cta" href="/#wjpt">▶ 各トーナメントの公式ストラクチャー画像を見る<small>インタラクティブ版(告知シート画像つき)</small></a>
${schedTable(WJPT.tournaments)}
<div class="links">
  ▶ <a href="/">福岡の今後のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld, image: (WJPT.banner || 'img/wjpt/wjpt-banner.jpg') }) + body + pageFoot('/events/wjpt-2026/');
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
  const title = 'NIPPON SERIES FUKUOKA 2026 タイムスケジュール（8/11〜8/16 福岡・渡辺通）| ふくおかポーカーナビ';
  const desc = `NIPPON SERIES FUKUOKA 2026（2026年8月11日〜16日・福岡 トヨタホールスカラエスパシオ）の全${NIPPON.eventCount}イベントのタイムスケジュール・Fee・登録締切・Prizeを一覧掲載。MAIN EVENT（#17）は Prize 5,000,000。`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": NIPPON.name,
    "startDate": NIPPON.days[0],
    "endDate": NIPPON.days[NIPPON.days.length - 1],
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "eventStatus": "https://schema.org/EventScheduled",
    "location": {
      "@type": "Place",
      "name": NIPPON.venue,
      "address": { "@type": "PostalAddress", "streetAddress": "渡辺通4-8-28 F.Tビル 地下2階", "addressRegion": "福岡県", "addressLocality": "福岡市中央区", "postalCode": "810-0004", "addressCountry": "JP" }
    },
    "description": desc,
    "url": canonical,
    "isAccessibleForFree": false
  };
  const body = `
<h1>NIPPON SERIES FUKUOKA 2026 タイムスケジュール</h1>
<p class="lead">${esc(NIPPON.name)} の全${NIPPON.eventCount}イベント日程（#1〜#38）</p>
<div class="evt-meta">
  <b>会期</b>　2026年8月11日（火）〜8月16日（日）<br>
  <b>会場</b>　${esc(NIPPON.venue)}（${esc(NIPPON.address)}）<br>
  <b>アクセス</b>　${esc(NIPPON.access)}<br>
  <b>MAIN EVENT（#17）</b>　<span class="prize">Prize 5,000,000 ＋ inゼリー １年分</span>
</div>
<div class="disclaimer">当サイトはNIPPON SERIESの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載内容は<b>2026年7月29日時点</b>の公式情報にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。Fee・Prize は公式表記のまま掲載しており、「+ 1,000」の内訳は公式に明記がないため当サイトでは言い換えていません。参加前に必ず<a href="${esc(NIPPON.siteUrl)}" target="_blank" rel="noopener">公式イベントページ</a>をご確認ください。<br>${POSITIONING}</div>
<a class="cta" href="/#nippon">▶ 日付で絞り込んで見る<small>インタラクティブ版（日別タブ・各イベントの公式ストラクチャーへのリンクつき）</small></a>
${schedTableNippon(NIPPON.events)}
<p class="lead" style="margin-top:14px">※ MAIN EVENT（#17）は Day 1A〜Day 1D Last Chance と Day 2 &amp; FINAL に分かれているため、同じ番号が複数の日に登場します。ブラインドストラクチャーは公式の各トーナメントページをご確認ください。</p>
<div class="links">
  ▶ <a href="${esc(NIPPON.siteUrl)}" target="_blank" rel="noopener">NIPPON SERIES 公式イベントページ</a>　／　<a href="${esc(NIPPON.guidePdfUrl)}" target="_blank" rel="noopener">公式Players Guide(PDF)</a><br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld, image: 'img/nippon-series/nippon-series-banner.jpg' }) + body + pageFoot('/events/nippon-series-2026-fukuoka/');
}

// ---- FST 5.0 ページ ----
// 個別トーナメント(タイムスケジュール・ストラクチャー)は未発表のため、
// 会期・会場・発表済みの2大会(MAIN EVENT / CHAMPIONSHIP)の概要だけの薄いページ。
// ★ ここに推測を足さないこと。値はすべて index.html の const FST(＝一次情報で裏取り済み)から取る。
function buildFst() {
  const canonical = `${SITE}/events/fst-2026-fukuoka/`;
  const reg = BIG.bigEventById('fst');
  const first = BIG.eventFirstDay(FST.days), last = BIG.eventLastDay(FST.days);
  const f1 = fmtDate(first), f2 = fmtDate(last);
  const main = FST.events[0];
  const title = `FST 5.0（FUKUOKA SUPER TOURNAMENT）2026 福岡 開催概要（${f1.m}/${f1.d}〜${f2.m}/${f2.d} ホテルニューオータニ博多）| ふくおかポーカーナビ`;
  const desc = `FST 5.0（FUKUOKA SUPER TOURNAMENT／2026年${f1.m}月${f1.d}日〜${f2.m}月${f2.d}日・ホテルニューオータニ博多）の開催概要。`
    + `MAIN EVENT は Prize Total ${main.prize}、CHAMPIONSHIP は Prize Total ${FST.events[1].prize}。個別トーナメントの詳細は未発表です。`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "FST 5.0 (FUKUOKA SUPER TOURNAMENT)",
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
${e.sched.map(([k, v]) => `    <tr><th>${esc(k)}</th><td class="start">${esc(v)}</td></tr>`).join('\n')}
  </tbody>
</table></div>`).join('\n');
  const body = `
<h1>FST 5.0（FUKUOKA SUPER TOURNAMENT）2026 福岡 開催概要</h1>
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
<div class="tba"><b>個別トーナメントの詳細は未発表です。</b>タイムスケジュール・ブラインドストラクチャー・レイトレジ締切・サイドイベントの本数などは公表されていません。発表され次第、このページに掲載します。下表は現時点で公表されている MAIN EVENT と CHAMPIONSHIP の概要です。</div>
<div class="disclaimer">当サイトはFSTの主催者・公式媒体ではありません。公開情報をもとに当サイトが独自に集約した<b>非公式のまとめ</b>です。掲載しているバナーは当サイトが作成したもので、ロゴ・大会名等の権利は主催者に帰属します。掲載内容は<b>${esc(FST.asOf)}時点</b>の公式告知にもとづきますが、当サイトによる転記の誤りが含まれる可能性があります。発表済みの内容も変更される場合があります。参加前に必ず<a href="${esc(FST.x)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>等の公式情報をご確認ください。<br>${POSITIONING}</div>
<a class="cta" href="/#fst">▶ サイト内のFSTサテライト（チケット獲得トーナメント）を見る<small>インタラクティブ版（日付・店舗つきで直近の開催予定を表示）</small></a>
${tables}
<p class="lead" style="margin-top:14px">※ エントリー方法の「FSTチケット」は、県内各店で開催されるサテライトで獲得できるチケットを指します。サテライトの開催予定は<a href="/#fst">トップページのFSTページ</a>に掲載しています。</p>
<div class="links">
  ▶ <a href="${esc(FST.x)}" target="_blank" rel="noopener">公式X（@fst_202408）</a>　／　<a href="${esc(FST.linktree)}" target="_blank" rel="noopener">公式Linktree</a>　／　<a href="${esc(FST.instagram)}" target="_blank" rel="noopener">公式Instagram</a><br>
  ▶ <a href="/">福岡の他のポーカートーナメント日程を見る</a>
</div>`;
  return pageHead({ title, desc, canonical, jsonld, image: 'img/fst/fst-banner.jpg' }) + body + pageFoot('/events/fst-2026-fukuoka/');
}

// ---- 書き出し / 検査 ----
// 出力はいったん全部メモリ上で組み立ててから、まとめて書く(--check のときは書かずに突き合わせる)。
// --check は「big-events.js を直したのに再生成を忘れた」「生成物を手で書き換えた」を検出するためのもの。
const files = {
  'events/jopt-2026-fukuoka-01/index.html': buildJopt(),
  'events/wjpt-2026/index.html': buildWjpt(),
  'events/nippon-series-2026-fukuoka/index.html': buildNippon(),
  'events/fst-2026-fukuoka/index.html': buildFst(),
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
