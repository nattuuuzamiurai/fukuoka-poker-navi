#!/usr/bin/env node
/**
 * gen-guide-webcoin-regulation.js
 *
 * 「ウェブコイン」規制の解説記事（/guide/webcoin-regulation/）の生成スクリプト。
 *
 * 【原稿の出どころ】企画部の企画・コンテンツ制作部の執筆にもとづく
 *   webcoin-regulation-content-draft.md（品質管理部2ラウンド・レビュー部GO済み、2026-09-14）。
 *   本文の事実関係・確定事実と専門家見解の書き分け・出典は、このファイルでも一切変更しない
 *   （見出し構造のHTML化・デザインへの落とし込みのみを行う）。
 *
 * 【なぜ tools/gen-guide-pages.js（/guide/beginner/）とは別ファイルにしたか】
 *   gen-guide-pages.js は data.js の VENUES を読み込み、店舗カード・全店舗一覧表・
 *   目的別カテゴリーなど「店舗横断の比較・紹介」をコンテンツの中心に据えたページの生成器で、
 *   店舗ページへの内部リンクを大量に張ることが前提の設計になっている（verify() が
 *   /venues/ へのリンク本数を検算しているのもその一環）。
 *   このページは逆に「特定の店舗を評価しない」という立ち位置の記事で、レビュー部の申し送りにより
 *   店舗一覧・個別店舗ページへのリンクを意図的に一切張らない。既存の店舗横断ロジックを
 *   継承する理由が無いうえ、誤って共有すると将来 gen-guide-pages.js 側の変更に巻き込まれて
 *   店舗リンクが紛れ込むリスクがあるため、あえて独立したファイルにしている。
 *
 * 【外部リンクのrel属性ポリケー（レビュー部申し送り5）】
 *   このサイトの既存パターン（tools/gen-venue-pages.js のホットペッパー写真クレジットリンク）は
 *   rel="nofollow noopener" を、当サイトが内容を編集的に検証・保証していない第三者コンテンツへの
 *   リンクに使っている。それ以外の外部リンク（公式サイト・一次情報）は rel="noopener" のみ。
 *   この記事も同じ考え方を踏襲し、次のように分けている:
 *     - rel="noopener" のみ … 一次情報・客観報道として扱うもの
 *       （共同通信/時事通信/日本経済新聞の速報記事、警察庁の公式ページ、
 *        ポーカーギルド公式サイト＝記事内で紹介しているサービスの提供元）
 *     - rel="nofollow noopener" … 個人・第三者メディアによる法的見解・分析記事
 *       （note記事＝弁護士個人の見解、行政書士事務所コラム、light-three.com、
 *        pokeraianalyzer.com、@DIME）。本文中で再三「専門家の見解の紹介にとどまる」
 *        「当サイトが断定するものではない」とヘッジしているのと同じ理由で、
 *        これらの解釈記事を当サイトが太鼓判を押して推薦する形（dofollow）にはしない。
 *
 * 【店舗ページ・個別店舗への内部リンク禁止（レビュー部申し送り1）】
 *   本文中に /venues/ へのリンクを一切含めない。verify() で機械的に検査し、
 *   誤って追加された場合は生成を止める（gen-guide-pages.js の他の検算と同じ考え方）。
 *
 * 【免責文言は冒頭にも置く（レビュー部 NO-GO・2026-09-14差し戻し対応）】
 *   初回実装では .disclaimer（合法性の判定・保証をしない旨の免責文言）を記事末尾
 *   （出典一覧の直前）にしか置いていなかった。サイト内の他ページ（店舗ページ・イベントページ・
 *   guide/beginner/）は例外なく H1 直後・冒頭に .disclaimer を置く統一パターンを取っており、
 *   このページは風営法違反の摘発・実在サービスの規制動向というサイト内で最も法的センシティビティ
 *   が高いテーマを扱うため、「結論」だけ読んだ読者の目に免責文言が触れない構成は看過できない、
 *   というのがレビュー部の判断。冒頭（H1直後のlead段落の直後、.tbaの直前）にも同じ .disclaimer
 *   を追加し、末尾の .disclaimer はそのまま残す（二重掲載で問題ない、とレビュー部確認済み）。
 *
 * 使い方:
 *   node gen-guide-webcoin-regulation.js <リポジトリのパス>            … 生成する
 *   node gen-guide-webcoin-regulation.js <リポジトリのパス> --check     … 書き込まず、一致確認だけ行う
 */

'use strict';

const fs = require('fs');
const path = require('path');

const shell = require('./site-shell.js');
const { SITE, POSITIONING, pageHead, pageFoot } = shell;
const { sitemapFile } = require('./gen-sitemap.js');
const { footerAreaLinksHtml } = require('./area-schedule.js');

const PAGE_PATH = 'guide/webcoin-regulation/index.html';
const PAGE_URL = '/guide/webcoin-regulation/';
const CANONICAL = `${SITE}${PAGE_URL}`;

const TITLE = 'アミューズメントポーカーの「ウェブコイン」規制とは？｜2025年一斉調査から解説 | ふくおかポーカーナビ';
const DESC = '2025年12月、警視庁がアミューズメントカジノ約80店舗を一斉調査し、6割の店舗で風営法違反が確認されました。「ウェブコイン」の何が問題視されているのか、2026年に入ってからの動きも含めて、福岡でアミューズメントポーカーを楽しむプレイヤー向けにやさしく整理します。';

// ============================================================
// ページ固有CSS（見た目は既存の静的ページのデザイン言語を踏襲。BASE_CSSにある
// .disclaimer/.lead/h2.day/.tba 等はそのまま流用し、ここには「この記事に足りない分」だけを足す）
// ============================================================
const WC_CSS = `  .wc-toc{list-style:none;margin:0 0 16px;padding:0;font-size:.88em;line-height:1.9}
  .wc-toc li{padding-left:1.1em;position:relative}
  .wc-toc li::before{content:'▸';position:absolute;left:0;color:var(--gold)}
  .wc-toc a{color:#0e6a72;font-weight:700;text-decoration:none}
  .wc-toc a:hover{text-decoration:underline}
  .wc-rule{background:var(--sur);border:1px solid var(--bor);border-left:4px solid var(--gold);border-radius:10px;padding:12px 15px;margin:8px 0 14px;font-weight:800;color:var(--felt);font-size:.95em;line-height:1.7}
  /* 第4章(専門家の見解にとどまる論点)を、確定事実の章と視覚的に区別するための箱
     (レビュー部申し送り4)。破線の枠は「まだ確定していない」ことを示す目的で選んでいる。
     色は新しい色を増やさず、サイト内で既に使っている値(#7a5711=table.sched .gtdの文字色、
     #0e6a72=サイト共通のリンク色)を再利用する。 */
  .wc-opinion{background:#f7f5f0;border:1px dashed #c9beac;border-radius:10px;padding:13px 15px;margin-bottom:14px;font-size:.88em;line-height:1.85;color:var(--txt)}
  .wc-opinion .wc-op-label{display:block;font-weight:800;color:#7a5711;font-size:.85em;margin-bottom:6px}
  .wc-opinion a{color:#0e6a72;font-weight:700}
  .wc-opinion p+p{margin-top:8px}
  .wc-checklist{list-style:none;margin:6px 0 14px;padding:0;font-size:.88em;line-height:1.9}
  .wc-checklist li{padding-left:1.6em;position:relative;margin-bottom:4px}
  .wc-checklist li::before{content:'☐';position:absolute;left:0;top:0;color:var(--gold);font-weight:800}
  .wc-sources{list-style:none;margin:6px 0 14px;padding:0;font-size:.83em;line-height:2}
  .wc-sources a{color:#0e6a72;font-weight:700;word-break:break-all}
`;

// ---- 本文の組み立て ----
function buildBody() {
  return `
<h1>アミューズメントポーカーの「ウェブコイン」規制とは？2025年一斉調査からいま何が変わったかを解説</h1>
<p class="lead">${DESC}</p>
<div class="disclaimer">本記事は、特定のアミューズメントポーカー店・サービスの合法性を当サイトが判定・保証するものではありません。また、賭博行為を勧誘・仲介する意図のものでもありません。最新の状況については、必ず公的機関・各サービス運営元の公式発表をご確認ください。<br>${POSITIONING}</div>
<div class="tba"><b>最終確認日: 2026年9月14日。</b> このテーマは業界団体・各店舗の対応も含めて現在進行形で動いています。本記事は執筆時点で確認できた公的発表・報道をもとにまとめたものであり、今後の続報に応じて内容を更新する前提でお読みください。</div>

<ul class="wc-toc">
  <li><a href="#conclusion">この記事の結論(まずここだけ読みたい方へ)</a></li>
  <li><a href="#ch1">1. 何が起きたのか:2025年12月の一斉調査</a></li>
  <li><a href="#ch2">2. なぜ規制されるのか:風営法「5号営業」の基本ルール</a></li>
  <li><a href="#ch3">3. 「ウェブコイン」とは何が問題視されているのか</a></li>
  <li><a href="#ch4">4. サテライトトーナメント・協賛トーナメントを巡る論点</a></li>
  <li><a href="#ch5">5. 2026年のその後の動き:全国通達とサービス側の対応</a></li>
  <li><a href="#ch6">6. プレイヤーとして確認しておきたいことチェックリスト</a></li>
  <li><a href="#ch7">7. 福岡の店を利用する際の心構え</a></li>
  <li><a href="#summary">まとめ</a></li>
  <li><a href="#sources">出典一覧</a></li>
</ul>

<h2 class="day" id="conclusion">この記事の結論(まずここだけ読みたい方へ)</h2>
<ul style="margin:0 0 14px 1.3em;font-size:.9em;line-height:1.9">
  <li>2025年12月、警視庁が東京都内のアミューズメントカジノ約80店舗を一斉調査し、<b>6割にあたる48店舗で風営法違反が確認された</b>、と複数の通信社・新聞社が報じています。これは事実として明確に報道されている内容です。</li>
  <li>問題視されたのは「ウェブコイン」という仕組みそのものというより、<b>チップやポイントを賞品・飲食物と交換したり、店外に持ち出せる状態にしていた運用</b>です。</li>
  <li>「ウェブコインは廃止される」という情報がSNSで広がったこともありますが、少なくとも代表的なサービスの一つである「GameID」については、運営元が2026年9月時点で「廃止ではなく段階的な移行」と説明しています。</li>
  <li>福岡の店舗がどうなるかを断定できる情報は現時点でありません。本記事では特定店舗の評価は行わず、<b>プレイヤー自身が確認しておくとよいポイント</b>を整理します。</li>
</ul>

<h2 class="day" id="ch1">1. 何が起きたのか:2025年12月の一斉調査</h2>
<p class="lead">2025年12月12日から20日にかけて、警視庁保安課は東京都内のアミューズメントカジノ約80店舗に対して、初めてとなる一斉立入調査を実施しました。</p>
<p class="lead">調査の結果、次のことが明らかになったと報じられています。</p>
<ul style="margin:0 0 12px 1.3em;font-size:.9em;line-height:1.9">
  <li><b>調査対象のうち48店舗(約6割)で、計84件の風営法違反が確認された</b></li>
  <li>違反の内容として報じられているのは、主に次のようなものです。
    <ul style="margin:4px 0 0 1.2em">
      <li>チップやメダルを、賞品や店内の飲食物と<b>交換していた</b>こと</li>
      <li>チップやメダルの<b>店外への持ち出し</b>や、その保管を示す書面(預かり証のようなもの)を発行していたこと</li>
    </ul>
  </li>
  <li><b>調査対象80店舗のうち69店舗(8割超)で、複数の加盟店をまたいで使える「ウェブコイン」の導入が確認された</b></li>
  <li>警視庁は違反が確認された店舗に対して口頭指導を行い、悪質なケースについては行政処分も検討するとされています</li>
</ul>
<p class="lead">これらは警視庁の調査結果として複数の通信社・新聞社が一致して報じている内容であり、当サイト独自の見解ではなく、報道されている客観的な事実として押さえておいてください。</p>
<p class="lead">なお、この調査は東京都内の店舗を対象にしたものであり、記事内でも特定の店舗名は挙げません。福岡を含む他エリアの個別店舗が同様の状態にあるかどうかは、この調査結果だけからはわかりません。</p>

<h2 class="day" id="ch2">2. なぜ規制されるのか:風営法「5号営業」の基本ルール</h2>
<p class="lead">アミューズメントカジノやアミューズメントポーカー店の多くは、風俗営業等の規制及び業務の適正化等に関する法律(風営法)上の「5号営業」という枠組みで営業しています。</p>
<p class="lead">この5号営業には、プレイヤーとしてぜひ知っておきたい基本ルールがあります。それは、</p>
<div class="wc-rule">遊技の結果に応じて、金品などの賞品を提供することは法律で禁止されている</div>
<p class="lead">というものです。ゲームセンターの景品交換と混同されがちですが、5号営業の店舗が扱えるのは「遊技を楽しむためのサービス提供」までであり、「勝った・負けたに応じて価値のあるものを渡す」ことは想定されていません。</p>
<p class="lead">チップやポイントを使ってゲームの過程を楽しむこと自体は問題ではなく、そのチップやポイントが</p>
<ul style="margin:0 0 12px 1.3em;font-size:.9em;line-height:1.9">
  <li>店外の金品と交換できる(=事実上の換金)</li>
  <li>賞品や飲食物などと交換できる(=結果に応じた賞品提供)</li>
  <li>店外に持ち出せる、あるいは店外から残高を確認・移動できる</li>
</ul>
<p class="lead">といった状態になっていると、風営法上の問題として指摘される可能性が出てきます。2025年12月の一斉調査で摘発の対象となったのも、まさにこうした運用でした。</p>

<h2 class="day" id="ch3">3. 「ウェブコイン」とは何が問題視されているのか</h2>
<p class="lead">「ウェブコイン」とは、スマートフォンアプリを使って、複数の加盟店をまたいで共通のポイント(コイン)を利用できる仕組みの総称として使われている言葉です。1店舗の中で完結するチップ管理とは異なり、複数店舗・複数イベントで同じ残高を使い回せる点が特徴とされています。</p>
<p class="lead">例えば「POKERWEB COIN」は、ポーカーギルド株式会社が提供するポイントサービスで、複数の加盟店に加え、コインの取り扱いに対応したトーナメント・大会イベントでも利用できるとされています(参照: <a href="https://pokerguild.jp/pokerweb/coin_pokerroom/" target="_blank" rel="noopener">ポーカーギルド公式サイト</a>)。なお、JOPT(Japan Open Poker Tour)での具体的な利用・付与については後述(第5章)を参照してください。</p>
<p class="lead">こうした「複数店舗をまたいで使えるポイント」の仕組み自体が直ちに違法というわけではありませんが、専門家からは次のような点が指摘されています。</p>
<ul style="margin:0 0 12px 1.3em;font-size:.9em;line-height:1.9">
  <li>換金行為(コインを現金や現金同等物に換える行為)は明確に禁止される</li>
  <li>本来はチップ・ポイントの管理は店内で完結させる必要がある</li>
  <li>店外からアプリなどで残高を確認できる機能についても、問題視され得るとの見方がある</li>
  <li>今後、こうした運用に対する取り締まりがさらに厳しくなっていく可能性が高い</li>
</ul>
<p class="lead">これは弁護士の中野秀俊氏による解説記事で示されている見解です(参照: <a href="https://note.com/growwill/n/n3ad4a29a8bbd" target="_blank" rel="nofollow noopener">警視庁の一斉調査に見る、アミューズメントカジノのリスクと適法運営のポイント｜弁護士中野秀俊の法律相談所</a>)。専門家の見立てとして紹介するものであり、特定サービス・特定店舗の運用が違法であると当サイトが断定するものではありません。</p>

<h2 class="day" id="ch4">4. サテライトトーナメント・協賛トーナメントを巡る論点(現時点では専門家の見解にとどまる話)</h2>
<p class="lead">アミューズメントポーカーでは、大きな大会への「出場権」を懸けたサテライトトーナメントが各店舗で開催されることがあります。この出場権のチケットが、風営法上の「賞品」に該当しうるのではないか、という論点も一部で議論されています。</p>
<div class="wc-opinion">
  <span class="wc-op-label">⚠ ここから先は専門家の見解の紹介にとどまります(確定した公式見解ではありません)</span>
  <p>この論点そのものをピンポイントで扱った公式見解は見当たりませんが、近い方向性の議論として、行政書士事務所のコラムでは「参加費を原資として、勝敗に応じた商品を提供する仕組みは賭博行為に該当しうる」「大会への渡航費・参加費をサポートする名目での金品提供が違法と判断される可能性がある」といった、参加費を原資とするトーナメント賞品全般についての一般論が示されています(参照: <a href="https://r-sato-office.com/pokerbar-tournament/" target="_blank" rel="nofollow noopener">ポーカーバー・サテライトトーナメントと風営法｜行政書士事務所コラム</a>、2023年11月20日付)。このコラムはサテライトの「出場権チケット」という論点そのものを名指しで扱ったものではなく、あくまで参加費を原資とする賞品提供全般に関する一般的な見解である点に注意してください。</p>
  <p><b>警察庁や警視庁による、サテライトトーナメントの出場権を対象とした公式な規制強化の一次情報は、現時点(2026年9月)で確認できていません。</b>したがって、この論点については「近い方向性の議論を示す専門家もいる」という紹介にとどめます。前章までの一斉調査の結果(確定した事実)とは性質が異なる情報であることに注意してください。</p>
</div>

<h2 class="day" id="ch5">5. 2026年のその後の動き:全国通達とサービス側の対応</h2>
<p class="lead">2025年12月の一斉調査以降も、業界を取り巻く状況は動いています。時系列で整理すると次の通りです。</p>
<ul style="margin:0 0 12px 1.3em;font-size:.9em;line-height:1.9">
  <li><b>2026年7月付</b>: 警察庁が「遊技場営業について」の解釈運用基準を見直し、「遊技の結果に応じた賞品の提供が法律により禁止されている」ことを全国の警察・事業者向けに改めて明記しました(参照: <a href="https://www.npa.go.jp/bureau/safetylife/hoan/yugijoueigilyou.html" target="_blank" rel="noopener">警察庁「遊技場営業について」</a>)。ページ本文には公表日そのものは明記されていませんが、掲載されている公表資料のファイル名(<code>R080701kaisiyaku.pdf</code>)から2026年7月1日付とみられます。これにより、東京都内にとどまらず全国的にこのルールの徹底が図られている状況にあります。</li>
  <li><b>2026年2月28日</b>: ポーカーギルドが提供する「GameID」が、従来型の「ウェブコインリング」の運用を終了し、「認定ルール」という新しい枠組みへ移行すると発表しました。GameID公式X(@gameid_jp)の投稿を出典として、この経緯を整理した解説記事も出ています(参照: <a href="https://www.pokeraianalyzer.com/wc-ring-regulation-2026/" target="_blank" rel="nofollow noopener">【2026年最新】WCリング(ウェブコインリング)規制の全貌｜pokeraianalyzer.com</a>)。</li>
  <li><b>2026年9月</b>: SNS上で「ウェブコインが終了する」という情報が広まりましたが、GameID公式は「廃止ではなく段階的な移行である」と説明しています。保有しているコインの利用、JOPTでの賞金付与、大会イベントでの利用については継続する方針が示されています(参照: <a href="https://light-three.com/webcoin-update/" target="_blank" rel="nofollow noopener">ウェブコインの今後についてのお知らせ｜light-three.com</a>)。あわせて、JOPTのCEOである亀井翼氏も、店舗サテライト大会を継続する方針を表明しています。</li>
</ul>
<p class="lead">まとめると、「サービスが完全になくなる」という話ではなく、<b>運用ルールを法令に沿った形に見直す動きが、警察庁・事業者双方のレベルで進んでいる</b>という状況だと整理できます。ただし、この分野は変化が速く、本記事執筆時点(2026年9月14日)以降も新しい発表が出る可能性があります。</p>

<h2 class="day" id="ch6">6. プレイヤーとして確認しておきたいことチェックリスト</h2>
<p class="lead">規制の詳細を追いかけるよりも、プレイヤー自身が自分の使っているサービスについて次の点を確認しておくと安心です。</p>
<ul class="wc-checklist">
  <li>自分が持っているコイン・ポイントは、<b>店外の現金や商品に交換(換金)できる状態になっていないか</b></li>
  <li>出場を予定しているサテライトトーナメントの<b>出場権の原資が、店舗の参加費なのか、スポンサー・大会運営側の提供によるものなのか</b></li>
  <li>利用している店舗が、<b>風営法5号営業の許可を得て営業しているか</b>(店内掲示や公式サイトで確認できることが多い)</li>
  <li>利用しているコイン・ポイントサービスの<b>運営元による最新の公式アナウンス</b>を定期的にチェックしているか(SNSの又聞き情報だけで判断しない)</li>
</ul>
<p class="lead">これらは「違法かどうかをプレイヤーが自分で判定するため」のものではなく、<b>状況が変わりやすい時期だからこそ、自分の使っているサービスの状態を把握しておく</b>ためのチェックリストです。</p>

<h2 class="day" id="ch7">7. 福岡の店を利用する際の心構え</h2>
<p class="lead">本記事で紹介した一斉調査は東京都内の店舗を対象としたものであり、福岡のアミューズメントポーカー店がどのような運用になっているかについて、当サイトが個別に評価する情報ではありません。</p>
<p class="lead">現在は業界全体で運用の見直しが進んでいる時期です。ウェブコインやポイントの扱い、サテライトトーナメントの出場権の仕組みなど、気になる点があれば、<b>利用している(あるいは利用を検討している)店舗に直接問い合わせて確認する</b>のが最も確実です。誠実に営業している店舗であれば、こうした質問にきちんと答えてくれるはずです。</p>

<h2 class="day" id="summary">まとめ</h2>
<ul style="margin:0 0 14px 1.3em;font-size:.9em;line-height:1.9">
  <li>2025年12月、警視庁は東京都内のアミューズメントカジノ約80店舗を一斉調査し、6割にあたる48店舗で風営法違反(チップ・メダルの賞品交換、店外持ち出しなど)を確認したと報じられています。これは複数の通信社・新聞社が伝えている事実です。</li>
  <li>背景には、風営法5号営業において「遊技結果に応じた賞品提供」が禁止されているという基本ルールがあります。</li>
  <li>「ウェブコイン」という仕組み自体が即座に違法というわけではなく、換金や店外持ち出しにつながる運用が問題視されています。</li>
  <li>サテライトトーナメントの出場権を巡る論点は、現時点では専門家の見解の紹介にとどまり、公式な規制強化が確定した話ではありません。</li>
  <li>2026年7月には警察庁が全国向けに解釈運用基準を見直し、同年2月・9月にはサービス提供元(GameID)からも運用変更・説明のアナウンスが出ています。</li>
  <li>福岡の店舗を利用する際は、個別店舗の評価ではなく、自分のコイン・ポイントの状態や運営元の最新情報を自分自身で確認することをおすすめします。</li>
</ul>
<div class="disclaimer">本記事は、特定のアミューズメントポーカー店・サービスの合法性を当サイトが判定・保証するものではありません。また、賭博行為を勧誘・仲介する意図のものでもありません。最新の状況については、必ず公的機関・各サービス運営元の公式発表をご確認ください。<br>${POSITIONING}</div>

<h2 class="day" id="sources">出典一覧</h2>
<ul class="wc-sources">
  <li>共同通信: <a href="https://news.yahoo.co.jp/articles/837533c37fd47e502f542257367b3938745e4bdb" target="_blank" rel="noopener">news.yahoo.co.jp</a></li>
  <li>時事通信: <a href="https://www.jiji.com/jc/article?k=2025122200659&amp;g=soc" target="_blank" rel="noopener">jiji.com</a></li>
  <li>日本経済新聞: <a href="https://www.nikkei.com/article/DGXZQOUD22AXX0S5A221C2000000/" target="_blank" rel="noopener">nikkei.com</a></li>
  <li>@DIME「カジノ界隈で話題の『ウェブコイン』は違法なのか？気になるリスクと問題点について解説」: <a href="https://dime.jp/genre/2071156/" target="_blank" rel="nofollow noopener">dime.jp</a></li>
  <li>警察庁「遊技場営業について」: <a href="https://www.npa.go.jp/bureau/safetylife/hoan/yugijoueigilyou.html" target="_blank" rel="noopener">npa.go.jp</a></li>
  <li>ポーカーギルド公式サイト(POKERWEB COIN): <a href="https://pokerguild.jp/pokerweb/coin_pokerroom/" target="_blank" rel="noopener">pokerguild.jp</a></li>
  <li>note「警視庁の一斉調査に見る、アミューズメントカジノのリスクと適法運営のポイント｜弁護士中野秀俊の法律相談所」: <a href="https://note.com/growwill/n/n3ad4a29a8bbd" target="_blank" rel="nofollow noopener">note.com</a></li>
  <li>行政書士事務所コラム「ポーカーバー・サテライトトーナメントと風営法」: <a href="https://r-sato-office.com/pokerbar-tournament/" target="_blank" rel="nofollow noopener">r-sato-office.com</a></li>
  <li>light-three.com「ウェブコインの今後についてのお知らせ」: <a href="https://light-three.com/webcoin-update/" target="_blank" rel="nofollow noopener">light-three.com</a></li>
  <li>pokeraianalyzer.com「【2026年最新】WCリング(ウェブコインリング)規制の全貌」: <a href="https://www.pokeraianalyzer.com/wc-ring-regulation-2026/" target="_blank" rel="nofollow noopener">pokeraianalyzer.com</a></li>
</ul>
<p class="lead" style="margin-top:-6px">最終確認日: 2026年9月14日。本記事は今後の続報・公式発表を踏まえて内容を更新する場合があります。</p>`;
}

/**
 * ページ全体のHTML文字列を組み立てる。REPO は絶対パスで渡すこと
 * (pageFoot の恒久リンク行・エリアリンク行を組み立てるのに big-events.js / data.js を読む)。
 */
function buildPage(REPO) {
  const BIG = require(path.join(REPO, 'big-events.js'));
  const DATA = require(path.join(REPO, 'data.js'));
  const areaLinks = footerAreaLinksHtml(DATA.VENUES, DATA.AREAS);

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: TITLE,
    description: DESC,
    url: CANONICAL,
    inLanguage: 'ja',
    isPartOf: { '@type': 'WebSite', name: 'ふくおかポーカーナビ', url: `${SITE}/` }
  };
  const breadcrumb = [
    { name: 'ふくおかポーカーナビ', url: `${SITE}/` },
    { name: '「ウェブコイン」規制の解説', url: CANONICAL }
  ];

  const head = pageHead({
    title: TITLE,
    desc: DESC,
    canonical: CANONICAL,
    jsonld,
    breadcrumb,
    ogType: 'article',
    twitterCard: 'summary_large_image',
    extraCss: WC_CSS
  });
  const foot = pageFoot(BIG, null, null, areaLinks);
  return head + buildBody() + foot;
}

// ---- 検査(レビュー部申し送り1: 店舗一覧・個別店舗ページへのリンクを一切張らない) ----
function verify(html) {
  if (/href="[^"]*\/venues\/[^"]*"/.test(html)) {
    throw new Error('gen-guide-webcoin-regulation.js: この記事から店舗ページ(/venues/)へのリンクが検出されました。'
      + 'レビュー部の申し送り(特定店舗を評価しない立場を崩さないため、この記事からのリンクは禁止)により、'
      + '本文からこのリンクを取り除いてください。');
  }
  if (!html.includes(POSITIONING)) {
    throw new Error('gen-guide-webcoin-regulation.js: サイト共通の法的ポジショニング文(POSITIONING)が本文に見つかりません。');
  }
  if (!html.includes('本記事は、特定のアミューズメントポーカー店・サービスの合法性を当サイトが判定・保証するものではありません')) {
    throw new Error('gen-guide-webcoin-regulation.js: レビュー部申し送り2の免責文言が本文に見つかりません。');
  }
  // レビュー部 NO-GO(2026-09-14)差し戻し対応: 免責文言はH1直後(冒頭)にも無ければならない。
  // <h1>〜最初の<h2>(id="conclusion")までの範囲に.disclaimerが無ければ、末尾だけの掲載に
  // 戻ってしまっている(=「結論」だけ読んだ読者の目に免責文言が触れない)ため生成を止める。
  const h1 = html.indexOf('<h1>');
  const firstH2 = html.indexOf('<h2', h1 < 0 ? 0 : h1);
  if (h1 < 0 || firstH2 < 0 || !html.slice(h1, firstH2).includes('class="disclaimer"')) {
    throw new Error('gen-guide-webcoin-regulation.js: 冒頭(H1直後・最初の見出しより前)に .disclaimer が'
      + '見つかりません。レビュー部の申し送り(2026-09-14 NO-GO差し戻し)により、免責文言は記事末尾だけでなく'
      + '冒頭にも置く必要があります。');
  }
}

module.exports = { PAGE_PATH, PAGE_URL, CANONICAL, buildPage, verify };

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
      console.error('\n✗ 生成物が最新ではありません（node tools/gen-guide-webcoin-regulation.js <repo> を実行してください）:\n  - ' + stale.join('\n  - '));
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
    console.log(`完了。ウェブコイン規制の解説ページ 1件／ 書き換えたファイル ${wrote} 件`);
  }
}
