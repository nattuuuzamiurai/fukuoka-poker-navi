#!/usr/bin/env node
/**
 * gen-top-faq.js — トップページ(index.html)「よくある質問」セクションの生成スクリプト
 *
 * 【なぜこのファイルがあるか】
 *   GEO(Generative Engine Optimization)監査(2026-09-03・marketing-lead)で、FAQPageスキーマが
 *   サイト全体で events/fst-2026-fukuoka/ にしか無く、最も見られるトップページに無いことが
 *   優先度「高」の指摘として挙がった(監査3章①)。同時に、FSTページの fstFaqBlock() が
 *   FST専用にハードコードされていて複製すると片方だけ直して片方を忘れる事故が起きる、
 *   という指摘も受けている(監査3章①④)。
 *
 *   質問配列→表示HTML+FAQPage構造化データを組み立てるロジックは
 *   tools/site-shell.js の faqBlock()/FAQ_CSS に1本化済み(FSTページ・トップページ共用)。
 *   このファイルは「トップページ用の質問配列(内容)」と「index.html への同期」だけを持つ。
 *
 * 【同期する3箇所】(いずれも index.html に <!-- FAQ_xxx:START/END --> マーカーで用意してある)
 *   1. <head> 内の FAQPage JSON-LD          … <!-- FAQ_JSONLD:START/END -->
 *   2. <style> 内のFAQ用CSS(FAQ_CSSと同一)  … /* FAQ_CSS:START/END *\/
 *   3. <main> 内の表示用HTML(<details>群)   … <!-- FAQ_SECTION:START/END -->
 *   3箇所とも「見つからない」「複数見つかる」は意図しない状態として必ず落とす
 *   (このリポジトリの他の同期処理(#evtLinks・#venueLinks・#areaLinks)と同じ方針)。
 *
 * 【FAQの内容について】
 *   質問・回答は事実確認済み(コンテンツ制作部 geo-content-draft-2026-09.md・2026-09-03)。
 *   既存の実装・文言(index.htmlの絞り込みUI、tools/site-shell.js の POSITIONING 定数、
 *   contact.html の「掲載内容の誤り・修正依頼」カテゴリ)をそのまま踏襲しており、
 *   新規の事実主張・数値は作っていない。Q3(更新頻度)の具体的な頻度レンジは、
 *   経営管理オフィスが2026-09-03にGitHub Actions実行履歴で追加確認済み(ドラフト参照)。
 *   文言を変えるときは、about.html の「情報源・更新方針」節の対応する記述も
 *   【同時に】直すこと(表現がズレると複製の教訓と同じ問題が起きる)。
 *
 * 使い方:
 *   node gen-top-faq.js <リポジトリのパス>            … index.html を同期する
 *   node gen-top-faq.js <リポジトリのパス> --check     … 書き込まず、一致するかだけ見る
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REPO_ARG = args.filter(a => !a.startsWith('--'))[0];
if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
const REPO = path.resolve(REPO_ARG);

const shell = require('./site-shell.js');
const { faqBlock, FAQ_CSS } = shell;

// ---- トップページ用FAQ(5問) ----
// aHtml … 画面表示用(リンクつき)。aText … FAQPage構造化データ用のプレーンテキスト。
const TOP_FAQ_ITEMS = [
  {
    q: '福岡でポーカー大会・トーナメントを探すにはどうすればいい？',
    aHtml: 'トップページ上部の絞り込み機能から探せます。日付バーで日にちを選び、「エリア」「種類」（サテライト／PLO／NLH）のプルダウンで条件を指定すると、その条件に合う福岡県内のポーカー大会・トーナメントが一覧表示されます。地名から探したい場合は<a href="#areaNav">エリアから探す</a>からも店舗一覧を確認できます。',
    aText: 'トップページ上部の絞り込み機能から探せます。日付バーで日にちを選び、「エリア」「種類」(サテライト／PLO／NLH)のプルダウンで条件を指定すると、その条件に合う福岡県内のポーカー大会・トーナメントが一覧表示されます。地名から探したい場合は「エリアから探す」からも店舗一覧を確認できます。'
  },
  {
    q: '今日開催されているポーカー大会はすぐ分かる？',
    aHtml: 'はい。トップページを開くと当日の日付が自動的に選択された状態で表示され、「本日開催」の件数もひと目で確認できます。日付を他の日に切り替えたあとは「今日」ボタンで、すぐに本日の表示に戻せます。',
    aText: 'はい。トップページを開くと当日の日付が自動的に選択された状態で表示され、「本日開催」の件数もひと目で確認できます。日付を他の日に切り替えたあとは「今日」ボタンで、すぐに本日の表示に戻せます。'
  },
  {
    q: '掲載している店舗・大会情報はどのくらいの頻度で更新される？',
    aHtml: '情報源によって更新頻度が異なります。<br>・DMM Waitinglist（予約システム）と連携している一部の店舗：毎日06:23（日本時間）に自動で最新の日程を取得・反映<br>・Instagramで告知される一部店舗：月末月初（毎月24日ごろ〜翌月10日ごろ）は毎日、それ以外の時期は週1回のペースで新着投稿を自動チェックし反映<br>・それ以外の店舗：運営が公式サイト・SNS等を随時確認し、判明した時点で手動反映（更新の間隔は店舗により異なります）<br>開催内容は変更されることもあるため、参加前には各店舗・主催者の公式情報もあわせてご確認ください。',
    aText: '情報源によって更新頻度が異なります。DMM Waitinglist(予約システム)と連携している一部の店舗は、毎日06:23(日本時間)に自動で最新の日程を取得・反映しています。Instagramで告知される一部店舗は、月末月初(毎月24日ごろ〜翌月10日ごろ)は毎日、それ以外の時期は週1回のペースで新着投稿を自動チェックし、日程の告知があれば反映しています。それ以外の店舗については、運営が各店舗の公式サイト・SNS等を随時確認し、判明した時点で手動で反映しており、更新の間隔は店舗ごとに異なります。開催内容は変更されることもあるため、参加前には各店舗・主催者の公式情報もあわせてご確認ください。'
  },
  {
    q: '掲載内容に誤りがあった場合はどうすればいい？',
    aHtml: '<a href="contact.html">お問い合わせフォーム</a>の「お問い合わせ種別」で「掲載内容の誤り・修正依頼」を選び、誤りの内容をご記入のうえ送信してください。運営（エースハイ合同会社）が確認し、必要に応じて掲載内容を修正します。',
    aText: 'お問い合わせフォームの「お問い合わせ種別」で「掲載内容の誤り・修正依頼」を選び、誤りの内容をご記入のうえ送信してください。運営(エースハイ合同会社)が確認し、必要に応じて掲載内容を修正します。'
  },
  {
    q: 'このサイトは大会の公式情報ですか？',
    aHtml: 'いいえ、当サイトは各店舗・大会の主催者ではなく、公式媒体でもありません。当サイトは店舗・主催者が公開している情報を集約する媒体であり、賭博行為の勧誘・仲介を行うものではありません。最新情報や参加条件は、必ず各店舗・大会の公式サイト・SNS等でご確認ください。',
    aText: 'いいえ、当サイトは各店舗・大会の主催者ではなく、公式媒体でもありません。当サイトは店舗・主催者が公開している情報を集約する媒体であり、賭博行為の勧誘・仲介を行うものではありません。最新情報や参加条件は、必ず各店舗・大会の公式サイト・SNS等でご確認ください。'
  }
];

const { html: FAQ_HTML, script: FAQ_SCRIPT } = faqBlock(TOP_FAQ_ITEMS, { headingId: 'faq' });

// ---- マーカー間の同期処理 ----
// 「見つからない」「複数見つかる」はどちらも意図しない状態なので、
// 黙って通さず必ず落とす(このリポジトリの #evtLinks 等と同じ方針)。
function syncBetweenMarkers(src, startMarker, endMarker, inner, label) {
  const re = new RegExp(
    escapeRe(startMarker) + '[\\s\\S]*?' + escapeRe(endMarker),
    'g'
  );
  const hits = src.match(re) || [];
  if (hits.length !== 1) {
    throw new Error(`index.html の${label}マーカー(${startMarker} 〜 ${endMarker})が ${hits.length} 件見つかりました。`
      + '1件だけ置いてください(同期できません)。');
  }
  return src.replace(re, `${startMarker}\n${inner}\n${endMarker}`);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ★ 開始・終了とも【それ単体で閉じたコメント/コメント行】にすること。
//   以前 `<!-- FAQ_JSONLD:START`(閉じ `-->` なし)を開始マーカーにしていたところ、
//   置換後の文字列がそのまま次の `-->`(終了マーカー側)まで1個のHTMLコメントとして解釈され、
//   中に置いたはずの <script type="application/ld+json"> ごとコメントアウトされてしまい、
//   クローラから見えなくなる事故が起きた(2026-09-03に実装時点で発見・修正)。
function buildIndexHtml() {
  let src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  src = syncBetweenMarkers(src, '<!-- FAQ_JSONLD:START -->', '<!-- FAQ_JSONLD:END -->', FAQ_SCRIPT, 'JSON-LD');
  src = syncBetweenMarkers(src, '/* FAQ_CSS:START */', '/* FAQ_CSS:END */', FAQ_CSS.replace(/\n$/, ''), 'CSS');
  src = syncBetweenMarkers(src, '<!-- FAQ_SECTION:START -->', '<!-- FAQ_SECTION:END -->', FAQ_HTML.replace(/^\n/, ''), 'HTML');
  return src;
}

// ---- 書き出し / 検査 ----
const p = path.join(REPO, 'index.html');
const want = buildIndexHtml();
const cur = fs.readFileSync(p, 'utf8');

if (CHECK) {
  if (cur !== want) {
    console.error('\n✗ index.html のFAQセクションが最新ではありません（node tools/gen-top-faq.js <repo> を実行してください）');
    process.exit(1);
  }
  console.log('検査: index.html のFAQセクション(' + TOP_FAQ_ITEMS.length + '問)は最新');
} else if (cur === want) {
  console.log('据置: index.html (FAQセクション・変更なし)');
} else {
  fs.writeFileSync(p, want, 'utf8');
  console.log('生成: index.html のFAQセクションを同期（' + TOP_FAQ_ITEMS.length + '問）');
}
