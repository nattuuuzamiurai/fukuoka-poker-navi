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
 *
 * ============================================================
 * 【最重要】出力の切り捨ては「パースを通す」方向に直してはいけない
 * ============================================================
 * 2026-07-31 の dry-run で、6投稿が
 *   `Unexpected token '`', "```json\n[\n"... is not valid JSON`
 * で丸ごとスキップされた。エラー文だけ見るとフェンス除去(extractJson)のバグに見えるが、
 * 真因は【max_tokens: 2048 に対して月間スケジュールのJSONが大きすぎて出力が途中で
 * 打ち切られ、閉じフェンスが出力されなかった】こと。
 *
 * ここで extractJson の正規表現を「閉じフェンスが無くても拾う」形に緩めると、
 * エラーは消えるが【途中で切れたJSONが部分的に通り、月の後半が丸ごと欠けた日程が
 * 無言で公開される】。エラーが出て何も取り込まれない今より確実に悪化する。
 * したがってこのファイルの方針は次の2本立てで固定する:
 *   1. 切り捨てを検出したら【明示的に失敗させる】(stop_reason の検査 / 閉じフェンス欠落の検査)
 *   2. そもそも切り捨てない(MAX_OUTPUT_TOKENS を実測に基づいて十分に取る)
 * 「部分的に読めたぶんだけ採用する」実装を足さないこと。
 */

const path = require('path');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'; // 要確認: 運用開始前に有効なモデルIDに更新すること

/**
 * 1回の応答で許す最大出力トークン数。
 *
 * 【この値の根拠(実測)】
 * data.js に入っている監視対象6店(v40/v20/v18/v21/v34/v35)の実エントリ191件を、
 * Visionが返す「素の行」の形に戻して測ると、モデルが実際に出す pretty print(2スペース
 * インデント。dry-runのエラー文 "```json\n[\n" が pretty print であることを示している)で
 *   1行あたり 約240文字 / 約259バイト(UTF-8)
 * だった。1投稿は「1ヶ月ぶんの日程表1枚」なので、想定すべき最大は
 *   100行 … 約24,500文字(26.4KB) / 150行(31日×最大5開催)… 約36,300文字(39.1KB)
 * この本文はほぼASCII(非ASCII=日本語は全体の約4%)なので、Claudeのトークナイザでは
 * ASCII部が概ね3〜3.5文字/トークン、日本語部が1〜1.5トークン/文字。150行で
 *   34,900/3 + 1,400×1.5 ≒ 13,700トークン(保守的に見た上限側の見積り)
 * となる。16,384(2^14)はこの想定上限に約20%の余裕を足した値で、
 *   ・100行級の月間スケジュール(≒9,000〜10,000トークン)なら6割以上の余裕がある
 *   ・使用モデル claude-sonnet-4-5 の最大出力 64,000トークン(同期Messages API)の1/4に収まる
 *
 * 【旧値 2048 が壊れていたことの裏付け】上の 1行=約240文字 と「概ね3文字/トークン」から、
 * 2048トークンで出せるのは約6,100文字 ≒ 25行しかない。2026-07-31 の dry-run で
 * 「1投稿あたり20件前後」の投稿は通り、それより大きい投稿(=月まるごとの日程表)だけが
 * 切り捨てで落ちた、という観測と一致する。
 * 【max_tokens は「予約」ではなく「上限」】課金も所要時間も実際に生成したトークン数で決まる。
 * 大きめに取ること自体のコストは無く、唯一の副作用は最悪ケースの所要時間(下の
 * REQUEST_TIMEOUT_MS で面倒を見る)。逆に小さすぎると【黙ってデータが欠ける】ので、
 * 迷ったら大きい側に倒すこと。
 */
const MAX_OUTPUT_TOKENS = 16384;

/**
 * 1回のVision呼び出しのタイムアウト(ミリ秒)。
 *
 * 【なぜ 60秒 から引き上げたか】旧実装が60秒で足りていたのは max_tokens が 2048 しか
 * 無く、生成が約30秒で必ず頭打ちになっていたからにすぎない。上限を 16,384 に上げると
 * 100行級の月(≒10,000トークン)でも生成に 100〜200秒かかるので、60秒のままだと
 * 「切り捨て」を「AbortError でスキップ」に置き換えるだけで何も直らない。
 *
 * 300秒(5分)は、MAX_OUTPUT_TOKENS の 16,384 トークンを 約55トークン/秒 で出し切れる長さ
 * (Sonnet系の生成速度は概ね60〜100トークン/秒なので、その下限より更に遅くても間に合う)。
 * 同時に、Anthropicが非ストリーミングで推奨しない「10分超」の半分に収めてある
 * (長時間のアイドル接続はネットワーク側で切られることがある、というAPIドキュメントの注意)。
 *
 * 【これ以上伸ばすときはジョブ全体の予算も見ること】
 * 1店あたり最大12投稿(fetch-venue-posts-apify.js の DEFAULT_RESULTS_LIMIT)× 6店 = 最大72回。
 * 72回すべてがタイムアウトに張り付くと 72×5分 = 360分 で、GitHub Actions の既定ジョブ上限
 * (360分)にちょうど並ぶ。これより長くするならワークフローに timeout-minutes を明示すること。
 */
const REQUEST_TIMEOUT_MS = 300000;

/**
 * 1枚の画像から出てよい行数の目安。超えたら警告する(捨てはしない)。
 * 月は最長31日で、1日6開催の店でも 186行。data.js の実データで最も多い「店×月」は
 * v35 の34行(2026-07)なので、実際にはこの目安に遠く届かない。
 * 200行を超えるのは「月間スケジュール以外の画像を読んでいる」「同じ行を延々繰り返している」
 * といった異常の可能性が高い。ただし本当に大きい月を落とす方が実害が大きいので、
 * ここでは例外を投げず、runログに残して人が気づけるようにするだけにしてある
 * (行ごとの正当性の判断は呼び出し側の normalizeExtractedRow / extractedRowProblem の担当)。
 */
const MAX_EXPECTED_ROWS = 200;

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

/**
 * レスポンステキストから ```json ... ``` フェンス等を除いてJSONだけを取り出す。
 *
 * 扱う3パターン:
 *   1. フェンスが開いて閉じている  → 中身をパースする(前後に説明文があってもよい)
 *   2. フェンスが最初から無い純粋なJSON → そのままパースする
 *   3. 開きフェンスはあるが閉じフェンスが無い → 【部分的に拾わず明示的に失敗させる】
 *
 * 3を「開きフェンスから後ろを全部JSONとみなす」形で通してはいけない。応答が途中で切れて
 * いる場合、それは【月の後半が欠けた配列】であり、JSONとして偶然読めてしまうこともある
 * (要素の切れ目でちょうど終わった場合など)。黙って欠けたデータを公開するくらいなら、
 * その投稿を取り込まない方が安全。ファイル冒頭の【最重要】も参照。
 */
function extractJson(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) {
    throw new Error('Visionモデルの応答が空でした(本文が1文字もありません)。');
  }
  // 開きフェンスは応答のどこにあってもよい(「以下が結果です:」のような前置きが付くことがある)。
  const open = src.match(/```(?:json)?[ \t]*\r?\n?/i);
  let body = src;
  if (open) {
    const rest = src.slice(open.index + open[0].length);
    const close = rest.indexOf('```');
    if (close === -1) {
      throw new Error(
        '応答が ``` で始まっているのに閉じフェンスがありません(出力が途中で切れた可能性が高い)。' +
          '途中まで読めるぶんを部分的に採用すると、月の後半が丸ごと欠けた日程が無言で公開されるため、' +
          `ここで失敗させています。応答の長さ=${src.length}文字 / 末尾=${JSON.stringify(rest.slice(-60))}`
      );
    }
    body = rest.slice(0, close);
  }
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
      max_tokens: MAX_OUTPUT_TOKENS,
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new Error(`Visionモデル呼び出しに失敗: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  assertNotTruncated(json, model);
  const text = (json.content || []).map((b) => b.text || '').join('');
  return extractJson(text);
}

/**
 * 応答が最後まで出し切られたか(stop_reason)を検査し、そうでなければ明示的に失敗させる。
 *
 * 【なぜ本文のパースより先に見るのか】
 * max_tokens で打ち切られた応答は、閉じフェンスが無いせいで JSON パースエラーとして
 * 表面化する。そのエラー文(`Unexpected token '`' ... is not valid JSON`)は
 * 「フェンス処理のバグ」に見えるため原因を誤診させ、危険な方向(正規表現を緩める)の
 * 修正を誘発する。切り捨ては【切り捨てとして】報告されなければならない。
 *
 * end_turn / stop_sequence 以外はすべて「最後まで出ていない」扱いにする。
 * ANTHROPIC_VISION_MODEL で新しいモデルに差し替えたときに増える stop_reason
 * (refusal・pause_turn など)を「知らない値だから素通し」にしないため。
 */
function assertNotTruncated(json, model) {
  const stop = json && json.stop_reason;
  const outputTokens = json && json.usage && json.usage.output_tokens;
  if (stop === 'max_tokens') {
    throw new Error(
      `Visionモデルの出力が max_tokens(${MAX_OUTPUT_TOKENS})で打ち切られました。` +
        'この投稿の抽出結果は途中で切れており信用できません(そのまま採用すると月の後半が' +
        '丸ごと欠けた日程になります)。' +
        `model=${model} / 出力トークン=${outputTokens != null ? outputTokens : '不明'}。` +
        'この画像の日程が本当に MAX_OUTPUT_TOKENS を超える量なら、tools/venue-schedule-vision.js の' +
        ' MAX_OUTPUT_TOKENS(と必要なら REQUEST_TIMEOUT_MS)を引き上げてください。'
    );
  }
  if (stop != null && stop !== 'end_turn' && stop !== 'stop_sequence') {
    throw new Error(
      `Visionモデルの応答が正常に終了していません(stop_reason=${JSON.stringify(stop)})。` +
        '途中で終わった応答を部分的に採用すると欠けた日程が公開されるため、この投稿は取り込みません。' +
        `model=${model} / 出力トークン=${outputTokens != null ? outputTokens : '不明'}。`
    );
  }
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
    'start は24時間表記のゼロ埋め HH:MM(半角。例: "09:00" / "19:00")。' +
      '"9:00" のようにゼロを省いたり、"１９：００"(全角の数字・コロン)・"7pm"・"19時" のような表記を使わないでください。',
    '金額は円の数値のみ(カンマ・円マーク・"k"などの単位無し。例: 3500)。' +
      '読み取れない項目は null にしてください(推測で埋めない。0 は「無料」の意味になるので使わない)。',
    'トーナメントと無関係な文言(店舗の営業案内、注意書きなど)は無視してください。',
  ]
    .filter(Boolean)
    .join('\n');
  const result = await callVisionModel(imageBuffer, system, user, mediaType || 'image/jpeg');
  const rows = Array.isArray(result) ? result : [];
  if (rows.length > MAX_EXPECTED_ROWS) {
    console.warn(
      `[venue-schedule-vision] 1枚の画像から ${rows.length}件の行が返りました` +
        `(想定上限 ${MAX_EXPECTED_ROWS}件)。月間スケジュール以外の画像を読んでいるか、` +
        '同じ行を繰り返している可能性があります。取り込み結果を確認してください。'
    );
  }
  return rows;
}

module.exports = {
  callVisionModel,
  extractTournaments,
  mediaTypeFromPath,
  extractJson,
  assertNotTruncated,
  DEFAULT_MODEL,
  MAX_OUTPUT_TOKENS,
  REQUEST_TIMEOUT_MS,
  MAX_EXPECTED_ROWS,
};
