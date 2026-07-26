#!/usr/bin/env node
/**
 * gen-event-pages.js
 *
 * 検索流入用に、大型イベント(JOPT / WJPT)のクローラブルな静的ページを生成する。
 * SPAのハッシュURL(#jopt 等)は個別ページとしてインデックスされないため、
 * /events/<slug>/index.html という実URLの静的ページを用意する。
 *
 * データは既存の検証済みソースからそのまま読み込む(数値を手打ちしない):
 *   - JOPT: jopt-data.js (window.JOPT_DATA / module.exports)
 *   - WJPT: index.html 内の const WJPT = {...} を抽出
 *
 * 生成物:
 *   - events/jopt-2026-fukuoka-01/index.html
 *   - events/wjpt-2026/index.html
 *   - sitemap.xml (ホーム + 各イベントページ)
 *
 * 使い方: node gen-event-pages.js <リポジトリのパス>
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.argv[2];
if (!REPO) { console.error('リポジトリのパスを指定してください'); process.exit(1); }

const SITE = 'https://fukuokapoker.com';
const TODAY = process.argv[3] || null; // 生成日(アーカイブ判定・"時点"表記用)。未指定なら呼び出し側で渡す

// ---- データ読み込み ----
const JOPT = require(path.join(REPO, 'jopt-data.js'));

function extractWJPT(indexHtml) {
  const src = fs.readFileSync(indexHtml, 'utf8');
  const m = src.match(/const WJPT = (\{[\s\S]*?\n  \});/);
  if (!m) throw new Error('index.html から WJPT を抽出できませんでした');
  const sandbox = {};
  vm.createContext(sandbox);
  return vm.runInContext('(' + m[1] + ')', sandbox);
}
const WJPT = extractWJPT(path.join(REPO, 'index.html'));

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

function pageFoot() {
  return `</main>
<footer>
  <div><b style="color:#fff">ふくおかポーカーナビ</b> — 福岡ポーカートーナメント日程アグリゲーター</div>
  <div style="margin-top:6px"><a href="/">トップ</a>　|　<a href="/events/jopt-2026-fukuoka-01/">JOPT 2026 福岡</a>　|　<a href="/events/wjpt-2026/">WJPT 2026</a>　|　<a href="/contact.html">お問い合わせ</a>　|　<a href="/privacy.html">プライバシーポリシー</a></div>
</footer>
<div class="stickyAd">
  <img src="/img/jopt/jopt-banner.jpg" alt="" width="38" height="38" style="object-fit:cover;border-radius:8px">
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
  return pageHead({ title, desc, canonical, jsonld }) + body + pageFoot();
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
  return pageHead({ title, desc, canonical, jsonld, image: (WJPT.banner || 'img/wjpt/wjpt-banner.jpg') }) + body + pageFoot();
}

// ---- sitemap ----
function buildSitemap() {
  const urls = [
    { loc: `${SITE}/`, freq: 'daily', pri: '1.0' },
    { loc: `${SITE}/events/jopt-2026-fukuoka-01/`, freq: 'daily', pri: '0.8' },
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

// ---- 書き出し ----
function writeFile(rel, content) {
  const p = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  console.log('生成:', rel, `(${content.length} bytes)`);
}

writeFile('events/jopt-2026-fukuoka-01/index.html', buildJopt());
writeFile('events/wjpt-2026/index.html', buildWjpt());
writeFile('sitemap.xml', buildSitemap());
console.log('完了。JOPT', JOPT.tournaments.length, '件 / WJPT', WJPT.tournaments.length, '件');
