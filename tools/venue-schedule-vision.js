'use strict';
/**
 * venue-schedule-vision.js
 *
 * 店舗のトーナメント月間スケジュール画像をVisionモデルに渡し、Tournamentスキーマの
 * 配列に正規化する。
 *
 * 【由来】PR #13(Instagram自動巡回・中止)の `tools/instagram-vision.js` の抽出ロジックを
 * そのまま引き継いだもの。呼び出し元がInstagram巡回(セッションCookie注入+検知回避を伴う
 * ため中止)から「店舗が直接送ってきた画像ファイル/投稿リンク」(`tools/import-venue-image.js`)
 * に変わっただけで、画像→JSON の変換ロジック自体は同じ。フィード一覧から新着を判定する
 * `detectNewPost`(Instagramのプロフィール巡回専用)は使い道が無くなったため引き継いでいない。
 *
 * 【新規に必要な環境変数】
 *   `ANTHROPIC_API_KEY` … Anthropic Messages API(Vision対応モデル)を呼ぶために必要。
 *   コードには直書きしない(シェルの環境変数か、gitignore対象の .env 等で渡すこと)。
 *   モデルIDは `ANTHROPIC_VISION_MODEL`(未設定時は DEFAULT_MODEL)で上書き可能。
 *   実運用開始前に有効なモデルIDであることを確認すること。
 */

const path = require('path');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'; // 要確認: 運用開始前に有効なモデルIDに更新すること

const MEDIA_TYPE_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 拡張子からVision APIに渡す media_type を推定する(既定は image/jpeg)。 */
function mediaTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return MEDIA_TYPE_BY_EXT[ext] || 'image/jpeg';
}

function base64Image(buffer) {
  return buffer.toString('base64');
}

/** レスポンステキストから ```json ... ``` フェンス等を除いてJSONだけを取り出す。 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  return JSON.parse(body.trim());
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} systemPrompt
 * @param {string} userPrompt JSON形式で答えるよう明示すること
 * @param {string} [mediaType] 画像のMIMEタイプ(既定 image/jpeg)
 */
async function callVisionModel(imageBuffer, systemPrompt, userPrompt, mediaType = 'image/jpeg') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が未設定です(Vision抽出に必須)。');
  }
  const model = process.env.ANTHROPIC_VISION_MODEL || DEFAULT_MODEL;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image(imageBuffer) } },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new Error(`Visionモデル呼び出しに失敗: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map((b) => b.text || '').join('');
  return extractJson(text);
}

/**
 * 店舗の月間スケジュール画像から、Tournamentスキーマの配列を抽出する。
 *
 * 【プロンプトの書式指定は「補強」であって「担保」ではない】
 * ここで `"09:00"` のようにゼロ埋めを例示しても、LLMが必ず従う保証はどこにも無い。
 * 正しさの不変条件を守っているのは【呼び出し側の正規化と検査】(tools/validate-data.js の
 * normalizeExtractedRow / extractedRowProblem)であって、この文面ではない。
 * 逸脱が減れば正規化ログ(件数は apify-monitor-state.json の lastExtraction.normalized)が
 * 減る、という関係にすぎないので、この指定を理由に呼び出し側の正規化を省いてはいけない。
 *
 * @param {Buffer} imageBuffer
 * @param {{ postedDateHint?: string, mediaType?: string }} [opts]
 * @returns {Promise<Array<object>>} venueId/source/verified を含まない「素の」抽出結果
 */
async function extractTournaments(imageBuffer, { postedDateHint, mediaType } = {}) {
  const system =
    'あなたはポーカー店の月間トーナメントスケジュール画像から情報を正規化するアシスタントです。' +
    '出力は指定されたJSON配列のみ。説明文やコードフェンスは不要です。';
  const user = [
    'この画像は、ある店舗から直接届いたポーカートーナメントの月間スケジュール告知です。',
    postedDateHint ? `画像を受け取ったのは ${postedDateHint} 頃です(年の判断に使ってください)。` : '',
    '読み取れる開催情報をすべて、次のJSON配列の要素として出力してください:',
    '{"date":"YYYY-MM-DD","start":"HH:MM"|null,"name":"string","buyin":number|null,"addon":number|null,' +
      '"stack":number|null,"guarantee":number|null,"reentry":true|false|"late","prize":string|null,"tags":string[]}',
    'date は必ず YYYY-MM-DD(ゼロ埋め。例: "2026-09-05")。',
    'start は24時間表記のゼロ埋め HH:MM(例: "09:00" / "19:00")。' +
      '"9:00" のようにゼロを省いたり、"19：00"(全角コロン)・"7pm"・"19時" のような表記を使わないでください。',
    '金額は円の数値のみ(カンマ・円マーク・"k"などの単位無し。例: 3500)。' +
      '読み取れない項目は null にしてください(推測で埋めない。0 は「無料」の意味になるので使わない)。',
    'トーナメントと無関係な文言(店舗の営業案内、注意書きなど)は無視してください。',
  ]
    .filter(Boolean)
    .join('\n');
  const result = await callVisionModel(imageBuffer, system, user, mediaType || 'image/jpeg');
  return Array.isArray(result) ? result : [];
}

module.exports = { callVisionModel, extractTournaments, mediaTypeFromPath, extractJson, DEFAULT_MODEL };
