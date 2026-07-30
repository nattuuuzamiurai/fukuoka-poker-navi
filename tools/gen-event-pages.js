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
 *   - sitemap.xml (ホーム + 各イベントページ)
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
const REPO = args.filter(a => !a.startsWith('--'))[0];
if (!REPO) { console.error('リポジトリのパスを指定してください'); process.exit(1); }

const SITE = 'https://fukuokapoker.com';

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

// ---- 共通ユーティリティ ----
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// サイト全体の法的ポジショニング文(index.html フッターと同一)。
// 検索から直接着地する静的ページにも必ず載せる。
const POSITIONING = '当サイトは店舗・主催者が公開している情報を集約する媒体であり、賭博行為の勧誘・仲介を行うものではありません。賞品・プライズの取扱いは各店舗・主催者の規定によります。';
const WD = ['日','月','火','水','木','金','土'];
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { md: `${m}/${d}`, wd: WD[dt.getUTCDay()], y, m, d };
}

// ---- 共通の <head>/ヘッダー/フッター ----
function pageHead({ title, desc, canonical, jsonld, image }) {
  const ogimg = `${SITE}/${image || 'img/jopt/jopt-banner.jpg'}`;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-L7091YHTFH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-L7091YHTFH');
</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="ふくおかポーカーナビ">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogimg)}">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogimg)}">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6349478743429747"
     crossorigin="anonymous"></script>
<script type="application/ld+json">
${JSON.stringify(jsonld, null, 2)}
</script>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
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
  footer{background:#1b2320;color:#9aa39d;padding:22px 16px;font-size:.8em;text-align:center;line-height:1.9}
  footer a{color:var(--gold2)}
  .stickyAd{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;align-items:center;gap:10px;padding:9px 12px calc(9px + env(safe-area-inset-bottom));background:radial-gradient(120% 220% at 6% 0%,rgba(96,214,255,.20),transparent 55%),radial-gradient(120% 220% at 100% 100%,rgba(200,110,255,.16),transparent 55%),linear-gradient(160deg,#12101d,#191325 60%,#140f1e);border-top:1px solid rgba(255,255,255,.08);box-shadow:0 -4px 18px rgba(5,0,15,.35)}
  .stickyAd img{width:38px;height:38px;flex-shrink:0;filter:drop-shadow(0 0 8px rgba(120,210,255,.4))}
  .stickyAd .sa-body{flex:1;min-width:0}
  .stickyAd .sa-title{font-size:.8em;font-weight:800;color:#fff;line-height:1.25}
  .stickyAd .sa-desc{font-size:.68em;color:#b9b6c9;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .stickyAd .sa-btn{flex-shrink:0;background:linear-gradient(135deg,var(--gold2),var(--gold));color:#3a2a06;font-weight:800;font-size:.76em;padding:8px 14px;border-radius:18px;white-space:nowrap;text-decoration:none}
  @media(max-width:420px){.stickyAd .sa-desc{display:none}}
</style>
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

// フッターの恒久内部リンク行。レジストリの全大会を会期の古い順に並べる。
// ★ これは日付で消えてはいけない(SEOのクロール経路・内部リンク評価の土台)。
//   「大会特集」(=その日1件・JS描画)とは役割が別物なので、片方を理由にもう片方を消さないこと。
//   リンク先は featureUrl。静的ページがある大会は静的URL、無い大会(FST等)はトップのハッシュURLになる。
//   レジストリに1エントリ足せばこの行にも自動で増える。
// ★ トップ(index.html)の #evtLinks もこの同じ関数から作る(buildIndexHtml)。
//   2箇所を別々に手で書いていた頃に、片方だけ直して片方を忘れる事故が2回起きているため。
const LINK_SEP = '　|　';
function permanentEventLinksList() {
  return BIG.BIG_EVENTS
    .slice()
    .sort((a, b) => String(BIG.eventFirstDay(a.days)).localeCompare(String(BIG.eventFirstDay(b.days))))
    .map(e => ({ url: e.featureUrl, label: esc(e.label) }));
}
function permanentEventLinks(currentPath) {
  return permanentEventLinksList()
    .map(e => e.url === currentPath
      // 自分自身のページでは自己リンクにせず現在地として示す
      ? `<span aria-current="page" style="color:#cfd6d1">${e.label}</span>`
      : `<a href="${e.url}">${e.label}</a>`)
    .join(LINK_SEP);
}

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

// currentPath: そのページ自身のパス(自己リンクを避けるため)。省略すると全件がリンクになる。
function pageFoot(currentPath) {
  // 恒久リンク行(全大会・日付に関係なく常に出す)と、
  // 「大会特集」(掲載中の1件だけ・日によって変わるのでブラウザ側で判定)は【両方】出す。
  // 後者は生成時に焼き込まない(静的ページは再生成しない限り更新されず、古い大会が残り続けるため)。
  return `</main>
<footer>
  <div><b style="color:#fff">ふくおかポーカーナビ</b> — 福岡ポーカートーナメント日程アグリゲーター</div>
  <div style="margin-top:6px"><a href="/">トップ</a>　|　${permanentEventLinks(currentPath)}</div>
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
</body>
</html>`;
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

// ---- sitemap ----
function buildSitemap() {
  const urls = [
    { loc: `${SITE}/`, freq: 'daily', pri: '1.0' },
    { loc: `${SITE}/events/nippon-series-2026-fukuoka/`, freq: 'daily', pri: '0.8' },
    { loc: `${SITE}/events/jopt-2026-fukuoka-01/`, freq: 'daily', pri: '0.8' },
    // FSTは個別トーナメントが未発表で、更新はレア。発表されたら daily / 0.8 に上げる。
    { loc: `${SITE}/events/fst-2026-fukuoka/`, freq: 'weekly', pri: '0.7' },
    { loc: `${SITE}/events/wjpt-2026/`, freq: 'monthly', pri: '0.3' },
  ];
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

// ---- 書き出し / 検査 ----
// 出力はいったん全部メモリ上で組み立ててから、まとめて書く(--check のときは書かずに突き合わせる)。
// --check は「big-events.js を直したのに再生成を忘れた」「生成物を手で書き換えた」を検出するためのもの。
const files = {
  'events/jopt-2026-fukuoka-01/index.html': buildJopt(),
  'events/wjpt-2026/index.html': buildWjpt(),
  'events/nippon-series-2026-fukuoka/index.html': buildNippon(),
  'events/fst-2026-fukuoka/index.html': buildFst(),
  'sitemap.xml': buildSitemap(),
  'index.html': buildIndexHtml()      // 恒久リンク行(#evtLinks)だけを差し替えたもの
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
