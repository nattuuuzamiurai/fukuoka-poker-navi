#!/usr/bin/env node
/**
 * gen-guide-webcoin-regulation.test.js — 「ウェブコイン」規制解説記事の生成物のテスト
 *
 * 実行: node tools/gen-guide-webcoin-regulation.test.js
 *
 * 【何を守っているか】レビューの申し送り(GO判定時)を機械的に固定する。
 *   1. 店舗一覧・個別店舗ページ(/venues/)への内部リンクを一切含まないこと(申し送り1)
 *   2. 免責文言・サイト共通の法的ポジショニング文が本文に残っていること(申し送り2)
 *   3. 第4章(専門家の見解にとどまる論点)が、他の章と別のCSSクラス(.wc-opinion)で
 *      視覚的に区別されていること(申し送り4)
 *   4. 外部リンクのrel属性が、既存サイトのリンクポリシーどおりに分かれていること(申し送り5)
 *   5. 生成が決定論的であること(--check の前提)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PAGE_PATH, PAGE_URL, buildPage, verify } = require('./gen-guide-webcoin-regulation.js');

const REPO = path.resolve(__dirname, '..');

test('PAGE_PATH / PAGE_URL は想定どおりのURL', () => {
  assert.equal(PAGE_PATH, 'guide/webcoin-regulation/index.html');
  assert.equal(PAGE_URL, '/guide/webcoin-regulation/');
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

test('申し送り1: 店舗ページ(/venues/)への内部リンクを一切含まない', () => {
  const html = buildPage(REPO);
  assert.doesNotMatch(html, /href="[^"]*\/venues\/[^"]*"/);
});

test('申し送り1: 検査(verify)は /venues/ へのリンクが混入したら例外を投げる', () => {
  const html = buildPage(REPO);
  const injected = html.replace(
    '<h1>',
    '<a href="/venues/dummy-slug/">店舗</a><h1>'
  );
  assert.throws(() => verify(injected), /venues/);
});

test('申し送り2: 免責文言とサイト共通ポジショニング文が両方含まれる', () => {
  const html = buildPage(REPO);
  assert.match(html, /特定のアミューズメントポーカー店・サービスの合法性を当サイトが判定・保証するものではありません/);
  assert.match(html, /当サイトは店舗・主催者が公開している情報を集約する媒体であり、賭博行為の勧誘・仲介を行うものではありません/);
});

test('NO-GO差し戻し対応(2026-09-14): .disclaimer は冒頭(H1直後・最初の見出しより前)にも存在する', () => {
  const html = buildPage(REPO);
  const h1 = html.indexOf('<h1>');
  const firstH2 = html.indexOf('<h2', h1);
  assert.ok(h1 >= 0 && firstH2 > h1, '<h1> または最初の<h2>が見つかりません');
  const introSection = html.slice(h1, firstH2);
  assert.match(introSection, /class="disclaimer"/, '冒頭に.disclaimerが見つかりません(「結論」だけ読んだ読者の目に免責文言が触れない構成になっている)');
  assert.match(introSection, /特定のアミューズメントポーカー店・サービスの合法性を当サイトが判定・保証するものではありません/);
  // 末尾の.disclaimerと二重掲載であることも確認する(末尾を消してしまう回帰を防ぐ)
  const disclaimerCount = (html.match(/class="disclaimer"/g) || []).length;
  assert.equal(disclaimerCount, 2, `.disclaimer は冒頭+末尾の2箇所にあるはずですが${disclaimerCount}箇所でした`);
});

test('NO-GO差し戻し対応(2026-09-14): 検査(verify)は冒頭の.disclaimerが欠けたら例外を投げる', () => {
  const html = buildPage(REPO);
  const injected = html.replace('<div class="disclaimer">本記事は、特定のアミューズメントポーカー店', '<div class="tba-removed">本記事は、特定のアミューズメントポーカー店');
  assert.throws(() => verify(injected), /冒頭/);
});

test('申し送り3: 最終確認日の記載が2箇所(冒頭の告知・末尾)にある', () => {
  const html = buildPage(REPO);
  const hits = html.match(/最終確認日[:：]\s*2026年9月14日/g) || [];
  assert.ok(hits.length >= 2, `「最終確認日」の記載が${hits.length}件しかありません`);
});

test('申し送り4: 第4章(専門家の見解にとどまる論点)は .wc-opinion で視覚的に区別されている', () => {
  const html = buildPage(REPO);
  const ch4 = html.indexOf('id="ch4"');
  const ch5 = html.indexOf('id="ch5"');
  assert.ok(ch4 >= 0 && ch5 > ch4, '第4章の見出し(id="ch4")が見つからないか、第5章より後ろにあります');
  const ch4Section = html.slice(ch4, ch5);
  assert.match(ch4Section, /class="wc-opinion"/);
  assert.match(ch4Section, /専門家の見解の紹介にとどまります/);
});

// 正規表現の特殊文字をエスケープする(標準的なイディオム)。
// ★以前このテストはエスケープの文字クラスを書き間違えており(`[.*+?^${}()|[\\]\\\\]`)、
//   実質どの文字もエスケープしないまま通っていた。"."/"?" はエスケープを誤ってもURL中では
//   たまたまマッチが成立してしまう(quantifier化しても結果的に一致する)ため見た目には気づけず、
//   クエリに"?"を含む時事通信のURLを足したときに初めて不一致で失敗して発覚した。
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('申し送り5: 外部リンクのrel属性が既存サイトのポリシーどおりに分かれている', () => {
  const html = buildPage(REPO);
  // 一次情報・客観報道はrel="noopener"のみ(nofollowを付けない)
  // ★時事通信のURLはクエリに"&"を含むため、実際のHTML上では"&amp;"にエスケープされている。
  //   href文字列はHTMLエスケープ後の値でマッチさせる(生のURLのままだと一致しない)。
  const primarySources = [
    'https://news.yahoo.co.jp/articles/837533c37fd47e502f542257367b3938745e4bdb',
    'https://www.jiji.com/jc/article?k=2025122200659&amp;g=soc',
    'https://www.nikkei.com/article/DGXZQOUD22AXX0S5A221C2000000/',
    'https://www.npa.go.jp/bureau/safetylife/hoan/yugijoueigilyou.html',
    'https://pokerguild.jp/pokerweb/coin_pokerroom/'
  ];
  for (const url of primarySources) {
    const re = new RegExp(`href="${escapeRegExp(url)}"[^>]*rel="([^"]*)"`);
    const m = html.match(re);
    assert.ok(m, `${url} へのリンクが見つかりません`);
    assert.equal(m[1], 'noopener', `${url} は rel="noopener" のみを期待(実際: ${m[1]})`);
  }
  // 第三者の分析・見解記事はrel="nofollow noopener"
  const secondarySources = [
    'https://note.com/growwill/n/n3ad4a29a8bbd',
    'https://r-sato-office.com/pokerbar-tournament/',
    'https://light-three.com/webcoin-update/',
    'https://www.pokeraianalyzer.com/wc-ring-regulation-2026/',
    'https://dime.jp/genre/2071156/'
  ];
  for (const url of secondarySources) {
    const re = new RegExp(`href="${escapeRegExp(url)}"[^>]*rel="([^"]*)"`);
    const m = html.match(re);
    assert.ok(m, `${url} へのリンクが見つかりません`);
    assert.equal(m[1], 'nofollow noopener', `${url} は rel="nofollow noopener" を期待(実際: ${m[1]})`);
  }
});

test('出典一覧の全リンクが target="_blank" を持つ(新しいタブで開く)', () => {
  const html = buildPage(REPO);
  const sourcesStart = html.indexOf('id="sources"');
  assert.ok(sourcesStart >= 0);
  const sourcesSection = html.slice(sourcesStart);
  const links = [...sourcesSection.matchAll(/<a href="https?:\/\/[^"]+"([^>]*)>/g)];
  assert.ok(links.length >= 10, `出典一覧のリンクが${links.length}件しかありません`);
  links.forEach(m => assert.match(m[1], /target="_blank"/));
});
