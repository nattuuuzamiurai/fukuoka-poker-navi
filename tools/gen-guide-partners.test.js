#!/usr/bin/env node
/**
 * gen-guide-partners.test.js — 掲載店舗向け案内ページ(/guide/partners/)の生成物のテスト
 *
 * 実行: node tools/gen-guide-partners.test.js (または node --test tools/*.test.js)
 *
 * 【何を守っているか】
 *   1. 生成が決定論的であること(--check の前提)
 *   2. サイト共通の法的ポジショニング文・店外アクセス不可の注記が本文に残っていること
 *   3. 法人名(合同会社・株式会社)を表記しないこと(このサイトは個人運営)
 *   4. 「アップセル」等の内部営業用語を使わないこと
 *   5. チップの換金・現金化を示唆する表現を含まないこと
 *   6. 確定済みの価格・文言(月額5,000円/10,000円、オプション+月額5,000円等)が残っていること
 *   7. お問い合わせフォーム(contact.html?type=listing)への導線があること
 *   8. 画面イメージが基本セット向け・オプションプラン向けの2ギャラリーに分かれ、
 *      マイページ・同卓プレイヤー情報が正しい側に、フロアマップがオプションプラン側にあること
 *   9. 会計画面が品目・時刻・担当・金額の4列テーブル(table.data-table)で表示されていること
 *  10. 掲載店舗数・トーナメント日程数がdata.jsから動的に算出され、ハードコードに戻っていないこと
 *      (休業中の店舗を除く・本日以降の日程のみを数える)
 *  11. 「トーナメント情報の更新は無料=月1回」という実態と異なる記載が残っていないこと
 *  12. 価格の税区分(税別)がPR掲載枠・基本セット・オプションプランの3箇所に明記されていること
 *  13. 同卓プレイヤー情報のオプトイン性(本人同意)、チップ・会計機能の店舗審査前提が明記されていること
 *  14. お問い合わせ導線がPR掲載枠(type=listing)/経営管理ダッシュボード(type=dashboard)で
 *      分かれていること
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { PAGE_PATH, PAGE_URL, buildPage, verify } = require('./gen-guide-partners.js');

const REPO = path.resolve(__dirname, '..');

test('PAGE_PATH / PAGE_URL は想定どおりのURL', () => {
  assert.equal(PAGE_PATH, 'guide/partners/index.html');
  assert.equal(PAGE_URL, '/guide/partners/');
});

test('決定論性: 同じ内容に対して2回生成しても同じ文字列になる', () => {
  const a = buildPage(REPO);
  const b = buildPage(REPO);
  assert.equal(a, b);
});

test('verify(): 正常な生成物は例外を投げない', () => {
  const html = buildPage(REPO);
  assert.doesNotThrow(() => verify(html));
});

test('サイト共通の法的ポジショニング文が含まれる', () => {
  const html = buildPage(REPO);
  assert.match(html, /当サイトは店舗・主催者が公開している情報を集約する媒体であり、賭博行為の勧誘・仲介を行うものではありません/);
});

test('経営管理ダッシュボードの店外アクセス不可の注記が含まれる', () => {
  const html = buildPage(REPO);
  assert.match(html, /店外・ご自宅からアクセスすることは一切できません/);
});

test('法人名(合同会社・株式会社)を含まない(このサイトは個人運営)', () => {
  const html = buildPage(REPO);
  assert.doesNotMatch(html, /合同会社|株式会社/);
});

test('検査(verify)は法人名らしき語が混入したら例外を投げる', () => {
  const html = buildPage(REPO);
  const injected = html.replace('<h1>', '<p>運営: エースハイ合同会社</p><h1>');
  assert.throws(() => verify(injected), /法人名/);
});

test('「アップセル」という内部営業用語を使わない(「オプションプラン」等の顧客向け語を使う)', () => {
  const html = buildPage(REPO);
  assert.doesNotMatch(html, /アップセル/);
  assert.match(html, /オプションプラン/);
});

test('検査(verify)は「アップセル」が混入したら例外を投げる', () => {
  const html = buildPage(REPO);
  const injected = html.replace('<h1>', '<p>アップセル施策</p><h1>');
  assert.throws(() => verify(injected), /アップセル/);
});

test('社内の部署名・役職名(社長・各部署等)を含まない', () => {
  const html = buildPage(REPO);
  for (const word of ['社長', '開発部', '企画部', '品質管理部', 'レビュー部', 'マーケティング部', '経営管理オフィス', '人事部', 'コンテンツ制作部']) {
    assert.doesNotMatch(html, new RegExp(word), `「${word}」が本文に含まれています`);
  }
});

test('チップの換金・現金化を示唆する表現を(許容された注記の1文を除いて)含まない', () => {
  const html = buildPage(REPO);
  const stripped = html.replace('現金化や店舗をまたいだ利用はできません', '');
  assert.doesNotMatch(stripped, /換金|現金化/);
});

test('確定済みの価格・文言が残っている(PR掲載枠・ダッシュボード基本セット・オプション)', () => {
  const html = buildPage(REPO);
  assert.match(html, /月額5,000円/);
  assert.match(html, /月額10,000円/);
  assert.match(html, /\+月額5,000円/);
  assert.match(html, /同卓プレイヤー情報/);
});

test('無料掲載との比較表に想定の全項目が含まれる(社長承認済みドラフトから移植)', () => {
  const html = buildPage(REPO);
  for (const label of ['店舗情報・トーナメント日程の掲載', 'トーナメント情報の反映', '表示順', '「PR」バッジ', '店舗名の★マーク', 'PR告知']) {
    assert.ok(html.includes(label), `比較表に「${label}」が見つかりません`);
  }
});

test('比較表はtable.compare構造で組まれている(移植元の構造をそのまま使う)', () => {
  const html = buildPage(REPO);
  assert.match(html, /<table class="compare">/);
  assert.match(html, /<th class="pr">PR掲載枠<\/th>/);
});

test('回帰防止: 「PR」バッジの行に文言が重複するバッジ表示を混ぜない(以前の崩れの原因)', () => {
  const html = buildPage(REPO);
  const row = html.match(/<tr><td>「PR」バッジ<\/td>.*?<\/tr>/s);
  assert.ok(row, '「PR」バッジの行が見つかりません');
  assert.doesNotMatch(row[0], /class="pt-badge"/, '「PR」バッジの行にインラインのpt-badgeが混入しています(表示が「「PR」バッジPR」のように重複して見える原因)');
});

test('画面イメージ: フロアマップの .mini-floor は aspect-ratio で高さを固定している(flex:1によるグリッド高さ揃えに依存しない)', () => {
  const html = buildPage(REPO);
  assert.match(html, /\.mini-floor\{[^}]*aspect-ratio:4\/3/);
});

test('回帰防止: フロアマップの座席名は1文字(頭文字のみ)ではなく2文字表示になっている', () => {
  const html = buildPage(REPO);
  const start = html.indexOf('<figcaption>フロアマップ<span>');
  const end = html.indexOf('</figure>', start);
  assert.ok(start >= 0 && end > start, 'フロアマップのカードが見つかりません');
  const section = html.slice(start, end);
  const names = [...section.matchAll(/class="mini-seat filled[^"]*"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.ok(names.length > 0, '着席中の座席(mini-seat filled)が見つかりません');
  for (const name of names) {
    assert.equal([...name].length, 2, `座席の表示名「${name}」が2文字ではありません(1文字だと頭文字だけになり分かりにくいという指摘があった)`);
  }
});

test('フロアマップはトーナメント卓(テーブルB・第48回週末オープン)に差し替わっている', () => {
  const html = buildPage(REPO);
  const start = html.indexOf('<figcaption>フロアマップ<span>');
  const end = html.indexOf('</figure>', start);
  const section = html.slice(start, end);
  assert.match(section, /テーブルB/);
  assert.match(section, /第48回 週末オープン/);
  for (const label of ['レジクロまでの時間', '現在のエントリー数', 'アドオン数', 'アベレージスタック', '総スタック']) {
    assert.ok(section.includes(label), `フロアマップに「${label}」が見つかりません`);
  }
  assert.match(section, /class="mini-table tourney"/);
  assert.doesNotMatch(section, /class="mini-seat"/, '空席(mini-seat単体、filled無し)が残っています(トーナメント卓は満席想定)');
});

test('CSS: トーナメント卓用の .mini-seat.filled.tourney / .mini-table.tourney がある(リング卓のfelt系と区別できる配色)', () => {
  const html = buildPage(REPO);
  assert.match(html, /\.mini-seat\.filled\.tourney\{/);
  assert.match(html, /\.mini-table\.tourney\{/);
});

test('.mini-seat のサイズは26px角(以前の22px角より拡大、2文字表示に対応)', () => {
  const html = buildPage(REPO);
  assert.match(html, /\.mini-seat\{[^}]*width:26px;height:26px/);
});

test('経営管理ダッシュボード(月額10,000円)の価格に「先行導入価格」であることを明示する説明文がある', () => {
  const html = buildPage(REPO);
  assert.match(html, /<b>先行導入価格<\/b>です/);
  assert.match(html, /既存契約店舗様には事前にご案内し、一方的な値上げは行いません/);
  // 「提供開始時期は別途ご案内します」は説明文側に1回だけ(pt-priceのsmallと重複させない)
  const hits = html.match(/提供開始時期は別途ご案内します/g) || [];
  assert.equal(hits.length, 1, `「提供開始時期は別途ご案内します」が${hits.length}回出現しています(重複していないか確認)`);
});

test('基本セットに「顧客チップ管理」が独立した項目として明記されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /<h4>顧客チップ管理<\/h4>/);
});

test('お問い合わせフォーム(contact.html?type=listing)への導線がある', () => {
  const html = buildPage(REPO);
  assert.match(html, /href="\/contact\.html\?type=listing"/);
});

test('開発中である旨(提供時期・仕様変更の可能性、正式リリース前の優先案内)が明記されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /現在開発中のサービスです/);
  assert.match(html, /優先的にご案内・ヒアリング/);
});

// ============================================================
// 画面イメージ: 基本セット向け/オプションプラン向けの2ギャラリーに分割されている
// ============================================================

test('画面イメージのギャラリー(.preview-gallery)は基本セット向け・オプションプラン向けの2つある', () => {
  const html = buildPage(REPO);
  const count = (html.match(/class="preview-gallery"/g) || []).length;
  assert.equal(count, 2, `.preview-galleryが${count}個見つかりました(基本セット向け・オプションプラン向けの2個を想定)`);
});

test('基本セットの画像ギャラリーに「マイページ」が新規追加されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /<figcaption>マイページ<span>/);
});

test('オプションプランの画像ギャラリーに「同卓プレイヤー情報」がトナメ卓・リング卓の両方で追加されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /<figcaption>同卓プレイヤー情報\(トナメ卓\)<span>/);
  assert.match(html, /<figcaption>同卓プレイヤー情報\(リング卓\)<span>/);
});

test('オプションプランの画像ギャラリーはフロアマップ・同卓プレイヤー情報(トナメ卓)・同卓プレイヤー情報(リング卓)の3枚構成', () => {
  const html = buildPage(REPO);
  const galleryStart = html.indexOf('<h3>画面イメージ(オプションプラン)</h3>');
  const galleryEnd = html.indexOf('<h2 class="day" id="contact">');
  assert.ok(galleryStart >= 0 && galleryEnd > galleryStart, 'オプションプランの画面イメージ区間が見つかりません');
  const section = html.slice(galleryStart, galleryEnd);
  const count = (section.match(/<figure class="preview">/g) || []).length;
  assert.equal(count, 3, `オプションプラン側のギャラリーに<figure>が${count}枚しかありません(フロアマップ・トナメ卓・リング卓の3枚を想定)`);
});

test('並び順: 「マイページ」の画像は基本セットの見出しより後・「オプションプラン」の見出しより前にある', () => {
  const html = buildPage(REPO);
  const basicH3 = html.indexOf('<h3>基本セット');
  const myPage = html.indexOf('<figcaption>マイページ<span>');
  const optionH3 = html.indexOf('<h3>オプションプラン');
  assert.ok(basicH3 >= 0 && myPage > basicH3 && optionH3 > myPage,
    `想定の並び順になっていません(基本セット見出し=${basicH3}, マイページ=${myPage}, オプションプラン見出し=${optionH3})`);
});

test('並び順: 「フロアマップ」「同卓プレイヤー情報」の画像は、店外アクセス不可の注記より後にある(オプションプラン側のギャラリー)', () => {
  const html = buildPage(REPO);
  const note = html.indexOf('店外からは一切アクセスできない設計です');
  const floor = html.indexOf('<figcaption>フロアマップ<span>');
  const guestTourney = html.indexOf('<figcaption>同卓プレイヤー情報(トナメ卓)<span>');
  const guestRing = html.indexOf('<figcaption>同卓プレイヤー情報(リング卓)<span>');
  assert.ok(note >= 0 && floor > note && guestTourney > note && guestRing > note,
    `想定の並び順になっていません(注記=${note}, フロアマップ=${floor}, トナメ卓=${guestTourney}, リング卓=${guestRing})`);
});

test('会計画面は品目・時刻・担当・金額の4列テーブル(table.data-table)で表示されている', () => {
  const html = buildPage(REPO);
  const start = html.indexOf('<figcaption>会計画面<span>');
  const end = html.indexOf('</figure>', start);
  assert.ok(start >= 0 && end > start, '会計画面のカードが見つかりません');
  const section = html.slice(start, end);
  assert.match(section, /<table class="data-table">/);
  assert.match(section, /<th>品目<\/th><th>時刻<\/th><th>担当<\/th><th>金額<\/th>/);
  assert.match(section, /はやと/);
  assert.match(section, /みずき/);
  assert.match(section, /合計\(退店時にまとめて精算\)/);
});

test('マイページ・同卓プレイヤー情報(トナメ卓)のカードは.stat-mini-row/table.data-tableの構造を踏襲している', () => {
  const html = buildPage(REPO);
  const myPageStart = html.indexOf('<figcaption>マイページ<span>');
  const myPageEnd = html.indexOf('</figure>', myPageStart);
  const myPageSection = html.slice(myPageStart, myPageEnd);
  assert.match(myPageSection, /class="stat-mini-row"/);
  assert.match(myPageSection, /<table class="data-table">/);
  assert.match(myPageSection, /参加回数/);
  assert.match(myPageSection, /インマネ率/);

  const guestStart = html.indexOf('<figcaption>同卓プレイヤー情報(トナメ卓)<span>');
  const guestEnd = html.indexOf('</figure>', guestStart);
  const guestSection = html.slice(guestStart, guestEnd);
  assert.match(guestSection, /class="guest-card"/);
  assert.match(guestSection, /class="stat-mini-row"/);
  assert.match(guestSection, /<table class="data-table">/);
});

test('同卓プレイヤー情報(リング卓)のカードは、だいきさんのチップ収支関連の指標を含む(.guest-card/.stat-mini-row構造)', () => {
  const html = buildPage(REPO);
  const start = html.indexOf('<figcaption>同卓プレイヤー情報(リング卓)<span>');
  const end = html.indexOf('</figure>', start);
  assert.ok(start >= 0 && end > start, '同卓プレイヤー情報(リング卓)のカードが見つかりません');
  const section = html.slice(start, end);
  assert.match(section, /class="guest-card"/);
  assert.match(section, /class="stat-mini-row"/);
  assert.match(section, /だいき さん/);
  for (const label of ['総持ちチップ(CHIP)', '月間来店回数', '平均バイイン(CHIP)', '1ヶ月の平均収支(CHIP)', '収支中央値(CHIP)']) {
    assert.ok(section.includes(label), `同卓プレイヤー情報(リング卓)に「${label}」が見つかりません`);
  }
  assert.match(section, /アグレッシブ型/);
});

test('マイページの「ポイント」は現金ではない旨の注記があり、店内飲食券・次回利用券等との交換や交換レート(飲食物との交換を示唆しうる表現)を含まない(2026-09-19、レビュー指摘によりウェブコイン規制解説ページの違反パターンと構造的に近い表現を削除)', () => {
  const html = buildPage(REPO);
  assert.match(html, /マイページのトーナメント成績にある「ポイント」は現金ではありません/);
  assert.doesNotMatch(html, /店内飲食券/);
  assert.doesNotMatch(html, /次回利用券/);
  assert.doesNotMatch(html, /1pt\s*=\s*1円/);
});

// ============================================================
// 品質チェック指摘対応(2026-09-19)
// ============================================================

const { siteStats, buildDesc, todayJst } = require('./gen-guide-partners.js');
const DATA = require(path.join(REPO, 'data.js'));

test('回帰防止: 「トーナメント情報の更新: 無料=月1回」という実態と異なる記載を含まない(全店舗が日次自動更新されている実態と矛盾していた)', () => {
  const html = buildPage(REPO);
  assert.doesNotMatch(html, /月1回\(月次更新\)/);
  assert.match(html, /自動取得による標準反映/);
  assert.match(html, /店舗様のご依頼内容を優先反映/);
});

test('掲載店舗数・トーナメント日程数はdata.jsから動的に算出される(ハードコードしない)', () => {
  const stats = siteStats(DATA);
  assert.ok(stats.venueCount > 0, '掲載店舗数が0以下です');
  assert.ok(stats.tournamentCount > 0, 'トーナメント日程数が0以下です');
  // data.js を直接集計した値と一致すること(siteStats()の実装が正しいことの確認)。
  // 【2026-09-19修正】以前はここが `!v.closed` のみのフィルタで、siteStats() 側の
  // preopen除外漏れと同じ(誤った)条件を使っていたため、バグをそのまま追認するテストに
  // なっていた(品質再チェックで指摘)。data.js冒頭コメントの既定ルールどおり
  // `!v.preopen && !v.closed` に揃える。
  const today = todayJst();
  const expectedVenueCount = DATA.VENUES.filter(v => !v.preopen && !v.closed).length;
  const expectedTournamentCount = DATA.TOURNAMENTS.filter(t => t.date >= today).length;
  assert.equal(stats.venueCount, expectedVenueCount);
  assert.equal(stats.tournamentCount, expectedTournamentCount);

  const html = buildPage(REPO);
  assert.match(html, new RegExp(`アミューズメントポーカー店${stats.venueCount}店舗`));
  assert.match(html, new RegExp(`今後開催予定のトーナメント日程${stats.tournamentCount}件`));
});

test('siteStats(): 休業中(closed:true)・開店前(preopen:true)の店舗は、それぞれ個別に掲載店舗数から除外される', () => {
  const closedIds = new Set(DATA.VENUES.filter(v => v.closed).map(v => v.id));
  const preopenIds = new Set(DATA.VENUES.filter(v => v.preopen).map(v => v.id));
  assert.ok(closedIds.size > 0, '前提: data.jsに休業中の店舗が1件も無く、この検査の意味がありません');
  assert.ok(preopenIds.size > 0, '前提: data.jsに開店前の店舗が1件も無く、この検査の意味がありません');

  const stats = siteStats(DATA);
  const countedIds = new Set(DATA.VENUES.filter(v => !v.preopen && !v.closed).map(v => v.id));
  assert.equal(stats.venueCount, countedIds.size);
  for (const id of closedIds) {
    assert.ok(!countedIds.has(id), `closed:trueの店舗(${id})が掲載店舗数に含まれています`);
  }
  for (const id of preopenIds) {
    assert.ok(!countedIds.has(id), `preopen:trueの店舗(${id})が掲載店舗数に含まれています`);
  }
});

test('クロスチェック: 掲載店舗数は /guide/beginner/(tools/gen-guide-pages.js の生成物)の店舗数と一致する(再発防止)', () => {
  // gen-guide-pages.js はCLI引数に依存するトップレベルコードを持つためrequireできない
  // (gen-guide-webcoin-regulation.js 冒頭コメント参照)。実際に公開される
  // guide/beginner/index.html(同じ data.js から独立に「35店舗」を算出している)を読み、
  // その表示数と siteStats() の算出結果が一致することを確認する。formulaを使い回す
  // トートロジーではなく、別ページの実際の生成結果との突き合わせになっている点がポイント。
  const beginnerPath = path.join(REPO, 'guide/beginner/index.html');
  const beginnerHtml = fs.readFileSync(beginnerPath, 'utf8');
  const m = beginnerHtml.match(/福岡には(\d+)店舗のポーカー店があります/);
  assert.ok(m, '/guide/beginner/ から店舗数を抽出できませんでした(文言が変わっていないか、node tools/gen-guide-pages.js . を実行して最新化されているか確認してください)');
  const beginnerVenueCount = Number(m[1]);

  const stats = siteStats(DATA);
  assert.equal(stats.venueCount, beginnerVenueCount,
    `guide/partners(${stats.venueCount}店舗)とguide/beginner(${beginnerVenueCount}店舗)の掲載店舗数が一致しません`);
});

test('siteStats(): トーナメント日程数は本日(JST)より前の日付(過去分)を含まない', () => {
  const today = todayJst();
  const stats = siteStats(DATA);
  const pastCount = DATA.TOURNAMENTS.filter(t => t.date < today).length;
  assert.ok(pastCount > 0, '前提: data.jsに過去日程が1件も無く、この検査の意味がありません');
  assert.ok(stats.tournamentCount < DATA.TOURNAMENTS.length, '過去分を除外できていません(TOURNAMENTS全件と同じ件数になっています)');
});

test('buildDesc(): 「件超」ではなく実数をそのまま表示する(概数表記に戻さない)', () => {
  const desc = buildDesc({ venueCount: 36, tournamentCount: 179 });
  assert.match(desc, /36店舗/);
  assert.match(desc, /179件/);
  assert.doesNotMatch(desc, /件超/);
});

test('回帰防止: ソースコード(tools/gen-guide-partners.js)に「35店舗」「300件超」という当時のハードコード値を書き戻していない', () => {
  // 【なぜ生成後のHTMLではなくソースコードを見るか】掲載店舗数は動的算出のため、
  // data.jsの実データ次第で偶然「35店舗」に一致する日もある(実際、この修正時点でも
  // 35店舗)。生成後のHTMLを文字列一致で検査すると「正しく動的算出できているのに
  // たまたま同じ値だから」誤って落ちてしまう。ハードコードの再発は
  // buildDesc()/siteStats() の実装(ソースコード)側にしか現れないため、そちらを見る。
  // ファイル冒頭のコメントには修正の経緯として「35店舗・300件超」という当時の値への
  // 言及が残るため(それ自体は問題ない)、ファイル全体ではなく buildDesc()/siteStats() の
  // 関数本体だけを取り出して検査する(実装側に数値がハードコードされていないことの確認)。
  const src = fs.readFileSync(path.join(REPO, 'tools', 'gen-guide-partners.js'), 'utf8');
  for (const fnName of ['buildDesc', 'siteStats']) {
    const marker = `function ${fnName}(`;
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${fnName}() が見つかりません(目印を動かしたなら、このテストの目印も直すこと)`);
    const end = src.indexOf('\n}', start) + '\n}'.length;
    const body = src.slice(start, end);
    assert.doesNotMatch(body, /35店舗/, `${fnName}() に「35店舗」がハードコードされています`);
    assert.doesNotMatch(body, /300件超/, `${fnName}() に「300件超」がハードコードされています`);
  }
});

test('回帰防止: 「件超」という概数表記が復活していない(常に実数をそのまま表示する)', () => {
  const html = buildPage(REPO);
  assert.doesNotMatch(html, /件超/);
});

test('価格の税区分(税別)がPR掲載枠・基本セット・オプションプランの3箇所に明記されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /月額5,000円\(税別\)/);
  assert.match(html, /月額10,000円\(税別\)/);
  assert.match(html, /\+月額5,000円\(税別\)/);
});

test('同卓プレイヤー情報のオプトイン性(本人同意)が明記されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /本人が公開に同意した情報のみ表示され、同意していない場合は表示されません/);
});

test('チップ・会計関連機能は店舗審査を完了した店舗様から順次提供する旨が明記されている', () => {
  const html = buildPage(REPO);
  assert.match(html, /特にチップ・会計関連の機能は、店舗審査を完了した店舗様から順次提供します/);
});

test('お問い合わせ導線: PR掲載枠はtype=listing、経営管理ダッシュボードはtype=dashboardにリンクしている', () => {
  const html = buildPage(REPO);
  assert.match(html, /href="\/contact\.html\?type=listing">▶ PR掲載枠のご相談はこちら/);
  assert.match(html, /href="\/contact\.html\?type=dashboard">▶ 経営管理ダッシュボードのご相談はこちら/);
});
