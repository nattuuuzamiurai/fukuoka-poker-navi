'use strict';
/**
 * venue-schedule-vision.js のテスト。
 *
 * 【このテストが守っているもの】
 * Visionの出力が途中で切れたとき(max_tokensでの打ち切り / 接続断 / 閉じフェンス欠落)、
 *   ・切り捨てが【切り捨てとして】報告されること(JSONパースエラーに化けないこと)
 *   ・途中まで読めたぶんを【部分的に採用しないこと】
 * の2点。ここが緩むと「月の後半が丸ごと欠けた日程」が無言で公開される。
 *
 * 加えて、容量の3つの定数(MAX_EXPECTED_ROWS / WORST_CASE_TOKENS_PER_ROW / MAX_OUTPUT_TOKENS)が
 * 【互いに整合していること】を直接assertする。最初の実装は「200行までは捨てずに通す」と
 * 宣言しながら max_tokens が166行分しか無く、守るはずの月がその手前で切り捨てられていた。
 *
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
    () => vision.assertNotTruncated({ stop_reason: 'max_tokens', usage: { output_tokens: 32768 } }, 'test-model'),
    (e) => {
      assert.match(e.message, /max_tokens/);
      assert.match(e.message, /打ち切られました/);
      assert.match(e.message, /信用できません/);
      assert.match(e.message, /出力トークン=32768/);
      // 運用者を「タイムアウトを伸ばす」ではなく正しい方向に誘導しているか
      assert.match(e.message, /非ストリーミングに戻さないこと/);
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

// ---------- readMessageStream: SSEの読み取り ----------

/** 任意のバイト列(chunkの割れ方も含めて)をfetchのbodyと同じ形のReadableStreamにする。 */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** 正常な1本のストリーム(text を deltas 個に割って流す)。 */
function okStreamChunks(text, stopReason = 'end_turn', outputTokens = 120) {
  const parts = text.match(/[\s\S]{1,17}/g) || [''];
  return [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1800, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...parts.map((p) =>
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })
    ),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } }),
    sse('message_stop', { type: 'message_stop' }),
  ];
}

test('readMessageStream: 通常のSSEを非ストリーミングと同じ形のMessageに組み直す', async () => {
  const body = '```json\n[{"date":"2026-08-01","name":"デイリー"}]\n```';
  const msg = await vision.readMessageStream(streamOf(okStreamChunks(body)));
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.usage.output_tokens, 120);
  assert.equal(msg.usage.input_tokens, 1800);
  assert.equal(msg.content[0].text, body);
});

/** バイト単位で好きな位置に割ってストリームにする(マルチバイト文字の途中で割るため)。 */
function streamOfBytes(bytes, chunkSize) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

test('readMessageStream: 1イベントが複数chunkに割れても、複数イベントが1chunkに来ても正しく読む', async () => {
  const body = '[{"date":"2026-08-01","name":"デイリー"}]';
  const whole = okStreamChunks(body).join('');
  // (a) 1文字ずつ流す = すべてのイベントが途中で割れる
  const oneByte = await vision.readMessageStream(streamOf([...whole]));
  assert.equal(oneByte.content[0].text, body);
  // (b) 全部を1chunkで流す = 1chunkに全イベントが入る
  const oneChunk = await vision.readMessageStream(streamOf([whole]));
  assert.equal(oneChunk.content[0].text, body);
});

test('readMessageStream: マルチバイト文字の途中でchunkが割れても文字化けしない', async () => {
  // 日本語(UTF-8で3バイト)を含む本文を1バイトずつ流す。TextDecoderのstreamモードを
  // 使っていないと、ここで「」のような置換文字が混ざり、大会名が壊れたまま公開される。
  const jp = '[{"name":"日本語のトーナメント名","prize":"賞品あり"}]';
  const bytes = new TextEncoder().encode(okStreamChunks(jp).join(''));
  const msg = await vision.readMessageStream(streamOfBytes(bytes, 1));
  assert.equal(msg.content[0].text, jp);
  assert.doesNotMatch(msg.content[0].text, /�/, '置換文字(U+FFFD)が混ざっている = 文字化け');
  // 3バイト境界と噛み合わない割り方でも同じであること
  const msg2 = await vision.readMessageStream(streamOfBytes(bytes, 7));
  assert.equal(msg2.content[0].text, jp);
});

test('readMessageStream: CRLF区切りのSSEも読める', async () => {
  const body = '[]';
  const chunks = okStreamChunks(body).map((c) => c.replace(/\n/g, '\r\n'));
  const msg = await vision.readMessageStream(streamOf(chunks));
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.content[0].text, body);
});

test('readMessageStream: stop_reason=max_tokens もそのまま拾う(判定は assertNotTruncated 側)', async () => {
  const msg = await vision.readMessageStream(streamOf(okStreamChunks('```json\n[', 'max_tokens', 32768)));
  assert.equal(msg.stop_reason, 'max_tokens');
  assert.equal(msg.usage.output_tokens, 32768);
});

test('readMessageStream: stop_reason を返さないまま終わったストリームは失敗する(接続断で部分採用しない)', async () => {
  // message_delta が来る前に切れた = テキストは途中まで溜まっているが完結していない
  const chunks = okStreamChunks('```json\n[{"date":"2026-08-01"}').slice(0, -2);
  await assert.rejects(
    () => vision.readMessageStream(streamOf(chunks)),
    (e) => {
      assert.match(e.message, /stop_reason を返さないまま終了/);
      assert.match(e.message, /接続が途中で切れた/);
      return true;
    }
  );
});

test('readMessageStream: ping と未知のイベント型は無視する(将来イベントが増えても壊れない)', async () => {
  const body = '[]';
  const chunks = [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    sse('ping', { type: 'ping' }),
    sse('future_event', { type: 'future_event', whatever: true }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body } }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
    sse('message_stop', { type: 'message_stop' }),
  ];
  const msg = await vision.readMessageStream(streamOf(chunks));
  assert.equal(msg.content[0].text, body);
});

test('readMessageStream: ストリーム中のerrorイベント(overloaded等)は失敗させる', async () => {
  const chunks = [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
  ];
  await assert.rejects(() => vision.readMessageStream(streamOf(chunks)), /ストリームがエラーを返しました.*overloaded_error/s);
});

test('readMessageStream: 本文がストリームでない(stream:true が外れた)場合は明示的に失敗する', async () => {
  await assert.rejects(() => vision.readMessageStream(null), /ストリーム本文がありません/);
  await assert.rejects(() => vision.readMessageStream({}), /ストリーム本文がありません/);
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

const sseResponse = (chunks) => ({ status: 200, body: streamOf(chunks), text: async () => '' });

// ---------- タイムアウト機構(2本立て) ----------
// 【なぜテストするか】「全体5分 → 無音2分」への作り替えが PR #26 の設計変更の柱だったのに、
// 機構そのものにテストが1本も無く、定数を1msにしても24時間にしても誰も気づけなかった。
// 定数は callVisionModel の第5引数で上書きできるようにしてあるので、ms単位で実際に発火させる。

/**
 * 指定ミリ秒ごとに chunks を1つずつ流し、尽きたら【閉じずに黙る】ストリーム。
 *
 * 【signal を必ず渡すこと】本物の fetch は signal が abort されるとレスポンス本文の
 * ストリームを AbortError で error にする。ここを再現しないと、タイムアウトで abort しても
 * 読み手が永遠に待ち続け、テストがハングする(=本番の挙動とも違う)。
 */
function slowStream(chunks, intervalMs, { closeAtEnd = false, signal } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    start(controller) {
      if (!signal) return;
      const onAbort = () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        try {
          controller.error(err);
        } catch (_) {
          /* すでに閉じている場合は何もしない */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    pull(controller) {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (i < chunks.length) {
            try {
              controller.enqueue(encoder.encode(chunks[i++]));
            } catch (_) {
              /* abort 済み */
            }
          } else if (closeAtEnd) {
            try {
              controller.close();
            } catch (_) {
              /* abort 済み */
            }
          }
          // closeAtEnd でなければ resolve するだけ = 以後この pull は二度と何も出さず沈黙する
          resolve();
        }, intervalMs);
      });
    },
  });
}

test('タイムアウト: 中身のあるイベントが来なくなったら無音タイムアウトで中断する', async () => {
  const chunks = [sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } })];
  await withStubbedFetch(
    async (url, init) => ({ status: 200, body: slowStream(chunks, 5, { signal: init.signal }), text: async () => '' }),
    async () => {
      await assert.rejects(
        () => vision.callVisionModel(Buffer.from('img'), 'sys', 'user', 'image/jpeg', { idleTimeoutMs: 120 }),
        (e) => {
          assert.match(e.message, /中身のあるイベントが 0\.12秒 届かなかった/);
          return true;
        }
      );
    }
  );
});

test('タイムアウト: ping だけが流れ続けても無音タイムアウトが発火する(pingで延命されない)', async () => {
  // 【この挙動が本体】以前はチャンク到着だけでタイマーを延ばしていたため、
  // pingを送り続ける相手に対して無音タイムアウトが永久に発火しなかった。
  const pings = Array.from({ length: 200 }, () => sse('ping', { type: 'ping' }));
  await withStubbedFetch(
    async (url, init) => ({ status: 200, body: slowStream(pings, 5, { signal: init.signal }), text: async () => '' }),
    async () => {
      await assert.rejects(
        () => vision.callVisionModel(Buffer.from('img'), 'sys', 'user', 'image/jpeg', { idleTimeoutMs: 120 }),
        (e) => {
          assert.match(e.message, /中身のあるイベントが/);
          assert.match(e.message, /pingだけが流れている可能性/);
          return true;
        }
      );
    }
  );
});

test('タイムアウト: 中身のあるイベントが届き続ける間は無音タイムアウトで切られない', async () => {
  // 逆側の保証。これが無いと「無音タイムアウトを極端に短くする」改悪に気づけない。
  const chunks = okStreamChunks('[{"date":"2026-08-01","name":"デイリー"}]');
  await withStubbedFetch(
    async (url, init) => ({
      status: 200,
      body: slowStream(chunks, 5, { closeAtEnd: true, signal: init.signal }),
      text: async () => '',
    }),
    async () => {
      // 1イベントあたり5ms間隔 < idleTimeout 200ms なので、最後まで読み切れる
      const got = await vision.callVisionModel(Buffer.from('img'), 'sys', 'user', 'image/jpeg', {
        idleTimeoutMs: 200,
      });
      assert.deepEqual(got, [{ date: '2026-08-01', name: 'デイリー' }]);
    }
  );
});

test('タイムアウト: ゆっくり流れ続けて終わらない相手は、総時間の上限で中断する', async () => {
  // 無音タイムアウトだけでは止められないケース(中身のあるイベントが遅いが届き続ける)。
  const many = Array.from({ length: 500 }, (_, i) =>
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })
  );
  await withStubbedFetch(
    async (url, init) => ({ status: 200, body: slowStream(many, 5, { signal: init.signal }), text: async () => '' }),
    async () => {
      await assert.rejects(
        () =>
          vision.callVisionModel(Buffer.from('img'), 'sys', 'user', 'image/jpeg', {
            idleTimeoutMs: 5000, // 無音では切れない(5msごとに中身のあるイベントが届く)
            totalTimeoutMs: 150,
          }),
        (e) => {
          assert.match(e.message, /0\.15秒 で完了しなかった/);
          return true;
        }
      );
    }
  );
});

test('【整合】タイムアウトの既定値が妥当なレンジにあること', () => {
  // 定数を1msや24時間にする改悪を止める(上のテストは引数で上書きするため定数自体は見ない)。
  assert.ok(
    vision.STREAM_IDLE_TIMEOUT_MS >= 30000 && vision.STREAM_IDLE_TIMEOUT_MS <= 600000,
    `STREAM_IDLE_TIMEOUT_MS=${vision.STREAM_IDLE_TIMEOUT_MS} が 30秒〜10分 のレンジ外`
  );
  assert.ok(
    vision.STREAM_TOTAL_TIMEOUT_MS > vision.STREAM_IDLE_TIMEOUT_MS,
    '総時間の上限が無音タイムアウト以下では、無音タイムアウトが意味を持たない'
  );
  // MAX_OUTPUT_TOKENS を悲観的な生成速度(40トークン/秒)で出し切れる長さがあること
  assert.ok(
    vision.STREAM_TOTAL_TIMEOUT_MS / 1000 >= vision.MAX_OUTPUT_TOKENS / 40,
    `STREAM_TOTAL_TIMEOUT_MS が短く、正当な長い応答を切る恐れがある`
  );
});

test('ping は無音タイマーを延ばす対象に含めない(MEANINGFUL_STREAM_EVENTS の内容を固定)', () => {
  assert.ok(!vision.MEANINGFUL_STREAM_EVENTS.has('ping'), 'ping を含めると無音タイムアウトが効かなくなる');
  for (const t of ['message_start', 'content_block_delta', 'message_delta', 'message_stop']) {
    assert.ok(vision.MEANINGFUL_STREAM_EVENTS.has(t), `${t} は生成が進んでいる証拠なので含めること`);
  }
});

// ---------- thinking_delta が本文に混ざらないこと ----------

test('readMessageStream: thinking_delta は本文に混ぜない(text_delta だけを採る)', async () => {
  // ANTHROPIC_VISION_MODEL で Sonnet 5 / Opus 5 に差し替えると adaptive thinking が既定でONになり、
  // thinking_delta が流れてくる。これを本文に混ぜると JSON パースが壊れる(あるいは最悪、
  // 思考の断片がJSONとして解釈できてしまう)。
  const chunks = [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'まず画像を見る。8月の表だ。[{"date":"9999-99-99"}]' },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '[{"date":"2026-08-01","name":"デイリー"}]' },
    }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }),
  ];
  const msg = await vision.readMessageStream(streamOf(chunks));
  assert.equal(msg.content[0].text, '[{"date":"2026-08-01","name":"デイリー"}]');
  assert.doesNotMatch(msg.content[0].text, /まず画像を見る/, '思考の断片が本文に混ざっている');
  assert.doesNotMatch(msg.content[0].text, /9999-99-99/, '思考の中のJSONらしき断片が本文に混ざっている');
});

test('readMessageStream: signature_delta など未知のdelta型も本文に混ぜない', async () => {
  const chunks = [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'AAAA' },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"x":' },
    }),
    sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '[]' } }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
  ];
  const msg = await vision.readMessageStream(streamOf(chunks));
  assert.equal(msg.content[0].text, '[]');
});

// ---------- 接続失敗とプログラミングミスを取り違えないこと ----------

test('callVisionModel: ネットワーク由来のTypeError(causeあり)は「接続に失敗」として報告する', async () => {
  const networkError = new TypeError('fetch failed');
  networkError.cause = new Error('other side closed');
  await withStubbedFetch(
    async () => {
      throw networkError;
    },
    async () => {
      await assert.rejects(
        () => vision.callVisionModel(Buffer.from('img'), 'sys', 'user'),
        (e) => {
          assert.match(e.message, /接続に失敗しました/);
          assert.match(e.message, /other side closed/);
          return true;
        }
      );
    }
  );
});

test('callVisionModel: 自分のコードのバグ(causeなしのTypeError)を「接続に失敗」に化けさせない', async () => {
  // `null.foo` のようなプログラミングミスまで「接続に失敗しました」と報告すると、
  // 原因を取り違えて延々とネットワークを疑うことになる。実測では、ネットワーク由来の
  // TypeError には必ず cause が付き、プログラミングミス由来には付かない。
  await withStubbedFetch(
    async () => {
      // eslint-disable-next-line no-unused-expressions
      null.foo;
    },
    async () => {
      await assert.rejects(
        () => vision.callVisionModel(Buffer.from('img'), 'sys', 'user'),
        (e) => {
          assert.ok(e instanceof TypeError, 'プログラミングミスは元の TypeError のまま投げること');
          assert.doesNotMatch(e.message, /接続に失敗しました/);
          return true;
        }
      );
    }
  );
});

test('callVisionModel: 打ち切られた応答は、JSONパースエラーではなく max_tokens の失敗として報告される', async () => {
  // 実際のAPIが返す形: stop_reason=max_tokens + 閉じフェンスの無い本文
  const truncatedText = '```json\n[\n  {"date": "2026-08-01", "name": "デイリー"';
  await withStubbedFetch(
    async () => sseResponse(okStreamChunks(truncatedText, 'max_tokens', 32768)),
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
  await withStubbedFetch(
    async () => sseResponse(okStreamChunks('```json\n[{"date":"2026-08-01","name":"デイリー"}]\n```')),
    async () => {
      const got = await vision.callVisionModel(Buffer.from('img'), 'sys', 'user');
      assert.deepEqual(got, [{ date: '2026-08-01', name: 'デイリー' }]);
    }
  );
});

test('callVisionModel: max_tokens が MAX_OUTPUT_TOKENS のまま、かつ stream:true で送られる', async () => {
  await withStubbedFetch(
    async () => sseResponse(okStreamChunks('[]')),
    async (calls) => {
      await vision.callVisionModel(Buffer.from('img'), 'sys', 'user');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.max_tokens, vision.MAX_OUTPUT_TOKENS);
      // ~16K超の呼び出しは非ストリーミングにしてはいけない(Anthropicの移行ガイド)
      assert.equal(sent.stream, true, 'stream:true が外れている(max_tokens > ~16K では必須)');
    }
  );
});

// ---------- 容量の定数どうしの整合(これが無いと同じズレが再発する) ----------

test('【整合】MAX_EXPECTED_ROWS 行を出し切れるだけの MAX_OUTPUT_TOKENS があること', () => {
  // 「200行までは捨てずに通す」と決めた以上、200行を出し切れる上限が要る。
  // 実測の【最悪値】(131トークン/行)で直接assertする。
  const needed = vision.MAX_EXPECTED_ROWS * vision.WORST_CASE_TOKENS_PER_ROW;
  assert.ok(
    vision.MAX_OUTPUT_TOKENS >= needed,
    `MAX_EXPECTED_ROWS=${vision.MAX_EXPECTED_ROWS}行 × ${vision.WORST_CASE_TOKENS_PER_ROW}トークン/行 = ${needed} を` +
      ` MAX_OUTPUT_TOKENS=${vision.MAX_OUTPUT_TOKENS} が下回っている` +
      '(「捨てない設計なのに、その手前で切り捨てられる」矛盾)'
  );
});

test('【整合】WORST_CASE_TOKENS_PER_ROW が実測の最大値を下回っていないこと', () => {
  // 実トークナイザ3種での実測: 実分布95.2〜98.5 / 全項目が埋まった行 約123.3 /
  // 全項目が埋まり大会名が日本語だけの行 約130.4(全シナリオ中の最大)。
  //
  // 【平均や「実測レンジの下の方」に置き換えないこと】この定数が最大でないと、
  // 上のassertが「通ったのに実際には危ない」を許す。例えば123.3(=日本語名を含まない値)を
  // 置いたまま MAX_EXPECTED_ROWS を250に上げると 250×124=31,000 で通るが、
  // 実際の最悪値では 250×130.4=32,600 で余裕がほぼ消える。
  assert.ok(
    vision.WORST_CASE_TOKENS_PER_ROW >= 131,
    `WORST_CASE_TOKENS_PER_ROW=${vision.WORST_CASE_TOKENS_PER_ROW} は実測の最大値(130.4の切り上げ=131)を下回っている`
  );
});

test('【整合】MAX_OUTPUT_TOKENS がモデルの最大出力(claude-sonnet-4-5: 64,000)を超えていないこと', () => {
  assert.ok(vision.MAX_OUTPUT_TOKENS <= 64000, 'claude-sonnet-4-5 の最大出力(64,000)を超えている');
});

test('【整合】MAX_OUTPUT_TOKENS が ~16K を超えるなら、実際にストリーミングで呼んでいること', async () => {
  if (vision.MAX_OUTPUT_TOKENS <= vision.NON_STREAMING_SAFE_MAX_TOKENS) return; // 16K以下なら非ストリーミングでもよい
  await withStubbedFetch(
    async () => sseResponse(okStreamChunks('[]')),
    async (calls) => {
      await vision.callVisionModel(Buffer.from('img'), 'sys', 'user');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(
        sent.stream,
        true,
        `max_tokens=${sent.max_tokens} は非ストリーミングの安全域(${vision.NON_STREAMING_SAFE_MAX_TOKENS})を超えているのに stream:true でない`
      );
    }
  );
});

test('【整合】実分布の150行・200行が、実測トークン数でも MAX_OUTPUT_TOKENS に収まること', () => {
  // 品質管理部が実トークナイザで測った値(pretty print)。ヒューリスティックではなく実測の固定値。
  const MEASURED = {
    '実分布100行': 10010,
    '実分布150行': 14772,
    'テスト用fixture150行': 16803,
    '全項目が埋まった150行': 18465,
    '実分布186行': 18188,
    '実分布200行': 19689,
    '全項目が埋まった200行': 24652,
  };
  for (const [label, tokens] of Object.entries(MEASURED)) {
    assert.ok(
      vision.MAX_OUTPUT_TOKENS >= tokens,
      `${label} の実測 ${tokens}トークンが MAX_OUTPUT_TOKENS=${vision.MAX_OUTPUT_TOKENS} に収まらない`
    );
  }
});

// ---------- MAX_EXPECTED_ROWS の警告 ----------

test('extractTournaments: MAX_EXPECTED_ROWS を超えたら警告を出す(ただし捨てない)', async () => {
  const rows = Array.from({ length: vision.MAX_EXPECTED_ROWS + 1 }, (_, i) => ({
    date: '2026-08-01',
    name: `大会${i}`,
  }));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await withStubbedFetch(
      async () => sseResponse(okStreamChunks(JSON.stringify(rows))),
      async () => {
        const got = await vision.extractTournaments(Buffer.from('img'));
        assert.equal(got.length, vision.MAX_EXPECTED_ROWS + 1, '警告は出しても行は捨てないこと');
      }
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, '警告が1件出ること');
  assert.match(warnings[0], new RegExp(`${vision.MAX_EXPECTED_ROWS + 1}件の行が返りました`));
  assert.match(warnings[0], /想定上限/);
});

test('extractTournaments: 配列でないJSONを黙って0件に潰さず、明示的に失敗する', async () => {
  // Visionが `{"tournaments": [...]}` のように包んで返した場合。旧実装はここを [] に潰し、
  // 警告も破棄件数も出ないまま「1行も採用できなかった投稿 0件」と表示していた(積極的な誤報)。
  await withStubbedFetch(
    async () => sseResponse(okStreamChunks('```json\n{"tournaments": [{"date":"2026-08-01","name":"X"}]}\n```')),
    async () => {
      await assert.rejects(
        () => vision.extractTournaments(Buffer.from('img')),
        (e) => {
          assert.match(e.message, /JSON配列ではありませんでした/);
          assert.match(e.message, /tournaments/); // どんなキーで返ってきたかが分かること
          return true;
        }
      );
    }
  );
});

test('extractTournaments: 空配列は正当な応答として通す(0件と「配列でない」を混同しない)', async () => {
  await withStubbedFetch(
    async () => sseResponse(okStreamChunks('[]')),
    async () => {
      assert.deepEqual(await vision.extractTournaments(Buffer.from('img')), []);
    }
  );
});

test('readMessageStream: 受信中に接続が切れたら、原因が分かる形で失敗する', async () => {
  // 相手がソケットを切ると fetch は `TypeError: fetch failed` しか返さず原因が読めない。
  const broken = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse('message_start', { type: 'message_start', message: {} })));
    },
    pull() {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => vision.readMessageStream(broken),
    (e) => {
      assert.match(e.message, /受信中に接続が切れました/);
      assert.match(e.message, /取り込みません/);
      return true;
    }
  );
});

test('extractTournaments: MAX_EXPECTED_ROWS 以内なら警告を出さない', async () => {
  const rows = Array.from({ length: vision.MAX_EXPECTED_ROWS }, (_, i) => ({ date: '2026-08-01', name: `大会${i}` }));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await withStubbedFetch(
      async () => sseResponse(okStreamChunks(JSON.stringify(rows))),
      async () => {
        const got = await vision.extractTournaments(Buffer.from('img'));
        assert.equal(got.length, vision.MAX_EXPECTED_ROWS);
      }
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0, '想定内の件数で警告を出してはいけない');
});
