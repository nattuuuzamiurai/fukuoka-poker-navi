'use strict';
/**
 * instagram-vision.js
 *
 * スクリーンショットをVisionモデルに渡して判定・抽出する。
 *
 * 【新規に必要なシークレット(このタスクの元指示には無かったが実装上必須)】
 *   `ANTHROPIC_API_KEY` … Anthropic Messages API(Vision対応モデル)を無人実行から
 *   呼ぶために必要。元の指示書には Instagramログイン用・ダッシュボード書き込み用の
 *   シークレットしか挙げられていなかったが、「スクリーンショットをVisionモデルに渡す」
 *   ([README該当章]の手順2・5)を無人実行するにはAPIキーが要る。値は空のプレースホルダで
 *   実装し、経営管理オフィス側で用意してもらう前提にしてある(このリポジトリの
 *   admin.html は「Claude Codeのチャットで人が読み込む」運用のため、プログラムから
 *   呼び出すAPIキーはこのリポジトリにこれまで存在しなかった)。
 *   モデルIDは `ANTHROPIC_VISION_MODEL`(未設定時は DEFAULT_MODEL)で上書き可能にしてある。
 *   実運用開始前に有効なモデルIDであることを確認すること。
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'; // 要確認: 運用開始前に有効なモデルIDに更新すること

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
 * @param {Buffer} imageBuffer PNGスクリーンショット
 * @param {string} systemPrompt
 * @param {string} userPrompt JSON形式で答えるよう明示すること
 */
async function callVisionModel(imageBuffer, systemPrompt, userPrompt) {
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
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image(imageBuffer) } },
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
 * プロフィールのフィードスクリーンショットから「lastFoundPostDateより新しい投稿があるか」を判定する。
 * @returns {Promise<{ hasNewPost: boolean, isScheduleAnnouncement: boolean, postIndex: number|null, reasoning: string }>}
 */
async function detectNewPost(imageBuffer, { lastFoundPostDate }) {
  const system =
    'あなたはポーカー店のInstagramフィード画像を確認するアシスタントです。' +
    '与えられた画像は、ある店舗のInstagramプロフィールのフィード投稿一覧(グリッド)のスクリーンショットです。' +
    '出力は指定されたJSONのみ。説明文やコードフェンスは不要です。';
  const user = [
    lastFoundPostDate
      ? `直近で確認できている最新の告知投稿の日付は ${lastFoundPostDate} です。それより新しい投稿があるかを判定してください。`
      : 'このアカウントの投稿はまだ一度も記録していません。トーナメントの月間スケジュール告知らしき投稿があるかを判定してください。',
    'グリッドは左上が最新、右・下にいくほど古い投稿である前提です。',
    'トーナメントと無関係な投稿(料理の写真、日常の様子など)は無視してください。',
    '次のJSON形式で答えてください:',
    '{"hasNewPost": boolean, "isScheduleAnnouncement": boolean, "postIndex": number|null, "reasoning": string}',
    '"postIndex" は新しい投稿だと判断した場合の、グリッド内での位置(左上を0とした通し番号)。無ければnull。',
  ].join('\n');
  return callVisionModel(imageBuffer, system, user);
}

/**
 * 投稿単体のスクリーンショットから、Tournamentスキーマの配列を抽出する。
 * @returns {Promise<Array<object>>} venueId/source/verified を含まない「素の」抽出結果
 */
async function extractTournaments(imageBuffer, { postedDateHint } = {}) {
  const system =
    'あなたはポーカー店の月間トーナメントスケジュール画像から情報を正規化するアシスタントです。' +
    '出力は指定されたJSON配列のみ。説明文やコードフェンスは不要です。';
  const user = [
    'この画像は、ある店舗が投稿したポーカートーナメントの月間スケジュール告知です。',
    postedDateHint ? `投稿日は ${postedDateHint} 頃です(年の判断に使ってください)。` : '',
    '読み取れる開催情報をすべて、次のJSON配列の要素として出力してください:',
    '{"date":"YYYY-MM-DD","start":"HH:MM"|null,"name":"string","buyin":number|null,"addon":number|null,' +
      '"stack":number|null,"guarantee":number|null,"reentry":true|false|"late","prize":string|null,"tags":string[]}',
    '金額は円の数値のみ(カンマ・円マーク無し)。読み取れない項目は null にしてください(推測で埋めない)。',
    'トーナメントと無関係な文言(店舗の営業案内、注意書きなど)は無視してください。',
  ].filter(Boolean).join('\n');
  const result = await callVisionModel(imageBuffer, system, user);
  return Array.isArray(result) ? result : [];
}

module.exports = { callVisionModel, detectNewPost, extractTournaments, DEFAULT_MODEL };
