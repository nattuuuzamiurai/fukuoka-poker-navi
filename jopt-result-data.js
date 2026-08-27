/* ============================================================
 * jopt-result-data.js — JOPT 2026 Fukuoka #01 の結果(終了済み大会。出典記事からの転記)
 *
 * 【なぜ独立したファイルなのか】
 *   もとは tools/gen-event-pages.js の中の定数だったが、OGP画像生成(tools/gen-ogp-images.js・
 *   依頼5・2026-08-28)でも同じ値(優勝者名・エントリー数)を焼き込む必要が生じた。
 *   gen-event-pages.js は require されただけで生成・書き込み・検査まで実行するCLIスクリプトで、
 *   他のスクリプトから安全に require できない(README「そのまま require しない」を参照)ため、
 *   値そのものを jopt-data.js / nippon-series-data.js と同じ並びの独立データファイルに切り出した。
 *
 * 【なぜここに定数を置くか】この大会はすでに終了しており、結果は当サイトの集計元(data.js/jopt-data.js)
 * には無い外部情報(下記出典)。他のデータのように「値を手打ちしない」原則を保てないため、
 * 唯一の出どころをこの定数にまとめ、本文・title・meta・JSON-LD・OGP画像への転記をすべてここから行う
 * (コピーを複数箇所に手で書くと、この後の事故(恒久リンク行など)と同じ「片方だけ直す」を繰り返す)。
 * ============================================================ */
const JOPT_RESULT = {
  winner: 'Koheiさん',
  runnerUp: 'TSUNEさん',
  totalEntries: '1,179人',
  sourceUrl: 'https://light-three.com/jopt-fukuoka-result/',
  sourceLabel: 'ポーカーマガジン LightTHREE「【JOPT 2026 Fukuoka #01リザルト】初代Main Event王者はKoheiさん！注目イベントの結果も紹介」',
  sourceDate: '（2026年8月7日公開・2026年8月27日確認）',
  notable: '主な注目トーナメントの優勝者　NLH Fukuoka（128エントリー）：ぽんたろうさん／NLH Platinum Sponsored by APT（72エントリー）：Sugarさん／PLO Prime（66エントリー）：こすもんさん／FL 2-7 TD &amp; Badugi #03（49エントリー）：きりんさん／FL 2-7 TD &amp; Badugi #26（75エントリー）：Takumaruさん。JOPT 2026 Fukuoka #01 全体（全トーナメント合算）の総エントリー数は6,045。'
};

if (typeof module !== 'undefined' && module.exports) { module.exports = JOPT_RESULT; }
