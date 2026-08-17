#!/usr/bin/env node
/**
 * gen-area-pages.js
 *
 * 検索流入用に、エリアごとのクローラブルな静的ページ(/areas/<slug>/)を生成する。
 * 狙いは「天神 ポーカー」「小倉 ポーカー」「久留米 ポーカー」のような【地名だけで探す】検索。
 * 店名を知らない人の入口で、店舗ページ(/venues/<slug>/)では取りにいけない層にあたる。
 *
 * 【どのエリアにページを作るか / sitemap に載せるか】
 *   判定はどちらも tools/area-schedule.js が所有する(ページ生成と sitemap で基準を分けない)。
 *     - ページを作る … そのエリアに2店舗以上ある(1店だとその店の店舗ページとほぼ同じ内容になる)
 *     - sitemap     … さらに掲載中の日程が1件以上ある(店舗ページと同じ扱い)
 *
 * 【日程はハイブリッド】
 *   gen-venue-pages.js と同じ。静的HTMLに焼き込む + 閲覧時に /data.js を読み直して描き直す。
 *   静的だけだと再生成を忘れた月に古い内容が残り、JSだけだとクローラに日程が1件も見えない。
 *   表を組み立てるコードは area-schedule.js の AREA_SCHEDULE_JS 1本で、
 *   生成時(Node・vm)と閲覧時(ブラウザ)で共有する。
 *
 * 【焼き込む内容を「今日以降」にしない理由】
 *   実行した日から先を焼くと、data.js を1文字も触っていないのに翌日には --check が落ちる。
 *   静的側は area-schedule.js の areaRange() が返す固定の期間をそのまま焼く
 *   (gen-venue-pages.js と同じ考え方)。
 *
 * 【エリアから消えた/2店舗を割ったエリアのページ(孤児)は消す】
 *   店が閉店して1店だけになったエリアのページは、条件を満たさなくなった時点で削除する。
 *   放っておくと更新されないページが公開・インデックスされ続ける(gen-venue-pages.js と同じ理由)。
 *
 * 生成物:
 *   - areas/<slug>/index.html
 *   - index.html の【エリアリンク行(#areaLinks)だけ】を上書き同期する
 *   - sitemap.xml … 中身は tools/gen-sitemap.js が決める。ここでは組み立てず、そのまま書くだけ。
 *
 * 使い方:
 *   node gen-area-pages.js <リポジトリのパス>            … 生成/同期する
 *   node gen-area-pages.js <リポジトリのパス> --check     … 書き込まず、ディスクの内容と一致するかだけ見る
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
const REPO = path.resolve(REPO_ARG);

const shell = require('./site-shell.js');
const { SITE, POSITIONING, esc, pageHead, pageFoot } = shell;
const { sitemapFile } = require('./gen-sitemap.js');
const { SCHEDULE_JS } = require('./venue-schedule.js');
const {
  AREA_SLUGS, AREA_SCHEDULE_JS, AREA_SCHED,
  areaVenues, areaList, validateAreaSlugs, areaRange
} = require('./area-schedule.js');

// ---- データ読み込み ----
const DATA = require(path.join(REPO, 'data.js'));
const BIG = require(path.join(REPO, 'big-events.js'));
const { VENUES, TOURNAMENTS, RECURRING, AREAS } = DATA;

// slug の欠け・重複は生成前に止める(公開後に気づくとURLの付け替え=被リンクの喪失になる)。
shell.validateVenueSlugs(VENUES);
validateAreaSlugs(VENUES, AREAS);

const PAGE_AREAS = areaList(VENUES, AREAS);

const AREA_CSS = `  .vp-sub{font-size:.9em;color:var(--mut);margin-bottom:14px}
  h2.vp-sec{font-size:1.05em;font-weight:800;color:var(--felt);margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--gold)}
  h3.vp-day{font-size:.95em;font-weight:800;color:var(--felt);margin:16px 0 7px}
  .vp-empty{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:18px 15px;font-size:.88em;color:var(--mut);text-align:center;line-height:1.9}
  .vp-tags{color:var(--mut);font-size:.9em}
  .vp-warn{color:var(--red);font-size:.9em;font-weight:700}
  .vp-recur{display:inline-block;background:#eef3f1;border:1px solid var(--bor);color:var(--felt);font-size:.8em;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:5px}
  .ap-venue a{color:#0e6a72;font-weight:700;text-decoration:none}
  .ap-cards{display:grid;gap:10px;margin:4px 0 6px}
  .ap-card{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:12px 14px}
  .ap-card .nm{font-weight:800;font-size:.98em}
  .ap-card .nm a{color:var(--felt);text-decoration:none}
  .ap-card .mt{font-size:.84em;color:var(--mut);line-height:1.8;margin-top:3px}
  ul.vp-list{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px}
  ul.vp-list a{display:inline-block;background:var(--sur);border:1px solid var(--bor);border-radius:20px;padding:6px 13px;font-size:.85em;font-weight:700;color:var(--felt);text-decoration:none;box-shadow:var(--sha)}
`;

/**
 * パンくずの構造化データ。
 * 【LocalBusiness を出さない理由】このページは特定の事業所ではなく複数店の集約で、
 *   ItemList で店を並べることもできるが、当サイトは各店の運営者ではないため
 *   店の情報の断定は店舗ページ(1店1ページ)側に集約しておく。ここは階層だけを伝える。
 */
function breadcrumbJsonLd(area, canonical) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ふくおかポーカーナビ', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: `${area}のポーカー店`, item: canonical }
    ]
  };
}

function venueCards(venues) {
  return venues.map(v => {
    const meta = [];
    if (v.access) meta.push(esc(v.access));
    if (v.address) meta.push(esc(v.address));
    // 未開店の店は一覧に出しつつ、営業中と読めないように印を付ける(店舗ページ側と同じ扱い)。
    const tag = v.preopen ? '<span class="vp-recur">オープン予定</span>' : '';
    return `  <div class="ap-card">
    <div class="nm"><a href="/venues/${v.slug}/">${esc(v.name)}</a>${tag}</div>
    ${meta.length ? `<div class="mt">${meta.join('<br>')}</div>` : ''}
  </div>`;
  }).join('\n');
}

function buildArea(area) {
  const slug = AREA_SLUGS[area];
  const canonical = `${SITE}/areas/${slug}/`;
  const venues = areaVenues(VENUES, area);

  const RANGE = areaRange(TOURNAMENTS, venues);
  const rows = RANGE ? AREA_SCHED.apRows(TOURNAMENTS, RECURRING, venues, RANGE.from, RANGE.to) : [];
  const schedHtml = AREA_SCHED.apScheduleHtml(rows);

  // ★ title / description は「掲載日程があるか」で切り替える(店舗ページと同じ理由)。
  //   0件のエリアで「日程を日付順に掲載」と書くと、検索結果に出る文が中身と一致しない。
  //   判定に「今日」を使わないのも同じ理由(実行日で分岐すると翌日に --check が落ちる)。
  let title, desc, sub;
  if (rows.length) {
    title = `${area}のポーカートーナメント日程・ポーカー店一覧（${venues.length}店舗） | ふくおかポーカーナビ`;
    desc = `${area}のアミューズメントポーカー${venues.length}店舗のトーナメント日程を、店舗をまたいで日付順にまとめています。`
      + `開始時刻・バイイン・各店のアクセスをまとめて確認できます。`;
    sub = `${esc(area)}のポーカー店${venues.length}店舗 — トーナメント日程・バイイン・アクセス`;
  } else {
    title = `${area}のポーカー店一覧（${venues.length}店舗） | ふくおかポーカーナビ`;
    desc = `${area}のアミューズメントポーカー${venues.length}店舗の所在地・アクセス・公式SNSをまとめています。`
      + `現時点で当サイトに掲載中の開催予定はありません。最新の開催情報は各店舗の公式情報・SNSをご確認ください。`;
    sub = `${esc(area)}のポーカー店${venues.length}店舗 — 所在地・アクセス・開催情報`;
  }

  // 他のエリアへの内部リンク。エリア間を横に繋いで、どのエリアページからも全エリアに辿れるようにする。
  const others = PAGE_AREAS.filter(a => a !== area);
  const otherBlock = others.length ? `
<h2 class="vp-sec">ほかのエリアのポーカー店</h2>
<ul class="vp-list">
${others.map(a => `  <li><a href="/areas/${AREA_SLUGS[a]}/">${esc(a)}（${areaVenues(VENUES, a).length}店舗）</a></li>`).join('\n')}
</ul>` : '';

  // 日程表の見出しと但し書き。静的HTMLは再生成しない限り残るので、時間が経っても嘘にならない文にする
  // (gen-venue-pages.js の同じ箇所の原則にそろえてある)。
  const NOTE_JS_TAIL = 'JavaScriptが有効な環境では、読み込み時に最新の掲載データから<b>今日以降</b>の日程に差し替わります。';
  const schedTitle = RANGE ? `トーナメント日程（${esc(RANGE.label)}の掲載分）` : 'トーナメント日程';
  const schedNote = RANGE
    ? `※ この一覧は${esc(RANGE.label)}の掲載分です。${NOTE_JS_TAIL}`
    : `※ ${NOTE_JS_TAIL}`;

  const body = `
<h1>${esc(area)}のポーカートーナメント日程</h1>
<p class="vp-sub">${sub}</p>
<div class="disclaimer">当サイトは店舗が公開している情報を集約している媒体で、掲載店舗の運営者ではありません。日程・料金・営業状況は変更されることがあるため、参加前に必ず各店舗の公式情報・SNSをご確認ください。<br>${POSITIONING}</div>
<h2 class="vp-sec">${esc(area)}のポーカー店（${venues.length}店舗）</h2>
<div class="ap-cards">
${venueCards(venues)}
</div>
<h2 class="vp-sec" id="ap-sched-title">${schedTitle}</h2>
<p class="lead" id="ap-sched-note">${schedNote}</p>
<div id="ap-sched">${schedHtml}</div>${otherBlock}
<div class="links">
  ▶ <a href="/">福岡のポーカートーナメント日程を日付順に見る（全${VENUES.length}店舗）</a>
</div>`;

  // 閲覧時の描き直し。/data.js を読み直して「今日以降」に差し替える(店舗ページと同じ作り)。
  const venueRefs = JSON.stringify(venues.map(v => ({ id: v.id, name: v.name, slug: v.slug })));
  const scripts = `<script src="/recurring-dedupe.js"></script>
<script src="/data.js"></script>
<script>
${SCHEDULE_JS}${AREA_SCHEDULE_JS}
/* 生成時に焼き込んだ日程を、いま読み込んだ data.js の内容で描き直す。
   月次の日程入力のあとにエリアページを再生成し忘れても閲覧者には最新が出る。
   ただしクローラが見るのは静的HTMLなので、再生成は必要。 */
(function(){
  if (typeof TOURNAMENTS === 'undefined' || typeof RECURRING === 'undefined') return;
  /* recurring-dedupe.js が読めていないときは描き直さない(店舗ページと同じ。描き直すと
     生成時に間引いた「自動取込と重複する定期開催」が閲覧時だけ復活する)。 */
  if (typeof RecurringDedupe === 'undefined') return;
  var el = document.getElementById('ap-sched');
  if (!el) return;
  var n = new Date();
  var pad = function(x){ return String(x).padStart(2, '0'); };
  var today = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  var last = today;
  for (var i = 0; i < TOURNAMENTS.length; i++) {
    if (TOURNAMENTS[i].date > last) last = TOURNAMENTS[i].date;
  }
  var plus60 = vpToIso(vpParse(today) + 60 * 86400000);
  var rows = apRows(TOURNAMENTS, RECURRING, ${venueRefs}, today, last > plus60 ? last : plus60);
  el.innerHTML = apScheduleHtml(rows);
  var t = document.getElementById('ap-sched-title');
  if (t) t.textContent = '今後のトーナメント日程（' + rows.length + '件）';
  var note = document.getElementById('ap-sched-note');
  if (note && note.parentNode) note.parentNode.removeChild(note);
})();
</script>
`;

  return pageHead({
    title, desc, canonical,
    jsonld: breadcrumbJsonLd(area, canonical),
    noImage: true,
    ogType: 'website',
    twitterCard: 'summary',
    extraCss: AREA_CSS
  }) + body + pageFoot(BIG, null, scripts);
}

// ---- トップページ(index.html)のエリアリンク行(#areaLinks)を同期する ----
// 【なぜ必要か】店舗リンク行(#venueLinks)と同じ理由。JSを実行しないクローラに
//   /areas/<slug>/ へのリンクが見えないと、クロール経路が sitemap だけになる。
//   ★ 中身は自動生成。エリアが2店舗に達すれば自動で増える。
const INDEX_LINKS_PREFIX = 'エリア別: ';
// 置換対象は「行頭にある <div id="areaLinks" …>…</div> の1行」だけ。
// 行頭アンカー(^ + m)は必須(#venueLinks の同じ箇所のコメントを参照。
// これが無いと説明用にコメント内へ書いた同じ文字列にまで当たって壊す)。
const INDEX_LINKS_RE = /^(\s*<div id="areaLinks"[^>]*>)([^\n]*?)(<\/div>)$/m;
const INDEX_LINKS_RE_G = new RegExp(INDEX_LINKS_RE.source, 'gm');

function areaLinksRow() {
  return PAGE_AREAS
    .map(a => `<a href="/areas/${AREA_SLUGS[a]}/">${esc(a)}</a>`)
    .join('・');
}

function buildIndexHtml() {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const hits = src.match(INDEX_LINKS_RE_G) || [];
  if (hits.length !== 1) {
    throw new Error(`index.html のエリアリンク行(<div id="areaLinks">…</div>)が ${hits.length} 件見つかりました。`
      + '1件だけ、独立した1行として置いてください（トップのエリアリンク行を同期できません）。');
  }
  return src.replace(INDEX_LINKS_RE, (_m, open, _inner, close) =>
    open + INDEX_LINKS_PREFIX + areaLinksRow() + close);
}

// ---- 検査 ----
function verify(files) {
  const problems = [];
  PAGE_AREAS.forEach(a => {
    const rel = `areas/${AREA_SLUGS[a]}/index.html`;
    if (!files[rel]) problems.push(`${a}: ${rel} が生成物に含まれていない`);
  });
  const im = files['index.html'].match(INDEX_LINKS_RE);
  if (!im) problems.push('index.html: #areaLinks が見つからない');
  else {
    const inner = im[2];
    if (inner.indexOf(INDEX_LINKS_PREFIX) !== 0) problems.push('index.html: #areaLinks の見出し文字列が想定と違う');
    const linked = (inner.match(/href="\/areas\/[^"]+\/"/g) || []).length;
    if (linked !== PAGE_AREAS.length) {
      problems.push(`index.html #areaLinks のリンク数が ${linked} 件（対象エリアは ${PAGE_AREAS.length} 件）`);
    }
  }
  if (problems.length) {
    console.error('\n✗ エリアページの生成物が data.js と一致しません:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('検査: エリアページ' + PAGE_AREAS.length + '件・トップのエリアリンク行は data.js と一致');
}

// ---- 条件を満たさなくなったエリアのページ(孤児) ----
const AREAS_DIR = 'areas';

function findOrphanAreaDirs() {
  let entries;
  try {
    entries = fs.readdirSync(path.join(REPO, AREAS_DIR), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];   // まだ1件も生成していない
    throw e;
  }
  const known = new Set(PAGE_AREAS.map(a => AREA_SLUGS[a]));
  return entries
    .filter(e => e.isDirectory() && !known.has(e.name))
    .map(e => e.name)
    .sort();
}

// 中身が index.html だけのディレクトリは生成物とみなして削除してよい(店舗ページと同じ扱い)。
function orphanExtraFiles(name) {
  return fs.readdirSync(path.join(REPO, AREAS_DIR, name))
    .filter(f => f !== 'index.html' && f !== '.DS_Store');
}

// ---- 書き出し / 検査 ----
const files = {};
PAGE_AREAS.forEach(a => { files[`areas/${AREA_SLUGS[a]}/index.html`] = buildArea(a); });
files['index.html'] = buildIndexHtml();   // エリアリンク行(#areaLinks)だけを差し替えたもの
Object.assign(files, sitemapFile(REPO));

verify(files);

const orphans = findOrphanAreaDirs();
if (orphans.length) {
  console.log(`エリアページの条件を満たさないディレクトリ ${orphans.length} 件:`);
  orphans.forEach(name => {
    const extra = orphanExtraFiles(name);
    console.log(`  - ${AREAS_DIR}/${name}/`
      + (extra.length ? `（index.html 以外のファイルあり: ${extra.join(', ')}）` : ''));
  });
}

if (CHECK) {
  const stale = Object.keys(files).filter(rel => {
    let cur = null;
    try { cur = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (e) { /* 未生成 */ }
    return cur !== files[rel];
  });
  let ng = false;
  if (stale.length) {
    console.error('\n✗ 生成物が data.js と一致しません（node tools/gen-area-pages.js <repo> を実行してください）:\n  - ' + stale.join('\n  - '));
    ng = true;
  }
  if (orphans.length) {
    console.error('\n✗ 条件を満たさないエリアページが残っています（node tools/gen-area-pages.js <repo> を実行すると削除されます）:\n  - '
      + orphans.map(name => `${AREAS_DIR}/${name}/`).join('\n  - '));
    ng = true;
  }
  if (ng) process.exit(1);
  console.log('検査: 生成物はすべて最新（' + Object.keys(files).length + 'ファイル）／ 余分なエリアディレクトリなし');
} else {
  const kept = [];
  let removed = 0;
  orphans.forEach(name => {
    if (orphanExtraFiles(name).length) { kept.push(name); return; }
    fs.rmSync(path.join(REPO, AREAS_DIR, name), { recursive: true });
    removed++;
  });

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
  console.log(`完了。エリアページ ${PAGE_AREAS.length} 件／ 書き換えたファイル ${wrote} 件`
    + (removed ? `／ 削除したエリアディレクトリ ${removed} 件` : ''));

  if (kept.length) {
    console.error('\n✗ 次のディレクトリは index.html 以外のファイルを含むため削除していません。'
      + '中身を確認して手で削除してください（残っている間 --check は落ちます）:\n  - '
      + kept.map(name => `${AREAS_DIR}/${name}/`).join('\n  - '));
    process.exit(1);
  }
}
