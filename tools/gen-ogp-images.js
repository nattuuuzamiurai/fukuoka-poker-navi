#!/usr/bin/env node
/**
 * gen-ogp-images.js
 *
 * OGP画像(og:image)を1200×630(1.91:1・Facebook/Twitter(X)/LINE等の標準比率)で生成する
 * (依頼5・2026-08-28。マーケティング部調査: トップ・エリア・店舗ページにog:imageが一切無く、
 * 既存のイベント4ページのバナー画像も1024×412でアスペクト比が推奨値とズレていた)。
 * デザイン仕様は ogp-design-spec.md(コンテンツ制作部作成)を参照。
 *
 * 【依存ライブラリについて】
 *   このリポジトリは通常「外部ライブラリを使わない」方針(README参照)だが、このスクリプトは
 *   「画像を作るための開発時ツール」であり、コミットするのは生成物(JPEGファイル)だけで、
 *   サイト本体・他の生成スクリプト・node --test・validate-data.js の実行には一切必要ない
 *   (package.json も持たせていない)。Playwright(npm)が 使える環境でだけ、
 *   このスクリプトを直接実行して画像を作り直す。
 *   実行例(Playwrightをグローバルにインストール済みの場合):
 *     npm install -g playwright && npx playwright install chromium
 *     node tools/gen-ogp-images.js .
 *   （NODE_PATHで別途インストール済みのplaywrightを指す形でもよい）
 *
 * 【既存のバナー画像(1024×412)をどう扱ったか】
 *   ゼロから描き直すのではなく、既存のバナー(WJPT/JOPT/FST/NIPPON SERIESそれぞれの
 *   img/<id>/*-banner.*)をそのまま1つの画像として1200×630のキャンバスに
 *   object-fit:containで縮小配置し、外周に十分な余白(セーフゾーン基準の60pxを大きく超える
 *   実測値)を取ることで、この画像単体では安全に収まるようにしてある。
 *   ★正直に書いておくと、WJPTの元バナーは虎の顔(左)・地図装飾(右)がアートワーク自体の
 *   構図として既に画像の端で切れている(ベクター/レイヤー単位で要素を動かせる素材が無く、
 *   このスクリプトはラスター/SVGを丸ごと1枚の画像として扱うため、内部の要素だけを
 *   個別に再配置することはできない)。今回の対応は「その1枚を安全な余白つきで縮小配置し、
 *   OGP側で新たに切れることは無くす」までで、元アートワークの構図そのものの描き直しは
 *   スコープ外とした(必要であれば別途デザイン素材の再制作が要る)。
 *   その他のイベント(JOPT/NIPPON SERIES)は元バナーの時点で余白が十分あり、この縮小配置だけで
 *   セーフゾーン要件を満たす。
 *
 * 生成物:
 *   - img/ogp/common-og.jpg              … トップ・エリア・店舗ページ共用
 *   - img/wjpt/wjpt-og.jpg
 *   - img/jopt/jopt-og.jpg
 *   - img/fst/fst-og.jpg
 *   - img/nippon-series/nippon-series-og.jpg
 *
 * 使い方:
 *   node tools/gen-ogp-images.js <リポジトリのパス>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ARG = process.argv[2];
if (!REPO_ARG) { console.error('リポジトリのパスを指定してください'); process.exit(1); }
const REPO = path.resolve(REPO_ARG);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('playwright が見つかりません。このスクリプトはOGP画像を作り直すときだけ必要な開発時ツールです。');
  console.error('例: npm install -g playwright && npx playwright install chromium');
  process.exit(1);
}

// ---- データ読み込み(手打ちしない。README「数値を手打ちしない」原則) ----
const DATA = require(path.join(REPO, 'data.js'));
const JOPT = require(path.join(REPO, 'jopt-data.js'));
const JOPT_RESULT = require(path.join(REPO, 'jopt-result-data.js'));
const NIPPON = require(path.join(REPO, 'nippon-series-data.js'));
const BIG = require(path.join(REPO, 'big-events.js'));

// index.html 内の const FST = {...} を抽出する。tools/gen-event-pages.js の extractConst() と
// 同じ考え方だが、あちらは require するとCLIとして即実行されてしまうため複製してある
// (README「そのまま require しない」を参照。この抽出処理自体は6行程度の小さなユーティリティ)。
function extractConst(indexSrc, name) {
  const m = indexSrc.match(new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\n  \\});'));
  if (!m) throw new Error(`index.html から ${name} を抽出できませんでした`);
  const sandbox = { bigEventDays: BIG.bigEventDays };
  vm.createContext(sandbox);
  return vm.runInContext('(' + m[1] + ')', sandbox);
}
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const FST = extractConst(INDEX_SRC, 'FST');

// ---- 画像をdata URIに変換 ----
// Playwrightのpage.setContent()で組み立てるページはfile://を経由しない(about:blank相当)ため、
// <img src="file://...">は読み込めない(実測・onerror発火)。data URIなら常に読み込める。
const MIME = { '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
function dataUri(relPath) {
  const p = path.join(REPO, relPath);
  const ext = path.extname(p).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`未対応の画像形式です: ${relPath}`);
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

// ---- 共通CSS(サイト本体の配色・書体に合わせる。ogp-design-spec.md「共通ルール」) ----
const OG_W = 1200, OG_H = 630;
const BASE_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${OG_W}px;height:${OG_H}px;overflow:hidden}
  body{font-family:"Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;color:#fff;position:relative}
  .safe{position:absolute;left:60px;right:60px;top:60px;bottom:60px;display:flex;flex-direction:column}
  .pill{display:inline-block;border-radius:999px;padding:10px 22px;font-weight:800}
`;

function page(bodyHtml, extraStyle) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${BASE_STYLE}${extraStyle || ''}</style></head>
<body>${bodyHtml}</body></html>`;
}

// ---- 1. サイト共通OGP(トップ・エリア・店舗ページ共用) ----
function buildCommon() {
  const venueCount = DATA.VENUES.length;
  const style = `
    body{background:linear-gradient(135deg,#0f3d2e,#14513c)}
    .wm{position:absolute;font-size:340px;opacity:.07;line-height:1;user-select:none}
    .wm.a{left:-60px;top:-90px}
    .wm.b{right:-60px;bottom:-110px}
    .center{align-items:center;justify-content:center;text-align:center;gap:22px}
    .logo{font-size:56px;font-weight:800;display:flex;align-items:center;gap:16px}
    .logo .pip{color:#f0c56b;font-size:60px}
    .sub{font-size:28px;font-weight:700;color:#e9f2ec}
    .chips{display:flex;gap:16px;margin-top:18px}
    .chip{background:#fff;color:#0f3d2e;font-size:19px;box-shadow:0 2px 12px rgba(0,0,0,.25)}
  `;
  const body = `
    <div class="wm a">♠</div>
    <div class="wm b">♥</div>
    <div class="safe center">
      <div class="logo"><span class="pip">♠</span>ふくおかポーカーナビ</div>
      <div class="sub">福岡のポーカー大会・トーナメントを、ぜんぶ、ここで。</div>
      <div class="chips">
        <div class="pill chip">天神・中洲・北九州・久留米・筑豊 etc.　毎日更新</div>
        <div class="pill chip">掲載店舗${venueCount}店</div>
        <div class="pill chip">今日・今週の開催が日付で分かる</div>
      </div>
    </div>`;
  return page(body, style);
}

// ---- イベント4ページ共通の骨格 ----
// 上段: 既存バナー画像をobject-fit:containで縮小配置(セーフゾーン内に収まる余白つき)。
// 下段: 大会名・日程・動的な補足情報(依頼5「動的な値は手打ちしない」)。
function buildEventOgp({ bgFrom, bgTo, imageDataUri, imageAlt, title1, title2, lines, badge }) {
  const style = `
    body{background:linear-gradient(135deg,${bgFrom},${bgTo})}
    .imgWrap{flex:0 0 auto;display:flex;align-items:center;justify-content:center;height:300px}
    .imgWrap img{max-width:100%;max-height:300px;object-fit:contain}
    .textBlock{flex:1;display:flex;flex-direction:column;justify-content:center;gap:10px;text-align:center}
    .t1{font-size:44px;font-weight:800;letter-spacing:.02em}
    .t2{font-size:26px;font-weight:700;opacity:.92}
    .lines{font-size:22px;font-weight:600;line-height:1.7;opacity:.95}
    .badge{align-self:center;margin-top:6px;font-size:22px}
  `;
  const body = `
    <div class="safe">
      <div class="imgWrap"><img src="${imageDataUri}" alt="${imageAlt}"></div>
      <div class="textBlock">
        <div class="t1">${title1}</div>
        ${title2 ? `<div class="t2">${title2}</div>` : ''}
        <div class="lines">${lines.join('<br>')}</div>
        ${badge ? `<div class="pill badge">${badge}</div>` : ''}
      </div>
    </div>`;
  return page(body, style);
}

// ---- 2. FSTページ用OGP ----
function buildFst() {
  const main = FST.events[0];
  return buildEventOgp({
    bgFrom: '#070c22', bgTo: '#1a2455',
    imageDataUri: dataUri('img/fst/fst-banner.svg'), imageAlt: 'FST 5.0 FUKUOKA SUPER TOURNAMENT',
    title1: 'FST 5.0 FUKUOKA SUPER TOURNAMENT',
    lines: ['2026.9.19 - 9.23　ホテルニューオータニ博多'],
    badge: `MAIN EVENT Prize Total ${main.prize}`
  });
}

// ---- 3. JOPTページ用OGP ----
function buildJopt() {
  return buildEventOgp({
    bgFrom: '#07171d', bgTo: '#0e3d48',
    imageDataUri: dataUri('img/jopt/jopt-banner.jpg'), imageAlt: 'JOPT 2026 Fukuoka #01',
    title1: 'JOPT 2026 Fukuoka #01 結果発表',
    lines: [`会場: ${JOPT.venue}（${JOPT.area}）　7.30 - 8.2`],
    badge: `優勝: ${JOPT_RESULT.winner}（エントリー ${JOPT_RESULT.totalEntries}）`
  });
}

// ---- 4. 日本シリーズページ用OGP ----
// 【結果・優勝者情報は入れない】社長方針・2026-08-28。WJPT・日本シリーズの結果調査・記載は
// 需要がないと判断済み。badge は「全◯◯イベント」に留め、優勝関連の文言は一切使わない。
function buildNippon() {
  return buildEventOgp({
    bgFrom: '#5c0910', bgTo: '#a8111c',
    imageDataUri: dataUri('img/nippon-series/nippon-series-banner.svg'), imageAlt: 'NIPPON SERIES FUKUOKA 2026',
    title1: 'NIPPON SERIES（日本シリーズ）福岡 2026',
    lines: ['2026.8.11 - 8.16　福岡 トヨタホールスカラエスパシオ'],
    badge: `全${NIPPON.eventCount}イベント`
  });
}

// ---- 5. WJPT用OGP(終了済み=アーカイブ。結果情報の新規追加はしない) ----
function buildWjpt() {
  return buildEventOgp({
    bgFrom: '#0a1226', bgTo: '#122046',
    imageDataUri: dataUri('img/wjpt/wjpt-banner.jpg'), imageAlt: 'WJPT West Japan Poker Tour',
    title1: 'WJPT TOURNAMENT SCHEDULE',
    lines: ['7.18 - 7.20　WEST JAPAN POKER TOUR／北九州']
  });
}

// ---- 書き出し ----
const TARGETS = [
  { rel: 'img/ogp/common-og.jpg', html: buildCommon() },
  { rel: 'img/wjpt/wjpt-og.jpg', html: buildWjpt() },
  { rel: 'img/jopt/jopt-og.jpg', html: buildJopt() },
  { rel: 'img/nippon-series/nippon-series-og.jpg', html: buildNippon() },
  { rel: 'img/fst/fst-og.jpg', html: buildFst() }
];

(async () => {
  const browser = await chromium.launch();
  try {
    // deviceScaleFactor は既定の1のまま(=1200×630のピクセル寸法そのまま出す)。
    // 2を指定すると2400×1260になり、仕様書の「1200×630px」から外れるため使わない。
    const page1 = await browser.newPage({ viewport: { width: OG_W, height: OG_H } });
    for (const t of TARGETS) {
      await page1.setContent(t.html);
      // フォント読み込み・レイアウト確定を待つ(即座にscreenshotすると文字化けする実測があるため)。
      await page1.waitForTimeout(150);
      const outPath = path.join(REPO, t.rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await page1.screenshot({ path: outPath, type: 'jpeg', quality: 90 });
      console.log('生成:', t.rel);
    }
  } finally {
    await browser.close();
  }
  console.log(`完了。OGP画像 ${TARGETS.length} 件(すべて${OG_W}×${OG_H})`);
})();
