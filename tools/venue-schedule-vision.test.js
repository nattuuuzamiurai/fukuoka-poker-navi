'use strict';
/**
 * venue-schedule-vision.js のテスト。
 *
 * 【このテストが守っているもの】
 * Visionの出力が max_tokens で途中打ち切りになったとき、
 *   ・切り捨てが【切り捨てとして】報告されること(JSONパースエラーに化けないこと)
 *   ・途中まで読めたぶんを【部分的に採用しないこと】
 * の2点。ここが緩むと「月の後半が丸ごと欠けた日程」が無言で公開される。
 * 実行: node tools/venue-schedule-vision.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vision = require('./venue-schedule-vision');

// ---------- extractJson: 3パターン ----------

test('extractJson: フェンスが開いて閉じている応答は中身をパースする', () => {
  const text = '```json\n[{"date":"2026-08-01","name":"デイリー"}]\n```';
  assert.deepEqual(vision.extractJson(text), [{ date: '2026-08-01', name: 'デイリー' }]);
});

test('extractJson: フェンスが最初から無い純粋なJSONは従来どおり通る', () => {
  const text = '[{"date":"2026-08-01","name":"デイリー"}]';
  assert.deepEqual(vision.extractJson(text), [{ date: '2026-08-01', name: 'デイリー' }]);
});

test('extractJson: 前置きの説明文が付いていても、閉じていれば中身をパースする(従来の挙動)', () => {
  const text = '以下が抽出結果です:\n```json\n[{"date":"2026-08-01","name":"デイリー"}]\n```\n以上です。';
  assert.deepEqual(vision.extractJson(text), [{ date: '2026-08-01', name: 'デイリー' }]);
});

test('extractJson: 開きフェンスがあるのに閉じフェンスが無い応答は、部分的に拾わず明示的に失敗する', () => {
  // 2026-07-31 の dry-run で実際に起きた形(月間スケジュールが途中で切れた応答)
  const truncated =
    '```json\n[\n' +
    '  {\n    "date": "2026-08-01",\n    "start": "19:00",\n    "name": "デイリートーナメント"\n  },\n' +
    '  {\n    "date": "2026-08-02",\n    "start": "19:00",\n    "name": "デイリートーナ';
  assert.throws(
    () => vision.extractJson(truncated),
    (e) => {
      assert.match(e.message, /閉じフェンスがありません/);
      assert.match(e.message, /途中で切れた/);
      // JSONパースエラーとして表面化してはいけない(原因を誤診させるため)
      assert.doesNotMatch(e.message, /is not valid JSON/);
      return true;
    }
  );
});

test('extractJson: 切れた位置がたまたま要素の切れ目でも、部分的な配列を返さない', () => {
  // 「[ ... },」まで出て切れた ＝ この後ろを補えばJSONとして読めてしまう形。
  // 緩い実装だと 1件だけ取り込めてしまい、残りの月が無言で消える。
  const truncated =
    '```json\n[\n' + '  {"date": "2026-08-01", "start": "19:00", "name": "デイリー"}\n';
  assert.throws(() => vision.extractJson(truncated), /閉じフェンスがありません/);
});

test('extractJson: 応答が空なら、空であることを明示して失敗する', () => {
  assert.throws(() => vision.extractJson(''), /応答が空/);
  assert.throws(() => vision.extractJson('   \n '), /応答が空/);
  assert.throws(() => vision.extractJson(undefined), /応答が空/);
});

// ---------- assertNotTruncated: stop_reason の検査 ----------

test('assertNotTruncated: stop_reason=max_tokens は「打ち切られた」と分かるメッセージで失敗する', () => {
  assert.throws(
    () => vision.assertNotTruncated({ stop_reason: 'max_tokens', usage: { output_tokens: 16384 } }, 'test-model'),
    (e) => {
      assert.match(e.message, /max_tokens/);
      assert.match(e.message, /打ち切られました/);
      assert.match(e.message, /信用できません/);
      assert.match(e.message, /出力トークン=16384/);
      return true;
    }
  );
});

test('assertNotTruncated: end_turn / stop_sequence は通す', () => {
  vision.assertNotTruncated({ stop_reason: 'end_turn' }, 'test-model');
  vision.assertNotTruncated({ stop_reason: 'stop_sequence' }, 'test-model');
  vision.assertNotTruncated({}, 'test-model'); // stop_reason が無い応答(モックなど)は素通し
});

test('assertNotTruncated: 知らない stop_reason(refusal など)も素通しせず失敗する', () => {
  assert.throws(
    () => vision.assertNotTruncated({ stop_reason: 'refusal' }, 'test-model'),
    /正常に終了していません.*refusal/s
  );
  assert.throws(() => vision.assertNotTruncated({ stop_reason: 'pause_turn' }, 'test-model'), /正常に終了していません/);
});

// ---------- callVisionModel: 実際にHTTP応答を受け取る経路 ----------

function withStubbedFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  process.env.ANTHROPIC_API_KEY = 'dummy-key-for-test';
  try {
    return fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
}

const okResponse = (body) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('callVisionModel: 打ち切られた応答は、JSONパースエラーではなく max_tokens の失敗として報告される', async () => {
  // 実際のAPIが返す形: stop_reason=max_tokens + 閉じフェンスの無い本文
  const truncatedBody = {
    stop_reason: 'max_tokens',
    usage: { input_tokens: 2000, output_tokens: 2048 },
    content: [{ type: 'text', text: '```json\n[\n  {"date": "2026-08-01", "name": "デイリー"' }],
  };
  await withStubbedFetch(
    async () => okResponse(truncatedBody),
    async () => {
      await assert.rejects(
        () => vision.callVisionModel(Buffer.from('img'), 'sys', 'user'),
        (e) => {
          assert.match(e.message, /max_tokens\(\d+\)で打ち切られました/);
          assert.doesNotMatch(e.message, /is not valid JSON/);
          return true;
        }
      );
    }
  );
});

test('callVisionModel: 正常な応答(end_turn + 閉じたフェンス)はパースして返す', async () => {
  const body = {
    stop_reason: 'end_turn',
    usage: { input_tokens: 2000, output_tokens: 120 },
    content: [{ type: 'text', text: '```json\n[{"date":"2026-08-01","name":"デイリー"}]\n```' }],
  };
  await withStubbedFetch(
    async () => okResponse(body),
    async () => {
      const got = await vision.callVisionModel(Buffer.from('img'), 'sys', 'user');
      assert.deepEqual(got, [{ date: '2026-08-01', name: 'デイリー' }]);
    }
  );
});

test('callVisionModel: リクエストの max_tokens が MAX_OUTPUT_TOKENS のまま送られる(2048への逆戻り防止)', async () => {
  const body = { stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }] };
  await withStubbedFetch(
    async () => okResponse(body),
    async (calls) => {
      await vision.callVisionModel(Buffer.from('img'), 'sys', 'user');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.max_tokens, vision.MAX_OUTPUT_TOKENS);
      assert.ok(sent.max_tokens >= 12000, `100行級の月が収まらない値に戻っている(${sent.max_tokens})`);
    }
  );
});

// ---------- MAX_OUTPUT_TOKENS の妥当性(実測に基づく下限) ----------

test('MAX_OUTPUT_TOKENS: 150行の月間スケジュールを pretty print で出し切れる大きさがある', () => {
  // 実データ(監視対象6店の191エントリ)の実測値: pretty printで1行あたり約240文字/259バイト。
  // ここでは実データを読まず、その平均に相当する固定フィクスチャで再現する
  // (README「テストに実データの件数を書かないこと」に従い、店が増えても壊れないようにするため)。
  const row = {
    date: '2026-08-01',
    start: '19:00',
    name: 'SUPER CHAMPIONSHIP FUKUOKA サテライト',
    buyin: 3500,
    addon: null,
    stack: 30000,
    guarantee: null,
    reentry: true,
    prize: null,
    tags: ['サテライト', 'WJPT'],
  };
  const rows = Array.from({ length: 150 }, () => row);
  const pretty = JSON.stringify(rows, null, 2);
  const chars = [...pretty];
  const nonAscii = chars.filter((c) => c.charCodeAt(0) >= 128).length;
  const ascii = chars.length - nonAscii;
  // 保守的な見積り: ASCIIは3文字/トークン、日本語は1.5トークン/文字
  const estimatedTokens = Math.ceil(ascii / 3 + nonAscii * 1.5);
  assert.ok(
    vision.MAX_OUTPUT_TOKENS >= estimatedTokens,
    `MAX_OUTPUT_TOKENS(${vision.MAX_OUTPUT_TOKENS})が150行の見積り(${estimatedTokens}トークン)に足りない`
  );
  // 使用モデル claude-sonnet-4-5 の最大出力(64,000トークン)を超えていないこと
  assert.ok(vision.MAX_OUTPUT_TOKENS <= 64000, 'claude-sonnet-4-5 の最大出力(64,000)を超えている');
});

test('REQUEST_TIMEOUT_MS: MAX_OUTPUT_TOKENS を出し切れる長さがある(60秒のままでは足りない)', () => {
  // 生成速度レンジの下限 60トークン/秒 で MAX_OUTPUT_TOKENS を出すのに必要な秒数
  const neededSec = vision.MAX_OUTPUT_TOKENS / 60;
  assert.ok(
    vision.REQUEST_TIMEOUT_MS / 1000 >= neededSec,
    `タイムアウト(${vision.REQUEST_TIMEOUT_MS}ms)が短く、切り捨てをAbortErrorに置き換えるだけになる`
  );
  // 12投稿×6店=72回すべてがタイムアウトしてもGitHub Actionsの既定上限(360分)を超えないこと。
  // これを超える値にするならワークフローに timeout-minutes を明示すること。
  assert.ok((vision.REQUEST_TIMEOUT_MS * 72) / 60000 <= 360, 'ジョブ全体の最悪所要時間が360分を超える');
  // Anthropicが非ストリーミングで推奨しない「10分超」に入っていないこと
  assert.ok(vision.REQUEST_TIMEOUT_MS <= 600000, '非ストリーミングで10分を超えるタイムアウトになっている');
});
