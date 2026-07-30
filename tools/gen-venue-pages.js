#!/usr/bin/env node
/**
 * gen-venue-pages.js
 *
 * 検索流入用に、掲載店舗ごとのクローラブルな静的ページを生成する。
 * SPAのハッシュURL(#venue/v41 等)は独立したURLとして扱われずインデックスされないため、
 * /venues/<slug>/index.html という実URLのページを用意する。
 * 狙いは「行橋 ポーカー」「折尾 ポーカー」「大名 ポーカー」のような、
 * トップページ1枚では取りにいけない地域×店名のロングテール。
 *
 * データは data.js からそのまま読み込む(数値・住所を手打ちしない)。
 *   - VENUES     … 店舗情報。URLは各店の "slug"(data.js のヘッダーコメントを参照)
 *   - TOURNAMENTS… 日付つきトーナメント
 *   - RECURRING  … 毎週固定の定期トーナメント(その場で日付に展開する)
 *
 * 【日程はハイブリッド】
 *   静的HTMLに焼き込む + 閲覧時に /data.js を読み直してクライアント側で描き直す。
 *   - 静的だけ … 月次の日程入力(data.js更新)のたびに再生成しないと内容が古くなる
 *   - JSだけ   … JSを実行しないクローラに日程が1件も見えない
 *   どちらも困るので両方やる。表を組み立てるコードは SCHEDULE_JS 1本だけを持ち、
 *   生成時(Node・vmで読み込む)と閲覧時(ブラウザ・そのまま埋め込む)で共有する。
 *
 * 【焼き込む内容を「今日以降」にしない理由】
 *   静的HTMLに「実行した日から先」を焼くと、data.js を1文字も触っていないのに
 *   翌日には --check が落ちる。検査が毎日落ちるなら検査を見なくなるので、
 *   静的側は data.js に載っている期間(下記 dataRange)をそのまま焼く。
 *   閲覧者に出す「今日以降」への絞り込みはブラウザ側の描き直しが担当する。
 *
 * 【data.js から消えた店のページ(孤児)は消す】
 *   閉店・掲載終了で VENUES から店を削除すると、sitemap からはURLが消えるが
 *   venues/<slug>/index.html はディスクに残る。放っておくと LocalBusiness の
 *   構造化データ付きページが更新されないまま公開・インデックスされ続けるので、
 *   VENUES の slug 集合に無い venues/ 直下のディレクトリを検出して削除する
 *   (--check では非ゼロ終了)。
 *   詳細は下の findOrphanVenueDirs() のコメントを参照。
 *
 * 生成物:
 *   - venues/<slug>/index.html (全店)
 *   - index.html の【店舗リンク行(#venueLinks)だけ】を上書き同期する
 *       … このスクリプトが index.html を触るのはこの1行だけ。他の箇所には一切手を出さない。
 *   - sitemap.xml … 中身は tools/gen-sitemap.js が決める。ここでは組み立てず、そのまま書くだけ。
 *
 * 使い方:
 *   node gen-venue-pages.js <リポジトリのパス>            … 生成/同期する
 *   node gen-venue-pages.js <リポジトリのパス> --check     … 書き込まず、ディスクの内容と一致するかだけ見る
 *                                                          (一致しなければ非ゼロ終了。CI・レビュー用)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
// path.join('.', 'data.js') は 'data.js' に正規化され、require() がパッケージ名として
// 解決しようとして失敗する。受け取ったパスは必ず絶対パスに直す。
const REPO = path.resolve(REPO_ARG);

const shell = require('./site-shell.js');
const { SITE, POSITIONING, esc, pageHead, pageFoot } = shell;
// sitemap.xml の唯一の所有者。中身はここでは組み立てず、丸ごと受け取って書くだけ。
const { sitemapFile } = require('./gen-sitemap.js');

// ---- データ読み込み ----
const DATA = require(path.join(REPO, 'data.js'));
const BIG = require(path.join(REPO, 'big-events.js'));
const { VENUES, TOURNAMENTS, RECURRING, AREAS } = DATA;

// slug が欠けている/重複している/使えない文字を含む場合はここで落ちる。
// 生成してから気づくとURLの付け替え=被リンクの喪失になるため、生成前に止める。
shell.validateVenueSlugs(VENUES);

// ---- 「未確認」の印(addressUnverified / telUnverified)と note の食い違いを止める ----
// 【なぜ必要か】
//   確度の低い住所・電話を JSON-LD から落とす判定は data.js のフラグが持つ(下の venueJsonLd)。
//   一方、読者向けのヘッジは note の文章が持つ。この2つは別々に書かれるので、店を追加した人が
//   note にだけ「住所は要確認」と書いてフラグを付け忘れると、【表示は留保・構造化データは断定】
//   という、今回まさに直した状態にそのまま戻る。しかもその壊れ方は画面を見ても分からない。
//   そこで「note が住所/電話の未確認に言及しているのにフラグが無い」場合は生成せずに落とす。
//   ★ 判定そのものを note の文字列マッチで行っているわけではない(それは脆い)。
//     出力を決めるのはあくまでフラグで、ここは【書き忘れを人間に知らせるための検査】。
// 【address が空の店を対象外にする理由】
//   RAISE BLUE 天神は住所データ自体を持たず note に「住所は未確認。」と書いてある。
//   出すべき streetAddress がそもそも無いのでフラグは不要(付けても意味がない)。
const UNVERIFIED_CHECKS = [
  { flag: 'addressUnverified', field: 'address', re: /住所[^。]*(要確認|未確認)/ },
  { flag: 'telUnverified',     field: 'tel',     re: /電話[^。]*(要確認|未確認)/ }
];
function validateUnverifiedFlags(venues) {
  const problems = [];
  venues.forEach(v => {
    UNVERIFIED_CHECKS.forEach(c => {
      if (!v[c.field] || v[c.flag]) return;
      if (c.re.test(v.note || '')) {
        problems.push(`${v.id} ${v.name}: note が${c.field === 'tel' ? '電話' : '住所'}の未確認に言及していますが `
          + `"${c.flag}": true がありません（data.js に足すか、裏が取れたなら note のヘッジを外してください）`);
      }
    });
  });
  if (problems.length) {
    throw new Error('店舗データの「未確認」の印が note と食い違っています:\n  - ' + problems.join('\n  - '));
  }
}
validateUnverifiedFlags(VENUES);

// ---- 日程表の組み立て(生成時と閲覧時で共有する1本) ----
// SCHEDULE_JS / SCHED / dataRange は tools/venue-schedule.js が所有する。
// 【なぜ切り出したか】gen-sitemap.js が「掲載0件の店」を判定して sitemap から外す。
//   その判定基準がこちらと2箇所に分かれるとズレて、「sitemapには載っているのに中身は空」
//   あるいはその逆が起きるため、判定を1箇所に寄せた。
const { SCHEDULE_JS, SCHED, dataRange, hasSchedule } = require('./venue-schedule.js');

const RANGE = dataRange(TOURNAMENTS);

// ---- 店舗ページ本体 ----
const VENUE_CSS = `  .vp-sub{font-size:.9em;color:var(--mut);margin-bottom:14px}
  h2.vp-sec{font-size:1.05em;font-weight:800;color:var(--felt);margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--gold)}
  h3.vp-day{font-size:.95em;font-weight:800;color:var(--felt);margin:16px 0 7px}
  .vp-empty{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:18px 15px;font-size:.88em;color:var(--mut);text-align:center;line-height:1.9}
  .vp-tags{color:var(--mut);font-size:.9em}
  .vp-warn{color:var(--red);font-size:.9em;font-weight:700}
  .vp-recur{display:inline-block;background:#eef3f1;border:1px solid var(--bor);color:var(--felt);font-size:.8em;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:5px}
  .evt-meta a{color:#0e6a72;font-weight:700}
  ul.vp-list{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px}
  ul.vp-list a{display:inline-block;background:var(--sur);border:1px solid var(--bor);border-radius:20px;padding:6px 13px;font-size:.85em;font-weight:700;color:var(--felt);text-decoration:none;box-shadow:var(--sha)}
`;

// 住所を PostalAddress に分解する。data.js の address 文字列を機械的に切るだけで、
// 無い情報は足さない(市区町村が読み取れなければ addressLocality を出さない)。
// addressRegion は当サイトが福岡県内の店舗だけを扱うため常に福岡県。
function addressParts(address) {
  const a = String(address).replace(/^福岡県/, '');
  const m = a.match(/^(.+?[市郡])/);
  if (!m) return { street: a, locality: null };
  return { street: a.slice(m[1].length), locality: m[1] };
}

function venueJsonLd(v) {
  // ★ data.js に無い項目は出さない。空文字を "" のまま出すと、
  //   検索エンジンに「値が無い」ではなく「空という値」を渡すことになる。
  // ★ 裏が取れていない項目も出さない(addressUnverified / telUnverified)。
  //   ページの表示テキストでは note のヘッジ付きで出しているのに、構造化データでは
  //   同じ値を断定として渡していた。読者には「要確認」と伝えながら Google には
  //   確定情報として渡すのは、READMEの編集方針(根拠の弱い情報は確度の差が伝わる形で出す)に反する。
  const j = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: v.name
  };
  if (v.address) {
    const p = addressParts(v.address);
    const addr = { '@type': 'PostalAddress' };
    if (p.locality) addr.addressLocality = p.locality;
    // 落とすのは streetAddress(丁目・番地・ビル名・部屋番号)だけで、address ブロックごとは落とさない。
    //   - 実害があるのは番地レベルの誤り(無関係な建物・部屋を訪ねさせる)。市区町村までの粒度なら
    //     当サイトが独立に持っている area / access(最寄駅)と突き合わせて裏が取れている
    //     (例: 中洲エリア・中洲川端駅徒歩1分 ⇔ 福岡市博多区)。
    //   - LocalBusiness にとって address は Google が必須とする項目で、ブロックごと落とすと
    //     「不正確な住所」ではなく「住所の無い事業所」になり、エラー扱いになる。
    //     市区町村＋県だけを残すのが「嘘をつかず、かつ壊さない」最小の落とし方。
    if (p.street && !v.addressUnverified) addr.streetAddress = p.street;
    addr.addressRegion = '福岡県';
    addr.addressCountry = 'JP';
    j.address = addr;
  }
  if (v.tel && !v.telUnverified) j.telephone = v.tel;
  // url は店舗自身のサイト。持っていない店では出さない。
  if (v.website) j.url = v.website;
  const sameAs = [v.x, v.instagram, v.threads, v.line].filter(Boolean);
  if (sameAs.length) j.sameAs = sameAs;
  return j;
}

function metaRows(v) {
  const rows = [];
  rows.push(`<b>エリア</b>　${esc(v.area)}`);
  if (v.address) rows.push(`<b>住所</b>　${esc(v.address)}`);
  if (v.access) rows.push(`<b>アクセス</b>　${esc(v.access)}`);
  if (v.tel) rows.push(`<b>電話</b>　<a href="tel:${esc(v.tel.replace(/[^0-9+]/g, ''))}">${esc(v.tel)}</a>`);
  if (v.website) rows.push(`<b>公式サイト</b>　<a href="${esc(v.website)}" target="_blank" rel="noopener">${esc(v.website)}</a>`);
  const sns = [];
  if (v.x) sns.push(`<a href="${esc(v.x)}" target="_blank" rel="noopener">X</a>`);
  if (v.instagram) sns.push(`<a href="${esc(v.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (v.threads) sns.push(`<a href="${esc(v.threads)}" target="_blank" rel="noopener">Threads</a>`);
  if (v.line) sns.push(`<a href="${esc(v.line)}" target="_blank" rel="noopener">公式LINE</a>`);
  if (sns.length) rows.push(`<b>SNS</b>　${sns.join('　／　')}`);
  return rows.join('<br>\n  ');
}

function buildVenue(v) {
  const canonical = `${SITE}/venues/${v.slug}/`;

  const rows = SCHED.vpRows(TOURNAMENTS, RECURRING, v.id, RANGE.from, RANGE.to);
  const schedHtml = SCHED.vpScheduleHtml(rows);

  // ★ title / description / リード文は「掲載日程があるか」で切り替える。
  //   【なぜ必要か】無条件に「トーナメント日程」「日程を日付順に掲載」と書くと、掲載0件の店では
  //   検索結果に出る文が中身と一致しない。さらに note が「トーナメント開催は未確認」と書いている店で、
  //   同じページの中で当サイトのタイトルと当サイトの note が矛盾する。
  //   READMEの編集方針「第三者店舗の性質を当サイトの声で断定しない」に反するため、
  //   日程が無い店では「日程がある」と読める断定を出さない。
  //   【判定に「今日」を使わない理由】実行日で分岐すると、データを1文字も触っていないのに
  //   翌日には --check が落ちる。判定は日付独立な RANGE 内の行数で行う。
  //   データ駆動なので、日程が1件入れば自動で通常の文面に戻る(将来の手当ては不要)。
  // ★ 店名に既に「（エリア名）」が入っている店では、エリアを機械的に足すと二重になる。
  //   例: 「KENポーカー（久留米）」+「（久留米）」→「KENポーカー（久留米）（久留米）」が
  //   title / description / og:title / og:description の4箇所に出ていた(35件中1件)。
  //   店名に含まれるエリア名を素通しで判定(v.name.includes(v.area))すると
  //   「m HOLD'EM 中洲（中洲）」「RAISE BLUE 天神（天神）」等12件の文面まで変わってしまうため、
  //   【括弧付きの同一表記】が既にあるときだけ足さない、という判定にしてある
  //   (半角括弧の店名が来ても効くようにしている)。
  const areaInName = v.name.includes(`（${v.area}）`) || v.name.includes(`(${v.area})`);
  const titleName = areaInName ? v.name : `${v.name}（${v.area}）`;
  // description の括弧は「エリア／アクセス」。エリアが店名に入っているならアクセスだけを残す。
  const parenParts = [];
  if (!areaInName) parenParts.push(v.area);
  if (v.access) parenParts.push(v.access);
  const descName = parenParts.length ? `${v.name}（${parenParts.join('／')}）` : v.name;
  let title, desc, sub;
  if (v.preopen) {
    // 未開店の店。営業中と読める文面を出さない(JSON-LDのLocalBusinessも出さない)。
    title = `${titleName}｜オープン予定のポーカースポット | ふくおかポーカーナビ`;
    desc = `${descName}はオープン予定のポーカースポットです。`
      + `判明している開店時期と${v.address ? '所在地・' : ''}アクセス・公式SNSをまとめています。当サイトに掲載中の開催予定はまだありません。`;
    sub = `${esc(v.area)}のポーカースポット${v.access ? `（${esc(v.access)}）` : ''} — オープン予定`;
  } else if (rows.length) {
    title = `${titleName}のポーカートーナメント日程 | ふくおかポーカーナビ`;
    desc = `${descName}で開催されるポーカートーナメントの日程を日付順に掲載。`
      + `開始時刻・バイイン・スタックのほか、${v.address ? '住所・' : ''}アクセス・公式SNSもまとめて確認できます。`;
    sub = `${esc(v.area)}のポーカースポット${v.access ? `（${esc(v.access)}）` : ''} — トーナメント日程・バイイン・アクセス`;
  } else {
    title = `${titleName}｜住所・アクセス・トーナメント開催情報 | ふくおかポーカーナビ`;
    desc = `${descName}の${v.address ? '住所・' : ''}アクセス・公式SNSをまとめています。`
      + `現時点で当サイトに掲載中の開催予定はありません。最新の開催情報は店舗の公式情報・SNSをご確認ください。`;
    sub = `${esc(v.area)}のポーカースポット${v.access ? `（${esc(v.access)}）` : ''} — 住所・アクセス・開催情報`;
  }

  // 同じエリアの他店。内部リンクを増やしつつ、読者にとっても「近くの別の店」になる。
  const sameArea = VENUES.filter(x => x.area === v.area && x.id !== v.id);
  const areaBlock = sameArea.length ? `
<h2 class="vp-sec">同じエリア（${esc(v.area)}）の他のポーカー店</h2>
<ul class="vp-list">
${sameArea.map(x => `  <li><a href="/venues/${x.slug}/">${esc(x.name)}</a></li>`).join('\n')}
</ul>` : '';

  // ★ note は data.js の文面をそのまま出す。
  //   「住所は第三者情報のため要確認。」のような留保はREADMEの編集方針に沿って
  //   data.js 側で既に整えてあるので、生成スクリプトが要約・言い換えしてはいけない
  //   (ヘッジが落ちると読者が確度の差を知らないまま行動することになる)。
  const noteBlock = v.note ? `<b>${esc(v.name)}について</b>　${esc(v.note)}<br>` : '';
  const sourceBlock = (v.sourceUrl && v.sourceLabel)
    ? `主な情報源: <a href="${esc(v.sourceUrl)}" target="_blank" rel="noopener">${esc(v.sourceLabel)}</a>。`
    : '';

  const body = `
<h1>${esc(v.name)}</h1>
<p class="vp-sub">${sub}</p>
<div class="evt-meta">
  ${metaRows(v)}
</div>
<div class="disclaimer">${noteBlock}当サイトは店舗が公開している情報を集約している媒体で、この店舗の運営者ではありません。日程・料金・営業状況は変更されることがあるため、参加前に必ず店舗の公式情報・SNSをご確認ください。${sourceBlock}<br>${POSITIONING}</div>
<a class="cta" href="/#venue/${esc(v.id)}">▶ 月を切り替えて日程を見る<small>サイト内の月別カレンダー（前月・翌月に移動できます）</small></a>
<h2 class="vp-sec" id="vp-sched-title">トーナメント日程（${esc(RANGE.label)}の掲載分）</h2>
<p class="lead" id="vp-sched-note">※ この一覧は${esc(RANGE.label)}の掲載分です。JavaScriptが有効な環境では、読み込み時に最新の掲載データから<b>今日以降</b>の日程に差し替わります。</p>
<div id="vp-sched">${schedHtml}</div>${areaBlock}
<div class="links">
  ▶ <a href="/">福岡のポーカートーナメント日程を日付順に見る（全${VENUES.length}店舗）</a><br>
  ▶ <a href="/#venue/${esc(v.id)}">${esc(v.name)} の月別カレンダー</a>
</div>`;

  // 閲覧時の描き直し。/data.js を読み直して「今日以降」に差し替える。
  // 店舗ページで他社イベントのバナーをOGP画像に使うのは不適切なので noImage(トップと同じ扱い)。
  const scripts = `<script src="/data.js"></script>
<script>
${SCHEDULE_JS}
/* 生成時に焼き込んだ日程を、いま読み込んだ data.js の内容で描き直す。
   これがあるので、月次の日程入力(data.js更新)のあとに店舗ページを再生成し忘れても
   閲覧者には最新が出る。ただしクローラが見るのは静的HTMLなので、再生成は必要
   (README「data.jsを更新したら」を参照)。 */
(function(){
  if (typeof TOURNAMENTS === 'undefined' || typeof RECURRING === 'undefined') return;
  var el = document.getElementById('vp-sched');
  if (!el) return;
  var n = new Date();
  var pad = function(x){ return String(x).padStart(2, '0'); };
  var today = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  /* 定期トーナメントは日付を持たないので、どこまで先まで展開するかを決める必要がある。
     「掲載されている絶対日付の最終日」か「今日から60日後」の、遅いほうまで出す。 */
  var last = today;
  for (var i = 0; i < TOURNAMENTS.length; i++) {
    if (TOURNAMENTS[i].date > last) last = TOURNAMENTS[i].date;
  }
  var plus60 = vpToIso(vpParse(today) + 60 * 86400000);
  var rows = vpRows(TOURNAMENTS, RECURRING, ${JSON.stringify(v.id)}, today, last > plus60 ? last : plus60);
  el.innerHTML = vpScheduleHtml(rows);
  var t = document.getElementById('vp-sched-title');
  if (t) t.textContent = '今後のトーナメント日程（' + rows.length + '件）';
  var note = document.getElementById('vp-sched-note');
  if (note && note.parentNode) note.parentNode.removeChild(note);
})();
</script>
`;

  return pageHead({
    title, desc, canonical,
    // 未開店の店では LocalBusiness を出さない(営業中の事業所として宣言しないため)。
    jsonld: v.preopen ? null : venueJsonLd(v),
    noImage: true,
    ogType: 'website',
    twitterCard: 'summary',
    extraCss: VENUE_CSS
  }) + body + pageFoot(BIG, null, scripts);
}

// ---- トップページ(index.html)の店舗リンク行(#venueLinks)を同期する ----
// 【なぜ必要か】
//   トップの店舗カードは JS(renderVenues) が描いている。JSを実行しないクローラには
//   /venues/<slug>/ へのリンクが1本も見えないため、静的ページを作っただけでは
//   クロール経路がsitemapだけになる。大会の恒久リンク行(#evtLinks)と同じ考え方で、
//   HTMLに直接書いた静的リンクを1行置く。
//   ★ 中身は自動生成。店舗を足せばこの行にも自動で増える。
const INDEX_LINKS_PREFIX = '店舗ページ: ';
// 置換対象は「行頭にある <div id="venueLinks" …>…</div> の1行」だけ。
// 行頭アンカー(^ + m フラグ)は必須。これが無いと、説明のためにコメント内に書いた
// `<div id="venueLinks">` という文字列にまで当たってコメントごと壊す
// (#evtLinks で実際にやらかしている。gen-event-pages.js の同じ箇所のコメントを参照)。
const INDEX_LINKS_RE = /^(\s*<div id="venueLinks"[^>]*>)([^\n]*?)(<\/div>)$/m;
const INDEX_LINKS_RE_G = new RegExp(INDEX_LINKS_RE.source, 'gm');

// エリアごとにまとめる。並びは data.js の AREAS の順、エリア内は VENUES の順。
function venueLinksRow() {
  const areas = AREAS.filter(a => VENUES.some(v => v.area === a));
  // AREAS に無いエリアが VENUES 側に現れた場合も落とさず末尾に出す(掲載漏れを作らない)。
  VENUES.forEach(v => { if (areas.indexOf(v.area) < 0) areas.push(v.area); });
  return areas.map(a => `【${esc(a)}】`
    + VENUES.filter(v => v.area === a)
        .map(v => `<a href="/venues/${v.slug}/">${esc(v.name)}</a>`)
        .join('・')
  ).join('　');
}

function buildIndexHtml() {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  // 「見つからない」も「複数見つかる」も、どちらも意図しない状態なので黙って通さず必ず落とす。
  const hits = src.match(INDEX_LINKS_RE_G) || [];
  if (hits.length !== 1) {
    throw new Error(`index.html の店舗リンク行(<div id="venueLinks">…</div>)が ${hits.length} 件見つかりました。`
      + '1件だけ、独立した1行として置いてください（トップの店舗リンク行を同期できません）。');
  }
  return src.replace(INDEX_LINKS_RE, (_m, open, _inner, close) =>
    open + INDEX_LINKS_PREFIX + venueLinksRow() + close);
}

// ---- 検査 ----
// 「店舗を足したのにトップの静的リンク行だけ古い」「店舗ページが1件足りない」を
// 目視ではなくここで止める。
function verify(files) {
  const problems = [];
  VENUES.forEach(v => {
    const rel = `venues/${v.slug}/index.html`;
    if (!files[rel]) problems.push(`${v.name}: ${rel} が生成物に含まれていない`);
  });
  const im = files['index.html'].match(INDEX_LINKS_RE);
  if (!im) problems.push('index.html: #venueLinks が見つからない');
  else {
    const inner = im[2];
    if (inner.indexOf(INDEX_LINKS_PREFIX) !== 0) problems.push('index.html: #venueLinks の見出し文字列が想定と違う');
    const linked = (inner.match(/href="\/venues\/[^"]+\/"/g) || []).length;
    if (linked !== VENUES.length) {
      problems.push(`index.html #venueLinks のリンク数が ${linked} 件（VENUES は ${VENUES.length} 件）`);
    }
  }
  if (problems.length) {
    console.error('\n✗ 店舗ページの生成物が data.js と一致しません:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('検査: 店舗ページ' + VENUES.length + '件・トップの店舗リンク行は data.js と一致');
}

// ---- data.js から消えた店のページ(孤児)を探す ----
// 【なぜ必要か】
//   VENUES から店を削除すると sitemap.xml からURLは消えるが、venues/<slug>/index.html は
//   ディスクに残る。sitemap から消えただけではインデックスは落ちない(むしろ既にインデックス
//   されているURLは残る)ため、閉店した店の LocalBusiness 構造化データ付きページが
//   「更新されない状態で」公開され続ける。閉店店舗の営業情報を出し続けるのは
//   READMEの編集方針(確度の低い情報を黙って出さない)に反する。
//   さらに、この検出が無いと --check が「生成物はすべて最新」と言って通ってしまう
//   = 検査がデータとディスクの不一致を見逃す。
//   BAR BETTY(v32)は2026年9月に閉店予定で VENUES から削除することが決まっている
//   (社長情報・2026-07-29)ため、これは近い将来に実際に起きる。
//
// 【events/ 側は対象外】
//   gen-event-pages.js には同じ検出を入れていない。大会ページは会期が終わっても
//   残す運用の可能性があり(過去大会の記録としての価値・被リンク)、店舗と同じ扱いに
//   してよいか判断が必要なため。別issueとして切り出す。
//
// 【消す(警告に留めない)ことにした理由】
//   通常実行で消さないと、削除された店の孤児が残っている間ずっと --check が落ちたままになり
//   (=生成スクリプトを実行しても直らない検査失敗)、「まず手でディレクトリを消す」という
//   スクリプト外の手順が運用に必要になる。それは忘れられるし、忘れると検査が常時赤になって
//   誰も見なくなる。「node tools/gen-venue-pages.js . を実行すれば --check が通る」という
//   関係を保つため、通常実行では削除する。
//   ただし消すのは「このスクリプトが作ったと確認できるディレクトリ」だけに限る(下記)。
const VENUES_DIR = 'venues';

/** VENUES の slug 集合に無い venues/<名前>/ を、名前の昇順で返す。 */
function findOrphanVenueDirs() {
  let entries;
  try {
    entries = fs.readdirSync(path.join(REPO, VENUES_DIR), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];   // まだ1件も生成していない
    throw e;
  }
  const known = new Set(VENUES.map(v => v.slug));
  return entries
    .filter(e => e.isDirectory() && !known.has(e.name))
    .map(e => e.name)
    .sort();
}

// 中身が index.html だけのディレクトリは、このスクリプトの生成物とみなして削除してよい。
// 手で置いたファイル(画像・別ページ等)が混ざっている場合は削除せず、人間に判断させる
// (生成物ではないものをスクリプトが消してしまうのを防ぐ。--check は落ちたままになる)。
// .DS_Store は Finder が勝手に作るものなので数えない。
function orphanExtraFiles(name) {
  return fs.readdirSync(path.join(REPO, VENUES_DIR, name))
    .filter(f => f !== 'index.html' && f !== '.DS_Store');
}

// ---- 書き出し / 検査 ----
// 出力はいったん全部メモリ上で組み立ててから、まとめて書く(--check のときは書かずに突き合わせる)。
const files = {};
VENUES.forEach(v => { files[`venues/${v.slug}/index.html`] = buildVenue(v); });
files['index.html'] = buildIndexHtml();   // 店舗リンク行(#venueLinks)だけを差し替えたもの
Object.assign(files, sitemapFile(REPO));

verify(files);

// 孤児は「あるかどうか」を先に出す。どちらのモードでも対象名を標準出力に出す(気づけるように)。
const orphans = findOrphanVenueDirs();
if (orphans.length) {
  console.log(`data.js の VENUES に無い店舗ディレクトリ ${orphans.length} 件:`);
  orphans.forEach(name => {
    const extra = orphanExtraFiles(name);
    console.log(`  - ${VENUES_DIR}/${name}/`
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
    console.error('\n✗ 生成物が data.js と一致しません（node tools/gen-venue-pages.js <repo> を実行してください）:\n  - ' + stale.join('\n  - '));
    ng = true;
  }
  // 孤児が残っている状態は「生成物がデータと一致していない」ので、--check は通してはいけない。
  if (orphans.length) {
    console.error('\n✗ data.js の VENUES に無い店舗ページが残っています（node tools/gen-venue-pages.js <repo> を実行すると削除されます）:\n  - '
      + orphans.map(name => `${VENUES_DIR}/${name}/`).join('\n  - '));
    ng = true;
  }
  if (ng) process.exit(1);
  console.log('検査: 生成物はすべて最新（' + Object.keys(files).length + 'ファイル）／ 余分な店舗ディレクトリなし');
} else {
  // 削除を先にやる。残したままだとこの実行の直後に --check が落ちる。
  const kept = [];
  let removed = 0;
  orphans.forEach(name => {
    if (orphanExtraFiles(name).length) { kept.push(name); return; }
    fs.rmSync(path.join(REPO, VENUES_DIR, name), { recursive: true });
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
  console.log(`完了。店舗ページ ${VENUES.length} 件（焼き込んだ期間: ${RANGE.label}）／ 書き換えたファイル ${wrote} 件`
    + (removed ? `／ 削除した店舗ディレクトリ ${removed} 件` : ''));

  if (kept.length) {
    // 生成物以外が入っているので消さなかったもの。放置すると --check が落ち続けるので明示的に失敗させる。
    console.error('\n✗ 次のディレクトリは index.html 以外のファイルを含むため削除していません。'
      + '中身を確認して手で削除してください（残っている間 --check は落ちます）:\n  - '
      + kept.map(name => `${VENUES_DIR}/${name}/`).join('\n  - '));
    process.exit(1);
  }
}
