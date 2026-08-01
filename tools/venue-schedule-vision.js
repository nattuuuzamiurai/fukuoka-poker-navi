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
 *   1. 切り捨てを検出したら【明示的に失敗させる】(stop_reason の検査 / 閉じフェンス欠落の
 *      検査 / stop_reason を返さないまま終わったストリームの検査)
 *   2. そもそも切り捨てない(MAX_OUTPUT_TOKENS を実測に基づいて十分に取る)
 * 「部分的に読めたぶんだけ採用する」実装を足さないこと。
 *
 * ============================================================
 * 【最重要2】容量の余裕は「自分側の数字」で確保する。プロンプトに依存させない
 * ============================================================
 * 下のプロンプトには「compact JSONで出力してください」と書いてあり、モデルが従えば出力量は
 * 約35%減る。しかし【これを余裕として当てにしてはいけない】。LLMの指示遵守を正しさの
 * 不変条件の担保に使わないのがこのリポジトリの原則で、従わなかった日に切り捨てが起きる。
 * 安全域は MAX_OUTPUT_TOKENS 側(=pretty print で出されても収まる値)だけで確保し、
 * compact指示は「通常時のコストと所要時間が下がる」効果に留めて数える。
 */

const path = require('path');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'; // 要確認: 運用開始前に有効なモデルIDに更新すること

/**
 * 1枚の画像から出てよい行数の目安。超えたら警告する(捨てはしない)。
 *
 * 月は最長31日で、1日6開催の店でも186行。data.js の実データで最も多い「店×月」は
 * v35 の34行(2026-07)なので、正常な月間スケジュールがこの目安に達することはまずない。
 * 200行を超えるのは「月間スケジュール以外の画像を読んでいる」「同じ行を延々繰り返している」
 * といった異常の可能性が高い。ただし本当に大きい月を落とす方が実害が大きいので、
 * ここでは例外を投げず、runログに残して人が気づけるようにするだけにしてある
 * (行ごとの正当性の判断は呼び出し側の normalizeExtractedRow / extractedRowProblem の担当)。
 *
 * 【この値は MAX_OUTPUT_TOKENS と必ずセットで動かすこと】
 * 「200行までは捨てずに通す」と決めた以上、200行を出し切れるだけの出力上限が要る。
 * 片方だけ動かすと「捨てない設計なのに、その手前で切り捨てられる」矛盾が復活する
 * (実際、最初の実装は MAX_EXPECTED_ROWS=200 に対して166行分しか max_tokens が無かった)。
 * 整合は tools/venue-schedule-vision.test.js が直接assertしている。
 */
const MAX_EXPECTED_ROWS = 200;

/**
 * 抽出行1件あたりの出力トークン数の【最悪値】(実測)。
 *
 * 【名前が WORST_CASE_ である理由 — 平均に置き換えないこと】
 * ここに平均や「実測レンジの下の方」を置くと、`MAX_EXPECTED_ROWS × この値 ≤ MAX_OUTPUT_TOKENS`
 * の整合assertが【通ったのに実際には危ない】状態を許してしまう。
 * 例: 124(全項目埋めの値)を置いたまま誰かが MAX_EXPECTED_ROWS を250に上げると、
 * assert は 250×124 = 31,000 ≤ 32,768 で通るが、実際の最悪値では 250×130.4 = 32,600 と
 * 余裕がほぼ消える。これは PR #26 が差し戻された構図そのものが規模を縮めて残ったもの。
 * **この定数は常に「観測された最大」でなければならない。**
 *
 * 品質管理部が実トークナイザ3種(tiktoken o200k_base / cl100k_base / @anthropic-ai/tokenizer)で
 * 独立に計測した値。pretty print(2スペースインデント)前提:
 *   ・data.js の実分布の行 … 95.2〜98.5 トークン/行
 *   ・全項目が埋まった行(guarantee/prize/addon まで全部ある)… 約123.3 トークン/行
 *   ・全項目が埋まり、かつ【大会名が日本語だけ】の行(全シナリオ中の最大)… 約130.4 トークン/行
 * 最大の130.4を切り上げて 131 とする。
 *
 * 【文字数からの概算に戻さないこと】以前この定数の代わりに「ASCII=3文字/トークン」という
 * 楽観的なヒューリスティックで見積もっていたが、実測より2〜3割少なく出たため
 * MAX_OUTPUT_TOKENS を実際には足りない値に決めてしまった。数字は実測を置くこと。
 */
const WORST_CASE_TOKENS_PER_ROW = 131;

/**
 * 1回の応答で許す最大出力トークン数。
 *
 * 【この値の根拠(実測)】
 * 守るべき最大は「MAX_EXPECTED_ROWS(=200行)を捨てずに通す」こと。上の実測から
 *   200行 × 131トークン/行 = 26,200トークン
 * が最悪ケース(全項目が埋まり大会名が日本語だけの200行を pretty print で出す)。
 * 32,768(2^15)はこれに約25%の余裕を足した値で、使用モデル claude-sonnet-4-5 の
 * 最大出力64,000トークンの半分。
 *
 * 参考(同じ実測での他のシナリオ):
 *   実分布100行 … 10,010 / 実分布150行 … 14,772 / 実分布186行 … 18,188 / 実分布200行 … 19,689
 *
 * 【旧値 2048 が壊れていたことの裏付け】131トークン/行なら2048トークンで出せるのは
 * 15〜16行(実分布の98.5トークン/行でも20〜21行)。2026-07-31 の dry-run で
 * 「1投稿あたり20件前後」の投稿は通り、それより大きい投稿(=月まるごとの日程表)だけが
 * 切り捨てで落ちた、という観測と一致する。
 *
 * 【max_tokens は「予約」ではなく「上限」】課金も所要時間も実際に生成したトークン数で
 * 決まる。大きめに取ること自体のコストは無い。逆に小さすぎると【黙ってデータが欠ける】。
 *
 * 【★16Kを超えるならストリーミング必須★】Anthropicの移行ガイドは
 * 「max_tokens > ~16K は全モデルでストリーミングすること(非ストリーミングは高い
 * max_tokens でHTTPタイムアウトに当たる)」と明示している。この値を32,768にしたのに伴い、
 * 下の callVisionModel は `stream: true` のSSEに移行済み。
 * 【今後ここを引き上げる場合も、非ストリーミングに戻さないこと】。
 */
const MAX_OUTPUT_TOKENS = 32768;

/**
 * 非ストリーミングで安全に扱える max_tokens の上限(Anthropicの移行ガイドの「~16K」)。
 * 「MAX_OUTPUT_TOKENS がこれを超えるなら `stream: true` でなければならない」という
 * 不変条件をテストで固定するために置いている。
 */
const NON_STREAMING_SAFE_MAX_TOKENS = 16000;

/**
 * ストリームから【中身のあるイベントが1つも来なくなって】から諦めるまでの時間(ミリ秒)。
 *
 * 【「無音」のタイムアウトにした理由】
 * 生成中のSSEはトークンが出るたびにイベントが流れるので、正常なら間隔は1秒未満。
 * 全体時間で切ると「本当に長い(=正当な)応答」を途中で殺してしまうが、無音で切れば
 *   ・中身のあるイベントが来なくなった → 2分で赤くなる(何時間も垂れ流さない)
 *   ・大きい月を延々と出し続けている → 最後まで待てる
 * を両立できる。旧実装の「全体60秒」は max_tokens が2048で生成が約30秒で頭打ちに
 * なっていたから成立していただけで、上限を上げるなら必ず作り直す必要があった。
 *
 * 【★「1バイトも来なくなったら」ではない★】このタイマーを延ばすのは
 * MEANINGFUL_STREAM_EVENTS に挙げたイベントを【受け取ったときだけ】。
 * 以前はチャンクを受け取るたびに延ばしていたため、`ping` を定期的に送り続ける相手
 * (実測: 500msごとのping)に対して永久に発火しなかった。pingは接続が生きている証拠では
 * あっても【生成が進んでいる証拠ではない】ので、無音判定の延命に使ってはいけない。
 *
 * 120秒は、画像を読んでから最初のトークンが出るまでの待ちに十分な余裕を見た値。
 * なおジョブ全体の上限は .github/workflows/monitor-instagram-apify.yml の
 * `timeout-minutes` が持つ(ここだけ見て全体の時間を推し量らないこと)。
 */
const STREAM_IDLE_TIMEOUT_MS = 120000;

/**
 * 1回のVision呼び出しにかけてよい総時間(ミリ秒)。無音タイムアウトとは別に置く2本目の上限。
 *
 * 無音タイムアウトだけでは「中身のあるイベントが極端にゆっくり(例: 100秒に1回)届き続ける」
 * 相手を止められない。生成トークン数から見た上限は
 *   MAX_OUTPUT_TOKENS(32,768) ÷ 悲観的な生成速度(40トークン/秒) ≒ 819秒
 * なので、900秒(15分)なら正常な応答を切ることはなく、異常は15分で打ち切れる。
 * ワークフローのジョブ上限60分に対しても、最悪ケースが4回ぶんに収まる。
 */
const STREAM_TOTAL_TIMEOUT_MS = 900000;

/**
 * 無音タイマーを延ばしてよい(=生成が進んでいる証拠になる)SSEイベント。
 * `ping` と未知のイベントは意図的に含めない(上の STREAM_IDLE_TIMEOUT_MS 参照)。
 */
const MEANINGFUL_STREAM_EVENTS = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
]);

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
        ' MAX_OUTPUT_TOKENS を引き上げてください。' +
        '【この呼び出しは既にストリーミング(stream:true)です。非ストリーミングに戻さないこと' +
        ' — max_tokens が ~16K を超える呼び出しはストリーミングが必須です】'
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
 * Messages API のSSEストリームを読み、非ストリーミングと同じ形のMessageオブジェクトに組み直す
 * (`{ stop_reason, usage, content: [{type:'text', text}] }`)。
 * これにより assertNotTruncated と extractJson はストリーミングかどうかを知らずに済む。
 *
 * 【stop_reason を返さないまま終わったストリームは失敗にする】
 * 接続が途中で切れた場合、テキストは「途中まで」溜まっているのに stop_reason は未設定になる。
 * これを素通しすると、切り捨てと同じ「月の後半が欠けた日程」が無言で通る経路になる。
 * 切断は max_tokens と並ぶもう1つの切り捨て要因なので、必ずここで捕まえる。
 *
 * @param {ReadableStream} body fetchのレスポンスボディ
 * @param {Function} [onActivity] 【中身のあるイベント】を受け取ったときだけ呼ぶ
 *   (無音タイムアウトのリセット用)。ping では呼ばない — 理由は STREAM_IDLE_TIMEOUT_MS のコメント。
 */
async function readMessageStream(body, onActivity) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Visionモデルの応答にストリーム本文がありません(stream:true で呼んでいるはずです)。');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const EVENT_SEPARATOR = /\r?\n\r?\n/;

  const texts = [];
  let stopReason = null;
  let outputTokens = null;
  let inputTokens = null;

  const handleEvent = (raw) => {
    // SSEは "event: <名前>" と "data: <JSON>" の行からなる。data のJSONにも同じ type が
    // 入っている(仕様)ので、event行は読まずJSON側の type だけを見る。
    const dataLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (dataLines.length === 0) return;
    const payload = dataLines.map((l) => l.slice('data:'.length).trim()).join('');
    if (!payload) return;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch (e) {
      throw new Error(`Visionモデルのストリームに解釈できないイベントがありました: ${payload.slice(0, 200)}`);
    }
    // 【中身のあるイベントだけ】が無音タイマーを延ばす。pingで延びると、pingを送り続ける
    // 相手に対して無音タイムアウトが永久に発火しない(STREAM_IDLE_TIMEOUT_MS のコメント参照)。
    if (onActivity && MEANINGFUL_STREAM_EVENTS.has(ev.type)) onActivity();
    switch (ev.type) {
      case 'message_start':
        inputTokens = ev.message && ev.message.usage ? ev.message.usage.input_tokens : null;
        break;
      case 'content_block_delta':
        if (ev.delta && ev.delta.type === 'text_delta') texts.push(ev.delta.text || '');
        break;
      case 'message_delta':
        if (ev.delta && Object.prototype.hasOwnProperty.call(ev.delta, 'stop_reason')) {
          stopReason = ev.delta.stop_reason;
        }
        // message_delta の usage は累積値なので、最後に来たものが最終値になる。
        if (ev.usage && ev.usage.output_tokens != null) outputTokens = ev.usage.output_tokens;
        break;
      case 'error':
        throw new Error(
          `Visionモデルのストリームがエラーを返しました: ${JSON.stringify(ev.error || ev).slice(0, 300)}`
        );
      default:
        // ping や、将来増える未知のイベント型は無視する(APIのバージョニング方針に従う)。
        break;
    }
  };

  let buffer = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 相手がソケットを切ると fetch は `TypeError: fetch failed` しか返さず、原因が読めない。
      // ここで「ストリームの途中で切れた=受信済みの本文は途中まで」と分かる形に包み直す。
      throw new Error(
        'Visionモデルのストリームの受信中に接続が切れました' +
          `(${e && e.message ? e.message : String(e)})。` +
          'ここまでに受け取った本文は途中までのもので、採用すると月の後半が欠けた日程になるため取り込みません。' +
          `受信済みの本文=${texts.join('').length}文字。`
      );
    }
    const { done, value } = chunk;
    if (done) break;
    // ここでは onActivity を【呼ばない】。チャンク到着だけで無音タイマーを延ばすと、
    // pingを送り続ける相手に対して永久に発火しなくなる。延命は handleEvent 側で
    // 「中身のあるイベント」を受け取ったときにだけ行う。
    buffer += decoder.decode(value, { stream: true });
    // 1回の chunk に複数イベントが入ることも、1イベントが複数 chunk に割れることもあるので、
    // 空行(イベント区切り)が現れたぶんだけ取り出し、残りは次の chunk と繋ぐ。
    let m;
    while ((m = EVENT_SEPARATOR.exec(buffer)) !== null) {
      const raw = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      handleEvent(raw);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);

  if (stopReason == null) {
    throw new Error(
      'Visionモデルのストリームが stop_reason を返さないまま終了しました(接続が途中で切れた可能性が高い)。' +
        'ここまでに受け取った本文は途中までのもので、採用すると月の後半が欠けた日程になるため取り込みません。' +
        `受信済みの本文=${texts.join('').length}文字。`
    );
  }
  return {
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    content: [{ type: 'text', text: texts.join('') }],
  };
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} systemPrompt
 * @param {string} userPrompt JSON形式で答えるよう明示すること
 * @param {string} [mediaType] 画像のMIMEタイプ(既定 image/jpeg)
 * @param {{ idleTimeoutMs?: number, totalTimeoutMs?: number }} [opts]
 *   タイムアウトの上書き。【テストから短い値を渡して実際に発火することを確かめるため】に
 *   引数にしてある(定数のままだと、値を1msにしても24時間にしても誰も気づけない)。
 *   本番の呼び出し元は渡さないこと。
 */
async function callVisionModel(imageBuffer, systemPrompt, userPrompt, mediaType = 'image/jpeg', opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が未設定です(Vision抽出に必須)。');
  }
  const model = process.env.ANTHROPIC_VISION_MODEL || DEFAULT_MODEL;
  const idleTimeoutMs = opts.idleTimeoutMs != null ? opts.idleTimeoutMs : STREAM_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs != null ? opts.totalTimeoutMs : STREAM_TOTAL_TIMEOUT_MS;

  // 上限は2本。
  //   idle  … 中身のあるイベントが来なくなってから idleTimeoutMs(pingでは延びない)
  //   total … 呼び出し開始から totalTimeoutMs(ゆっくり流し続ける相手を止める)
  const controller = new AbortController();
  let idleTimer = null;
  let abortReason = null; // 'idle' | 'total' | null
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = 'idle';
      controller.abort();
    }, idleTimeoutMs);
  };
  const totalTimer = setTimeout(() => {
    abortReason = 'total';
    controller.abort();
  }, totalTimeoutMs);

  try {
    touch();
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
        // MAX_OUTPUT_TOKENS が ~16K を超えるため、ストリーミングは必須(定数のコメント参照)。
        stream: true,
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
      signal: controller.signal,
    });
    touch();
    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      throw new Error(`Visionモデル呼び出しに失敗: HTTP ${res.status} ${body.slice(0, 500)}`);
    }
    const message = await readMessageStream(res.body, touch);
    assertNotTruncated(message, model);
    const text = (message.content || []).map((b) => b.text || '').join('');
    return extractJson(text);
  } catch (e) {
    if (abortReason === 'idle') {
      throw new Error(
        `Visionモデルから中身のあるイベントが ${idleTimeoutMs / 1000}秒 届かなかったため中断しました` +
          '(接続が切れた/相手が固まった/pingだけが流れている可能性)。この投稿は取り込みません。'
      );
    }
    if (abortReason === 'total') {
      throw new Error(
        `Visionモデルの応答が ${totalTimeoutMs / 1000}秒 で完了しなかったため中断しました` +
          '(少しずつ流れ続けているが終わらない状態)。この投稿は取り込みません。'
      );
    }
    // 接続そのものが張れなかった場合、Node の fetch は `TypeError: fetch failed` としか
    // 言わない。どこで失敗したのか分かるように、原因(cause)を添えて包み直す。
    //
    // 【`e instanceof TypeError` だけで判定しないこと】それでは `null.foo` のような
    // 【自分のコードのバグ】まで「接続に失敗しました」に化けて、原因を取り違える。
    // 実測: ネットワーク由来の TypeError には必ず `cause` が付き(例: "other side closed")、
    // プログラミングミス由来の TypeError には付かない。この違いで切り分ける。
    if (e instanceof TypeError && e.cause !== undefined) {
      const cause = e.cause && e.cause.message ? e.cause.message : String(e.cause);
      throw new Error(
        `Visionモデルへの接続に失敗しました: ${e.message}${cause ? `(${cause})` : ''}。この投稿は取り込みません。`
      );
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
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
 * 同じ理由で、下の「compact JSONで」も出力量の余裕として数えない(冒頭の【最重要2】)。
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
    // 【以下は補強であって担保ではない】実際に効いているのは取込み側の検査
    // (tools/monitor-instagram-apify.js の looksLikeTournamentRow / canonicalTags)。
    // 2026-08-01 の dry-run で、定休日のマス14件が「休み」という大会名で返り、
    // タグが英語小文字(satellite / freeroll / deep stack)で返り、開始時刻の97%が空だったため追加した。
    '【大会ではない行は出力しないでください】定休日・休業日のマス(「休み」「CLOSED」など)、' +
      '画像の見出し(「月間TOURNAMENT」など)、リングゲーム/キャッシュゲームは大会ではありません。',
    'start は必ず画像の時刻表記から読み取ってください。読み取れない場合だけ null にしてください' +
      '(推測で 00:00 などを入れないこと)。',
    '【大会名から金額を推測しないでください】画像に金額が明示されていなければ null です。' +
      '例えば "1K MULTI" や "2K BOUNTY" の 1K/2K は参加費とは限りません(賞金やバウンティ額のことがあります)。',
    'tags は次の語だけを使ってください: サテライト / フリーロール / ディープ / バウンティ / ターボ / ' +
      'ミックス / PLO / リーグ / 特別開催 / JOPT / WJPT / FST。当てはまるものが無ければ空配列にしてください' +
      '(英語やその他の語を使わないこと)。',
    // 出力量の節約(改行・インデント無しで約35%減)。従わなくても MAX_OUTPUT_TOKENS 側で
    // 収まるようにしてあるので、これは所要時間とコストのための指示であって安全域ではない。
    'JSONは改行やインデントを入れず、1行のcompactな形式で出力してください。',
  ]
    .filter(Boolean)
    .join('\n');
  const result = await callVisionModel(imageBuffer, system, user, mediaType || 'image/jpeg');
  // 【配列でない応答を黙って [] に潰さない】
  // 以前はここが `Array.isArray(result) ? result : []` で、Visionが
  // `{"tournaments": [...]}` のように包んで返した場合に【警告も破棄件数も出ないまま0件】になり、
  // 呼び出し側のサマリは「1行も採用できなかった投稿 0件」と表示していた(=積極的な誤報)。
  // 中身は失われているのだから、失われたと言えなければならない。
  if (!Array.isArray(result)) {
    throw new Error(
      'Visionモデルの応答がJSON配列ではありませんでした' +
        `(実際の型=${result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result}` +
        `${result && typeof result === 'object' ? ` / キー=${JSON.stringify(Object.keys(result).slice(0, 5))}` : ''})。` +
        '配列以外を黙って0件として扱うと、この投稿の内容が失われたことに誰も気づけないため失敗させます。'
    );
  }
  const rows = result;
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
  readMessageStream,
  DEFAULT_MODEL,
  MAX_OUTPUT_TOKENS,
  WORST_CASE_TOKENS_PER_ROW,
  MAX_EXPECTED_ROWS,
  NON_STREAMING_SAFE_MAX_TOKENS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_TOTAL_TIMEOUT_MS,
  MEANINGFUL_STREAM_EVENTS,
};
