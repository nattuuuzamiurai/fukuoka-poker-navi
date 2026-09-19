#!/usr/bin/env node
/**
 * gen-guide-partners.js
 *
 * 掲載店舗の運営者向け案内ページ(/guide/partners/)の生成スクリプト。
 * 「PR掲載枠」(即時利用可能)と「経営管理ダッシュボード」(開発中・先行案内)を紹介し、
 * それぞれ専用のお問い合わせ導線(contact.html?type=listing / ?type=dashboard)で締める。
 *
 * 【なぜ tools/gen-guide-pages.js / gen-guide-webcoin-regulation.js とは別ファイルにしたか】
 *   どちらも data.js の店舗横断コンテンツ(店舗一覧・カテゴリー紹介)か、プレイヤー向けの
 *   読み物記事という役割で、対象読者はプレイヤーである。このページは対象読者が掲載店舗の
 *   運営者であり、店舗一覧・個別店舗への内部リンクは不要なため、webcoin-regulation と同じく
 *   「店舗横断コンテンツ(店舗カード等)を持たない静的ページ」として独立させている
 *   (サイト共通の外側だけ site-shell.js の pageHead/pageFoot を再利用し、ヘッダー・
 *   フッター・共通CSSはズレない)。
 *
 * 【掲載店舗数・トーナメント日程数はdata.jsから動的に算出する(2026-09-19)】
 *   以前は「35店舗・トーナメント日程300件超」という数値をDESC文字列に直書きしていたが、
 *   実データ(当時: 店舗38・うち休業中2、本日以降の日程179件)とズレていることが品質チェックで
 *   指摘された。siteStats() が data.js から都度算出するため、以後は再生成のたびに
 *   自動で実データに追随する(ハードコードに戻さないこと)。
 *   - 掲載店舗数    … VENUES のうち preopen:true(開店前)・closed:true(休業中)を除いた件数
 *     (data.js冒頭コメントの既定ルール `!v.preopen && !v.closed` どおり。
 *     tools/gen-guide-pages.js の「35店舗」表示と同じ条件)。
 *   - トーナメント日程 … TOURNAMENTS のうち本日(JST)以降の日付のみ。「今から予約できる件数」
 *     という文脈で使う数字のため、過去分・定期開催(RECURRING)の展開は数えない
 *     (index.html の stat-t 等、月内の定期開催展開を含む集計とは定義が異なる)。
 *   sitemap.xml側のlastmod(tools/gen-sitemap.js)もこのファイルだけでなくdata.jsの
 *   更新日時を見るようにしてあるので、あわせて確認すること。
 *
 * 【内容の出どころ】社内で確定した案内文言をそのままHTML化したもの(上記の2数値を除き、
 *   文言・価格等は既定のまま変更しないこと)。内部の検討経緯・組織名等はページ本文に
 *   一切含めない(README「コード・データファイルへの内部情報の記載について」を参照)。
 *
 * 使い方:
 *   node gen-guide-partners.js <リポジトリのパス>            … 生成する
 *   node gen-guide-partners.js <リポジトリのパス> --check     … 書き込まず、一致確認だけ行う
 */

'use strict';

const fs = require('fs');
const path = require('path');

const shell = require('./site-shell.js');
const { SITE, POSITIONING, pageHead, pageFoot } = shell;
const { sitemapFile } = require('./gen-sitemap.js');
const { footerAreaLinksHtml } = require('./area-schedule.js');

const PAGE_PATH = 'guide/partners/index.html';
const PAGE_URL = '/guide/partners/';
const CANONICAL = `${SITE}${PAGE_URL}`;

const TITLE = '掲載店舗の皆さまへ｜PR掲載枠・経営管理ダッシュボードのご案内 | ふくおかポーカーナビ';

/** 今日(JST)の YYYY-MM-DD。実行環境のタイムゾーンに依存しないよう、他のtools/*.jsと
 * 同じ「UTC+9固定オフセット」のイディオムを使う(tools/import-waitinglist.js の
 * todayJst() 等と同じ考え方)。 */
function todayJst() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad2 = n => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

/** 掲載店舗数・トーナメント日程数を data.js の実データから算出する(ファイル冒頭コメント参照)。
 * 【掲載店舗数のフィルタ条件(2026-09-19修正)】data.js冒頭コメント(21〜22行目)の既定ルールどおり、
 * closed(閉店した可能性がある店)だけでなく preopen(まだ開店していない店)も除外する。
 * tools/gen-guide-pages.js(/guide/beginner/。「35店舗」)と同じ `!v.preopen && !v.closed` を使う
 * (初版はpreopenの除外漏れがあり、実際より1店舗多く数えてしまっていた)。 */
function siteStats(DATA) {
  const today = todayJst();
  const venueCount = DATA.VENUES.filter(v => !v.preopen && !v.closed).length;
  const tournamentCount = DATA.TOURNAMENTS.filter(t => t && typeof t.date === 'string' && t.date >= today).length;
  return { venueCount, tournamentCount };
}

function buildDesc(stats) {
  return `ふくおかポーカーナビは福岡県内のアミューズメントポーカー店${stats.venueCount}店舗・今後開催予定のトーナメント日程${stats.tournamentCount}件を掲載するアグリゲーターサイトです。掲載店舗様向けのPR掲載枠(月額5,000円〜)と、開発中の経営管理ダッシュボードをご案内します。`;
}

// ============================================================
// ページ固有CSS(見た目は既存の静的ページのデザイン言語を踏襲。BASE_CSSにある
// .disclaimer/.lead/h2.day/.tba/table.gd-table 等はそのまま流用し、ここには
// 「この記事に足りない分」だけを足す。色は新しい色を増やさず、サイト内で既に使っている
// 値(--gold/--gold2/--felt/#fbf1d8/#7a5711 等)を再利用する)
// ============================================================
const PT_CSS = `  .pt-toc{list-style:none;margin:0 0 16px;padding:0;font-size:.88em;line-height:1.9}
  .pt-toc li{padding-left:1.1em;position:relative}
  .pt-toc li::before{content:'▸';position:absolute;left:0;color:var(--gold)}
  .pt-toc a{color:#0e6a72;font-weight:700;text-decoration:none}
  .pt-toc a:hover{text-decoration:underline}
  .pt-price{background:linear-gradient(135deg,var(--gold2),var(--gold));color:#3a2a06;border-radius:var(--r);padding:14px 16px;margin:10px 0 16px;font-weight:800;font-size:1.05em;box-shadow:var(--sha)}
  .pt-price small{display:block;font-weight:600;font-size:.72em;margin-top:4px;color:#5a4109}
  .pt-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:8px 0 16px}
  .pt-card{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:13px 14px}
  .pt-card h4{font-size:.92em;font-weight:800;color:var(--felt);margin-bottom:5px}
  .pt-card p{font-size:.85em;line-height:1.75;color:var(--txt)}
  .pt-badge{display:inline-block;background:#fbf1d8;border:1px solid #ecd9a6;color:#7a5711;font-size:.78em;font-weight:700;padding:2px 9px;border-radius:10px;margin-left:6px;vertical-align:middle}
  .pt-note{background:var(--sur);border:1px solid var(--bor);border-left:4px solid var(--gold);border-radius:10px;padding:13px 15px;margin:10px 0 16px;font-size:.88em;line-height:1.8;color:var(--txt)}
  .pt-note b{color:var(--felt)}
  /* ---- 比較表(table.compare) ----
     列幅がコンテンツ量でぶれて崩れて見えないよう、先頭列に width:44% を明示している。
     配色は新しい色を増やさず、サイトで既に使っている値を再利用する
     (#eef3f1=table.gd-table th の背景、#fbf1d8/#7a5711=.gtd 等の既存ゴールドバッジ配色)。 */
  table.compare{border-collapse:collapse;width:100%;margin-top:10px;font-size:.86em;background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);overflow:hidden;box-shadow:var(--sha)}
  table.compare th,table.compare td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--bor);vertical-align:top}
  table.compare tr:last-child td{border-bottom:none}
  table.compare thead th{background:#eef3f1;color:var(--felt);font-weight:800;font-size:.85em}
  table.compare td.yes{color:var(--felt);font-weight:800}
  table.compare td.pr{background:#eef3f1}
  table.compare th.pr{background:#eef3f1;color:var(--felt)}
  /* ---- 画面イメージ(受付/来店中/会計/経営ダッシュボード/マイページ/フロアマップ/同卓プレイヤー情報) ----
     カード高さを flex:1 で強制的に揃える実装は採用しない。.mini-floor は aspect-ratio で
     高さを決めており、flex:1によるグリッド高さ揃えに依存すると縦横比が崩れるため、
     グリッド側は align-items:start に留め、各カードは自然な高さのまま並べる。
     auto-fit(auto-fillではない)にしているのは、オプションプラン側のギャラリーが2枚しかなく、
     auto-fillだと使われない列トラックぶんの余白が右側に残ってしまうため(auto-fitは
     空きトラックを畳んで1frのカードに幅を回す)。3枚以上のギャラリーでは挙動は変わらない。 */
  .preview-gallery{margin-top:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;align-items:start}
  figure.preview{margin:0}
  figure.preview figcaption{font-size:.82em;font-weight:800;color:var(--felt);margin-bottom:8px}
  figure.preview figcaption span{display:block;font-weight:600;color:var(--mut);font-size:.78em;margin-top:1px}
  .device{background:var(--sur);border:1px solid var(--bor);border-radius:var(--r);box-shadow:var(--sha);padding:13px;display:flex;flex-direction:column;gap:9px}
  .app-header{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:8px;border-bottom:1px solid var(--bor);font-size:.72em;color:var(--mut)}
  .app-header b{color:var(--txt);font-size:.9em}
  .stat-mini-row{display:flex;flex-wrap:wrap;gap:6px}
  .stat-mini{flex:1 1 70px;min-width:0;background:#eef3f1;border-radius:8px;padding:8px 6px;text-align:center}
  .stat-mini .v{font-weight:800;font-size:.95em;color:var(--felt);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .stat-mini .l{font-size:.66em;color:var(--mut);margin-top:1px;overflow-wrap:anywhere}
  .visit-row{display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px dashed var(--bor);font-size:.76em}
  .visit-row:last-child{border-bottom:none}
  .visit-row .t{color:var(--mut);font-size:.85em;width:38px;flex-shrink:0;font-variant-numeric:tabular-nums}
  .visit-row .n{flex:1}
  .tag-mini{font-size:.68em;padding:2px 7px;border-radius:999px;font-weight:800}
  .tag-mini.new{background:#fbf1d8;color:#7a5711}
  .tag-mini.rep{background:#eef3f1;color:var(--felt)}
  .guest-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--bor);font-size:.78em}
  .guest-row:last-child{border-bottom:none}
  .guest-row .n{flex:1;font-weight:700}
  .guest-row .tbl,.guest-row .tm{color:var(--mut);font-size:.88em;font-variant-numeric:tabular-nums}
  .guest-more{font-size:.76em;color:var(--mut);text-align:center;padding-top:6px}
  .receipt-row{display:flex;justify-content:space-between;font-size:.8em;padding:5px 0;border-bottom:1px dashed var(--bor)}
  .receipt-row:last-child{border-bottom:none}
  .receipt-total{display:flex;justify-content:space-between;font-weight:800;font-size:.92em;padding-top:8px;color:var(--txt)}
  .receipt-total .v{color:#7a5711;font-variant-numeric:tabular-nums}
  .panel-label{font-size:.76em;color:var(--mut);margin-bottom:4px}
  .mini-bars{display:flex;align-items:flex-end;gap:5px;height:74px;padding:0 2px}
  .mini-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;height:100%}
  .mini-bar-col .bar{width:100%;border-radius:3px 3px 2px 2px;background:#eef3f1}
  .mini-bar-col.today .bar{background:var(--felt)}
  .mini-bar-col .bl{font-size:.62em;color:var(--mut)}
  .mini-bar-col .bv{font-size:.66em;color:var(--mut);font-variant-numeric:tabular-nums}
  .mini-bar-col.today .bv{color:var(--felt);font-weight:800}
  .seg-chip-row{display:flex;flex-wrap:wrap;gap:6px}
  .seg-chip{font-size:.74em;background:#eef3f1;border:1px solid var(--bor);border-radius:999px;padding:5px 11px;color:var(--txt)}
  .guest-card{display:flex;flex-direction:column;gap:8px}
  .gc-name{font-size:.95em;font-weight:800;color:var(--txt)}
  .gc-note{font-size:.78em;color:var(--mut);line-height:1.6}
  table.data-table{width:100%;border-collapse:collapse;font-size:.72em;margin-top:2px}
  table.data-table th,table.data-table td{text-align:left;padding:5px 7px;border-bottom:1px solid var(--bor)}
  table.data-table thead th{color:var(--mut);font-weight:700}
  table.data-table tr:last-child td{border-bottom:none}
  /* フロアマップ: aspect-ratio で高さを固定し、中の座席・テーブル・ディーラー表示はすべて
     絶対配置にする(親のflex/gridの高さ揃えに依存させない。上記コメント参照)。 */
  .mini-floor{position:relative;width:100%;aspect-ratio:4/3;overflow:hidden;background:var(--bg);border:1px dashed var(--bor);border-radius:10px}
  .mini-table{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);width:64%;height:46%;border:2px solid var(--felt);border-radius:50%;background:var(--sur);display:flex;align-items:center;justify-content:center;font-size:.62em;font-weight:800;color:var(--mut)}
  .mini-dealer{position:absolute;left:50%;top:10%;transform:translate(-50%,-50%);width:30px;height:16px;border-radius:4px;background:var(--felt);color:#fff;font-size:.56em;font-weight:800;display:flex;align-items:center;justify-content:center}
  .mini-seat{position:absolute;width:26px;height:26px;border-radius:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;font-size:.56em;font-weight:800;letter-spacing:-.03em;border:2px solid var(--bor);background:var(--sur);color:var(--mut)}
  .mini-seat.filled{background:#eef3f1;border-color:var(--felt);color:var(--felt)}
  /* トーナメント卓のフロアマップは、リング卓(felt系)と区別できるようゴールド系にする。 */
  .mini-seat.filled.tourney{background:#fbf1d8;border-color:var(--gold);color:#7a5711}
  .mini-table.tourney{border-color:var(--gold)}
`;

// ---- 本文の組み立て ----
function buildBody(desc) {
  return `
<h1>掲載店舗の皆さまへ — PR掲載枠・経営管理ダッシュボードのご案内</h1>
<p class="lead">${desc}</p>
<div class="disclaimer">${POSITIONING}<br>本ページでご案内する経営管理ダッシュボードは、店舗様の来店客管理・会計記録・経営分析を支援するツールです。チップ・ポイントは店内限定のアミューズメント用であり、現金化や店舗をまたいだ利用はできません。</div>

<p class="lead">2026年7月14日の公開以来、エリア・日付・種類で絞り込んでトーナメント日程を探せる仕組みを軸に、福岡のポーカー店を知っていただく入口になることを目指してきました。このページでは、掲載店舗様向けに今すぐご利用いただける「PR掲載枠」と、現在開発を進めている「経営管理ダッシュボード」をご案内します。</p>

<ul class="pt-toc">
  <li><a href="#service1">1. PR掲載枠(今すぐご利用いただけます)</a></li>
  <li><a href="#service2">2. 経営管理ダッシュボード(開発中・先行案内)</a></li>
  <li><a href="#contact">3. ご相談・お問い合わせ</a></li>
</ul>

<h2 class="day" id="service1">1. PR掲載枠(今すぐご利用いただけます)</h2>
<p class="lead">現在、掲載店舗様はすべて無料でご掲載いただいています。PR掲載枠は、その中でより目立つ形で店舗情報をお届けする任意のオプションで、掲載を続けるための条件ではありません。</p>
<div class="pt-price">月額5,000円(税別)<small>先行導入価格・最短1ヶ月からご利用いただけます</small></div>

<h3>無料掲載との違い</h3>
<div class="sched-wrap"><table class="compare">
  <thead>
    <tr><th style="width:44%">項目</th><th>無料掲載</th><th class="pr">PR掲載枠</th></tr>
  </thead>
  <tbody>
    <tr><td>店舗情報・トーナメント日程の掲載</td><td class="yes">○</td><td class="pr yes">○</td></tr>
    <tr><td>トーナメント情報の反映</td><td>自動取得による標準反映</td><td class="pr yes">店舗様のご依頼内容を優先反映</td></tr>
    <tr><td>表示順</td><td>通常順(日程順)</td><td class="pr yes">PR枠内でランダム表示</td></tr>
    <tr><td>「PR」バッジ</td><td>なし</td><td class="pr yes">金色バッジを表示</td></tr>
    <tr><td>店舗名の★マーク</td><td>なし</td><td class="pr yes">★付きで視認性アップ</td></tr>
    <tr><td>PR告知(バナー掲載)</td><td>なし</td><td class="pr yes">週1回・月4回</td></tr>
  </tbody>
</table></div>

<h3>ご利用のメリット</h3>
<div class="pt-cards">
  <div class="pt-card">
    <h4>送客機会の拡大</h4>
    <p>目立つ表示・週次のPR告知により、プレイヤーの目に留まる機会を増やせます。集客そのものを保証するものではなく、露出機会を広げるサービスとしてご案内しています。</p>
  </div>
  <div class="pt-card">
    <h4>信頼性の向上</h4>
    <p>第三者が運営する中立的なまとめサイトに掲載されていること自体が、来店を検討するプレイヤーにとっての安心材料になります。</p>
  </div>
  <div class="pt-card">
    <h4>SNS運用の手間削減</h4>
    <p>告知したい内容のテキスト・画像をお送りいただくだけで、掲載・更新は当サイト側で代行します。</p>
  </div>
  <div class="pt-card">
    <h4>比較の場での機会損失回避</h4>
    <p>同じページで並ぶ他店だけが目立つ表示になっている状態を避け、比較検討の場での機会損失を防げます。</p>
  </div>
</div>

<h2 class="day" id="service2">2. 経営管理ダッシュボード(開発中・先行案内)</h2>
<p class="lead">来店客のチェックインから、チップ・トーナメント運営の明朗会計、経営分析までをひとつのセットとして開発を進めている、掲載店舗様向けの来店客管理システムです。</p>
<div class="tba"><b>現在開発中のサービスです。</b> 実際の提供時期・仕様は今後変更になる可能性があります。ご興味をお持ちの店舗様には、正式リリース前に優先的にご案内・ヒアリングいたします。特にチップ・会計関連の機能は、店舗審査を完了した店舗様から順次提供します。</div>

<h3>基本セット<span class="pt-badge">先行案内</span></h3>
<div class="pt-price">月額10,000円(税別)<small>先行案内価格の目安です</small></div>
<p class="lead" style="font-size:.82em;margin-top:8px">この価格は、まだ導入実績のない段階でのご案内にあわせた<b>先行導入価格</b>です。実際の運用実績が積み上がった段階で価格を見直す可能性がありますが、その際も既存契約店舗様には事前にご案内し、一方的な値上げは行いません。提供開始時期は別途ご案内します。</p>
<div class="pt-cards">
  <div class="pt-card">
    <h4>来店客チェックイン</h4>
    <p>新規のお客様かリピーターのお客様かを自動で判別し、来店頻度・客数の推移を自動集計します。スマートフォンの会員証(Apple Wallet/Google Wallet)か店舗発行の会員カードを選んでかざすだけで、簡単にチェックインできます。</p>
  </div>
  <div class="pt-card">
    <h4>明朗会計</h4>
    <p>バイイン・リバイ・アドオン・会計をタブレットで一元管理し、退店時にまとめて精算します。現金のやり取りは店舗スタッフが対面で行い、システムはあくまで記録を担います。</p>
  </div>
  <div class="pt-card">
    <h4>顧客チップ管理</h4>
    <p>お客様ごとのチップの購入状況・保有状況を記録・管理します。</p>
  </div>
  <div class="pt-card">
    <h4>経営分析</h4>
    <p>客単価・リピート率・来店頻度などのセグメント分析で、経営判断をサポートします。</p>
  </div>
</div>

<h3>画面イメージ</h3>
<p class="lead">開発中の画面イメージです(実際の仕様は今後変更になる場合があります)。</p>
<div class="preview-gallery">
  <figure class="preview">
    <figcaption>受付画面<span>スタッフ用・チェックイン</span></figcaption>
    <div class="device">
      <div class="app-header"><b>本日の来店</b><span>9/17(木)</span></div>
      <div class="stat-mini-row">
        <div class="stat-mini"><div class="v">3</div><div class="l">新規</div></div>
        <div class="stat-mini"><div class="v">18</div><div class="l">常連</div></div>
        <div class="stat-mini"><div class="v">21</div><div class="l">本日計</div></div>
      </div>
      <div>
        <div class="visit-row"><span class="t">19:42</span><span class="n">はやと</span><span class="tag-mini rep">常連</span></div>
        <div class="visit-row"><span class="t">19:38</span><span class="n">みずき</span><span class="tag-mini new">新規</span></div>
        <div class="visit-row"><span class="t">19:20</span><span class="n">りょう</span><span class="tag-mini rep">常連</span></div>
      </div>
    </div>
  </figure>
  <figure class="preview">
    <figcaption>来店中のお客様<span>スタッフ用・顧客管理</span></figcaption>
    <div class="device">
      <div class="app-header"><b>在店中</b><span>21名</span></div>
      <div>
        <div class="guest-row"><span class="n">はやと</span><span class="tbl">テーブルB</span><span class="tm">2:15</span></div>
        <div class="guest-row"><span class="n">りょう</span><span class="tbl">テーブルA</span><span class="tm">1:20</span></div>
        <div class="guest-row"><span class="n">さき</span><span class="tbl">テーブルA</span><span class="tm">0:45</span></div>
        <div class="guest-row"><span class="n">みずき</span><span class="tbl">テーブルB</span><span class="tm">2:15</span></div>
      </div>
      <div class="guest-more">他 17名 表示中(会員検索も可能)</div>
    </div>
  </figure>
  <figure class="preview">
    <figcaption>会計画面<span>スタッフ用・明朗会計</span></figcaption>
    <div class="device">
      <div class="app-header"><b>会計 — さき さん</b><span>テーブルA</span></div>
      <div class="sched-wrap">
        <table class="data-table">
          <thead><tr><th>品目</th><th>時刻</th><th>担当</th><th>金額</th></tr></thead>
          <tbody>
            <tr><td>リング バイイン</td><td>19:05</td><td>はやと</td><td>¥3,000</td></tr>
            <tr><td>ハイボール ×2</td><td>19:40</td><td>みずき</td><td>¥1,200</td></tr>
            <tr><td>フライドポテト ×1</td><td>19:42</td><td>みずき</td><td>¥600</td></tr>
          </tbody>
        </table>
      </div>
      <div class="receipt-total"><span>合計(退店時にまとめて精算)</span><span class="v">¥4,800</span></div>
      <p class="gc-note">どの項目を、いつ、誰が入力したかが記録に残るので、金額のズレがあった際も追跡できます。</p>
    </div>
  </figure>
</div>
<figure class="preview" style="margin-top:14px">
  <figcaption>経営ダッシュボード<span>店長・オーナー用</span></figcaption>
  <div class="device" style="padding:18px">
    <div class="app-header"><b>店舗名</b><span>9/17(木)</span></div>
    <div class="stat-mini-row">
      <div class="stat-mini"><div class="v">21人</div><div class="l">本日来店(新規3・常連18)</div></div>
      <div class="stat-mini"><div class="v">62%</div><div class="l">リピート率(30日)</div></div>
      <div class="stat-mini"><div class="v">2:18</div><div class="l">平均滞在時間</div></div>
      <div class="stat-mini"><div class="v">¥4,800</div><div class="l">客単価</div></div>
    </div>
    <div>
      <div class="panel-label">直近7日間の来店客数</div>
      <div class="mini-bars">
        <div class="mini-bar-col"><span class="bv">18</span><div class="bar" style="height:50%"></div><span class="bl">9/11</span></div>
        <div class="mini-bar-col"><span class="bv">24</span><div class="bar" style="height:68%"></div><span class="bl">9/12</span></div>
        <div class="mini-bar-col"><span class="bv">31</span><div class="bar" style="height:88%"></div><span class="bl">9/13</span></div>
        <div class="mini-bar-col"><span class="bv">27</span><div class="bar" style="height:77%"></div><span class="bl">9/14</span></div>
        <div class="mini-bar-col"><span class="bv">11</span><div class="bar" style="height:31%"></div><span class="bl">9/15</span></div>
        <div class="mini-bar-col"><span class="bv">14</span><div class="bar" style="height:40%"></div><span class="bl">9/16</span></div>
        <div class="mini-bar-col today"><span class="bv">21</span><div class="bar" style="height:60%"></div><span class="bl">9/17</span></div>
      </div>
    </div>
    <div>
      <div class="panel-label">こんなセグメント分析も見られます</div>
      <div class="seg-chip-row">
        <span class="seg-chip">顧客セグメント(新規/レギュラー/ヘビー/休眠)</span>
        <span class="seg-chip">定着率・コホート分析</span>
        <span class="seg-chip">離反予兆アラート</span>
        <span class="seg-chip">トーナメント開催の集客効果</span>
      </div>
    </div>
  </div>
</figure>
<figure class="preview" style="margin-top:14px">
  <figcaption>マイページ<span>お客様のスマホ表示・トーナメント成績</span></figcaption>
  <div class="device">
    <div class="app-header"><b>マイページ</b><span>トーナメント成績</span></div>
    <div class="stat-mini-row">
      <div class="stat-mini"><div class="v">27</div><div class="l">参加回数</div></div>
      <div class="stat-mini"><div class="v">70%</div><div class="l">インマネ率</div></div>
      <div class="stat-mini"><div class="v">228,000pt</div><div class="l">生涯獲得ポイント</div></div>
    </div>
    <div class="stat-mini-row">
      <div class="stat-mini"><div class="v">¥4,200</div><div class="l">平均バイイン</div></div>
      <div class="stat-mini"><div class="v">12,000pt</div><div class="l">今月の獲得ポイント</div></div>
      <div class="stat-mini"><div class="v">9位</div><div class="l">順位の中央値</div></div>
    </div>
    <div class="sched-wrap">
      <table class="data-table">
        <thead><tr><th>バイイン帯</th><th>参加</th><th>インマネ率</th></tr></thead>
        <tbody>
          <tr><td>〜¥3,000</td><td>14</td><td>64%</td></tr>
          <tr><td>¥3,000〜8,000</td><td>10</td><td>80%</td></tr>
        </tbody>
      </table>
    </div>
    <div class="panel-label" style="margin-top:2px">月別獲得ポイントの推移</div>
    <div class="mini-bars" style="height:64px">
      <div class="mini-bar-col"><span class="bv">6.4k</span><div class="bar" style="height:53%"></div><span class="bl">6月</span></div>
      <div class="mini-bar-col"><span class="bv">9.1k</span><div class="bar" style="height:76%"></div><span class="bl">7月</span></div>
      <div class="mini-bar-col"><span class="bv">12.0k</span><div class="bar" style="height:100%"></div><span class="bl">8月</span></div>
      <div class="mini-bar-col today"><span class="bv">9.5k</span><div class="bar" style="height:79%"></div><span class="bl">9月</span></div>
    </div>
  </div>
</figure>
<p class="lead" style="font-size:.78em;margin-top:8px">※マイページのトーナメント成績にある「ポイント」は現金ではありません。</p>

<h3>オプションプラン<span class="pt-badge">+月額5,000円(税別)</span></h3>
<div class="pt-cards">
  <div class="pt-card">
    <h4>同卓プレイヤー情報</h4>
    <p>大会運営システムのような座席管理機能です。同じテーブルのお客様同士が、成績や傾向を確認し合えます。本人が公開に同意した情報のみ表示され、同意していない場合は表示されません。</p>
  </div>
</div>

<div class="pt-note"><b>店外からは一切アクセスできない設計です。</b> マイページ・同卓プレイヤー情報は、ご来店中のお客様だけが閲覧できます。チェックインしてから退店処理をするまでの間だけ表示され、退店すると自動的に見られなくなる仕組みです。店外・ご自宅からアクセスすることは一切できません。</div>

<h3>画面イメージ(オプションプラン)</h3>
<p class="lead">オプションプランの画面イメージです。座席管理(フロアマップ)と同卓プレイヤー情報が追加されます。</p>
<div class="preview-gallery">
  <figure class="preview">
    <figcaption>フロアマップ<span>店舗の配置に合わせた座席表・トーナメント卓</span></figcaption>
    <div class="device">
      <div class="app-header"><b>テーブルB</b><span>第48回 週末オープン</span></div>
      <div class="stat-mini-row">
        <div class="stat-mini"><div class="v">08:42</div><div class="l">レジクロまでの時間</div></div>
        <div class="stat-mini"><div class="v">31</div><div class="l">現在のエントリー数</div></div>
        <div class="stat-mini"><div class="v">12</div><div class="l">アドオン数</div></div>
      </div>
      <div class="stat-mini-row">
        <div class="stat-mini"><div class="v">24,800</div><div class="l">アベレージスタック</div></div>
        <div class="stat-mini"><div class="v">768,800</div><div class="l">総スタック</div></div>
      </div>
      <div class="mini-floor">
        <div class="mini-table tourney">テーブルB</div>
        <div class="mini-dealer">D</div>
        <div class="mini-seat filled tourney" style="left:12%;top:30%">はや</div>
        <div class="mini-seat filled tourney" style="left:11%;top:62%">みず</div>
        <div class="mini-seat filled tourney" style="left:27%;top:86%">ゆい</div>
        <div class="mini-seat filled tourney" style="left:50%;top:92%">しょ</div>
        <div class="mini-seat filled tourney" style="left:73%;top:86%">あか</div>
        <div class="mini-seat filled tourney" style="left:89%;top:62%">りな</div>
        <div class="mini-seat filled tourney" style="left:88%;top:30%">そら</div>
      </div>
    </div>
  </figure>
  <figure class="preview">
    <figcaption>同卓プレイヤー情報(トナメ卓)<span>トーナメント卓・来店中のみ表示</span></figcaption>
    <div class="device">
      <div class="app-header"><b>同卓のプレイヤー</b><span>トナメ卓</span></div>
      <div class="guest-card">
        <div class="gc-name">りな さん</div>
        <div class="stat-mini-row">
          <div class="stat-mini"><div class="v">41</div><div class="l">参加回数</div></div>
          <div class="stat-mini"><div class="v">39%</div><div class="l">インマネ率</div></div>
          <div class="stat-mini"><div class="v">5</div><div class="l">FT数</div></div>
        </div>
        <div class="stat-mini-row">
          <div class="stat-mini"><div class="v">1.2回</div><div class="l">平均リバイ</div></div>
          <div class="stat-mini"><div class="v">55%</div><div class="l">アドオン率</div></div>
        </div>
        <p class="gc-note">得意シリーズ: レディースイベント(インマネ50% / 全体39%)</p>
        <div class="sched-wrap">
          <table class="data-table">
            <thead><tr><th>初期チップ量</th><th>インマネ率</th><th>優勝</th></tr></thead>
            <tbody>
              <tr><td>ディープスタック</td><td>42%</td><td>4</td></tr>
              <tr><td>レギュラースタック</td><td>35%</td><td>2</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </figure>
  <figure class="preview">
    <figcaption>同卓プレイヤー情報(リング卓)<span>リング卓・来店中のみ表示</span></figcaption>
    <div class="device">
      <div class="app-header"><b>同卓のプレイヤー</b><span>リング卓</span></div>
      <div class="guest-card">
        <div class="gc-name">だいき さん</div>
        <div class="stat-mini-row">
          <div class="stat-mini"><div class="v">58,000</div><div class="l">総持ちチップ(CHIP)</div></div>
          <div class="stat-mini"><div class="v">9回</div><div class="l">月間来店回数</div></div>
          <div class="stat-mini"><div class="v">21,000</div><div class="l">平均バイイン(CHIP)</div></div>
        </div>
        <div class="stat-mini-row">
          <div class="stat-mini"><div class="v">+6,200</div><div class="l">1ヶ月の平均収支(CHIP)</div></div>
          <div class="stat-mini"><div class="v">+3,800</div><div class="l">収支中央値(CHIP)</div></div>
        </div>
        <p class="gc-note">プレイスタイル: <b style="color:var(--txt)">アグレッシブ型</b>(追加バイインを積極的に活用する傾向)</p>
      </div>
    </div>
  </figure>
</div>

<h2 class="day" id="contact">3. ご相談・お問い合わせ</h2>
<p class="lead">PR掲載枠のお申し込み、経営管理ダッシュボードのご案内・ヒアリングのご希望は、お問い合わせフォームからご連絡ください。</p>
<a class="cta" href="/contact.html?type=listing">▶ PR掲載枠のご相談はこちら<small>「店舗掲載・PR枠のご相談」を選択してご連絡ください</small></a>
<a class="cta" href="/contact.html?type=dashboard">▶ 経営管理ダッシュボードのご相談はこちら<small>「経営管理ダッシュボードのご相談」を選択してご連絡ください</small></a>`;
}

/**
 * ページ全体のHTML文字列を組み立てる。REPO は絶対パスで渡すこと
 * (pageFoot の恒久リンク行・エリアリンク行を組み立てるのに big-events.js / data.js を読む)。
 */
function buildPage(REPO) {
  const BIG = require(path.join(REPO, 'big-events.js'));
  const DATA = require(path.join(REPO, 'data.js'));
  const areaLinks = footerAreaLinksHtml(DATA.VENUES, DATA.AREAS);
  const stats = siteStats(DATA);
  const desc = buildDesc(stats);

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: TITLE,
    description: desc,
    url: CANONICAL,
    inLanguage: 'ja',
    isPartOf: { '@type': 'WebSite', name: 'ふくおかポーカーナビ', url: `${SITE}/` }
  };
  const breadcrumb = [
    { name: 'ふくおかポーカーナビ', url: `${SITE}/` },
    { name: '店舗の掲載・PRについて', url: CANONICAL }
  ];

  const head = pageHead({
    title: TITLE,
    desc,
    canonical: CANONICAL,
    jsonld,
    breadcrumb,
    ogType: 'website',
    twitterCard: 'summary_large_image',
    extraCss: PT_CSS
  });
  const foot = pageFoot(BIG, null, null, areaLinks);
  return head + buildBody(desc) + foot;
}

// ---- 検査 ----
function verify(html) {
  if (!html.includes(POSITIONING)) {
    throw new Error('gen-guide-partners.js: サイト共通の法的ポジショニング文(POSITIONING)が本文に見つかりません。');
  }
  if (!html.includes('店外・ご自宅からアクセスすることは一切できません')) {
    throw new Error('gen-guide-partners.js: 経営管理ダッシュボードの店外アクセス不可に関する注記が見つかりません。');
  }
  // 法人名(エースハイ合同会社等)を書かない(このサイトは個人運営)。
  if (/合同会社|株式会社/.test(html)) {
    throw new Error('gen-guide-partners.js: 法人名らしき語が本文に含まれています(このサイトは個人運営のため運営者・法人名を表記しない)。');
  }
  // 「アップセル」等の内部営業用語を使わない。
  if (/アップセル/.test(html)) {
    throw new Error('gen-guide-partners.js: 「アップセル」は内部営業用語のため使用しないでください(「オプションプラン」等に置き換える)。');
  }
  // 換金・現金化を示唆する表現が混ざっていないか(チップは店内限定という前提)。
  if (/換金|現金化/.test(html.replace('現金化や店舗をまたいだ利用はできません', ''))) {
    throw new Error('gen-guide-partners.js: 換金・現金化を示唆する表現が含まれています(チップは店内限定・換金不可という前提と矛盾します)。');
  }
}

module.exports = { PAGE_PATH, PAGE_URL, CANONICAL, buildPage, verify, siteStats, buildDesc, todayJst };

// ---- CLI ----
// require されただけでは何も起きない(--check のつもりで読み込んで上書きする事故を防ぐため)。
if (require.main === module) {
  const args = process.argv.slice(2);
  const CHECK = args.includes('--check');
  const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
  if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
  const REPO = path.resolve(REPO_ARG);

  const files = {};
  files[PAGE_PATH] = buildPage(REPO);
  verify(files[PAGE_PATH]);
  Object.assign(files, sitemapFile(REPO));

  if (CHECK) {
    const stale = Object.keys(files).filter(rel => {
      let cur = null;
      try { cur = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (e) { /* 未生成 */ }
      return cur !== files[rel];
    });
    if (stale.length) {
      console.error('\n✗ 生成物が最新ではありません（node tools/gen-guide-partners.js <repo> を実行してください）:\n  - ' + stale.join('\n  - '));
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
    console.log(`完了。掲載店舗向け案内ページ 1件／ 書き換えたファイル ${wrote} 件`);
  }
}
