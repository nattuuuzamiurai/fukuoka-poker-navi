'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchInstagramPosts, normalizeApifyItem } = require('./fetch-venue-posts-apify');

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

test('normalizeApifyItem: 必要フィールドを様々な候補キーから拾い、ISO日時に正規化する', () => {
  const item = normalizeApifyItem({
    url: 'https://www.instagram.com/p/AAAA/',
    displayUrl: 'https://example.com/img.jpg',
    timestamp: '2026-07-20T10:00:00.000Z',
    caption: '9月のスケジュールです',
  });
  assert.equal(item.permalink, 'https://www.instagram.com/p/AAAA/');
  assert.equal(item.imageUrl, 'https://example.com/img.jpg');
  assert.equal(item.postedAt, '2026-07-20T10:00:00.000Z');
  assert.equal(item.caption, '9月のスケジュールです');
});

test('normalizeApifyItem: パーマリンク/画像URL/投稿日時のいずれかが欠けていれば null を返す', () => {
  assert.equal(normalizeApifyItem({ displayUrl: 'x', timestamp: '2026-07-20T10:00:00.000Z' }), null);
  assert.equal(normalizeApifyItem({ url: 'x', timestamp: '2026-07-20T10:00:00.000Z' }), null);
  assert.equal(normalizeApifyItem({ url: 'x', displayUrl: 'y' }), null);
  assert.equal(normalizeApifyItem(null), null);
});

test('fetchInstagramPosts: APIFY_API_TOKEN未設定なら例外を投げ、ネットワークアクセスしない', async () => {
  const envBackup = process.env.APIFY_API_TOKEN;
  delete process.env.APIFY_API_TOKEN;
  let fetchCalled = false;
  try {
    await withMockedFetch(
      async () => {
        fetchCalled = true;
        throw new Error('呼ばれてはいけない');
      },
      async () => {
        await assert.rejects(() => fetchInstagramPosts('triple_orio'), /APIFY_API_TOKEN/);
      }
    );
  } finally {
    if (envBackup !== undefined) process.env.APIFY_API_TOKEN = envBackup;
  }
  assert.equal(fetchCalled, false, 'トークン未設定時はfetchを呼び出してはいけない');
});

test('fetchInstagramPosts: HTTP 200以外は例外を投げる', async () => {
  await withMockedFetch(
    async () => ({ status: 500, text: async () => 'internal error' }),
    async () => {
      await assert.rejects(
        () => fetchInstagramPosts('triple_orio', { apifyApiToken: 'dummy-token' }),
        /HTTP 500/
      );
    }
  );
});

test('fetchInstagramPosts: レスポンスが配列でなければ例外を投げる', async () => {
  await withMockedFetch(
    async () => ({ status: 200, json: async () => ({ not: 'an array' }) }),
    async () => {
      await assert.rejects(
        () => fetchInstagramPosts('triple_orio', { apifyApiToken: 'dummy-token' }),
        /配列ではありません/
      );
    }
  );
});

test('fetchInstagramPosts: 正常系は正規化済みの投稿配列を返し、不完全なアイテムは除外する', async () => {
  let capturedUrl;
  let capturedBody;
  await withMockedFetch(
    async (url, req) => {
      capturedUrl = url;
      capturedBody = JSON.parse(req.body);
      return {
        status: 200,
        json: async () => [
          {
            url: 'https://www.instagram.com/p/AAAA/',
            displayUrl: 'https://example.com/a.jpg',
            timestamp: '2026-07-20T10:00:00.000Z',
            caption: 'スケジュール告知',
          },
          { url: 'https://www.instagram.com/p/BBBB/' }, // 画像URL・投稿日時が欠けている → 除外される
        ],
      };
    },
    async () => {
      const posts = await fetchInstagramPosts('triple_orio', { apifyApiToken: 'dummy-token' });
      assert.equal(posts.length, 1);
      assert.equal(posts[0].permalink, 'https://www.instagram.com/p/AAAA/');
      assert.ok(capturedUrl.includes('token=dummy-token'));
      assert.deepEqual(capturedBody, { username: ['triple_orio'], resultsLimit: 12 });
    }
  );
});

// ============================================================
// 取込みレベルの保存則の材料(opts.stats)
// ============================================================
// 【なぜ要るか】ここで捨てた投稿は Vision にもカウンタにも一切現れないまま消え、
// それでいて確認済み投稿日時は前進する(=二度と処理されない)。取込みの最上流の消失経路。
// monitor 側の保存則(checkIntakeAccounting)はこの数字を左辺に使うので、
// ここが埋まらなくなると保存則が「何も捨てていない」と誤って成立してしまう。

test('fetchInstagramPosts: opts.stats に生の件数と、必須フィールド欠落で捨てた件数を書き戻す', async () => {
  const items = [
    { url: 'https://www.instagram.com/p/A/', displayUrl: 'https://example.com/a.jpg', timestamp: '2026-07-20T10:00:00.000Z', caption: 'ok' },
    { url: 'https://www.instagram.com/p/B/' }, // 画像URLと日時が無い → 除外
    { displayUrl: 'https://example.com/c.jpg', timestamp: '2026-07-21T10:00:00.000Z' }, // permalinkが無い → 除外
    { url: 'https://www.instagram.com/p/D/', displayUrl: 'https://example.com/d.jpg', timestamp: 'これは日付ではない' }, // 日時が壊れている → 除外
  ];
  await withMockedFetch(
    async () => ({ status: 200, json: async () => items }),
    async () => {
      const stats = {};
      const posts = await fetchInstagramPosts('someone', { apifyApiToken: 'dummy', stats });
      assert.equal(posts.length, 1, '正規化できたのは1件');
      assert.equal(stats.rawCount, 4, 'Apifyが返した生の件数');
      assert.equal(stats.malformed, 3, '捨てた件数(これが0固定になると上流の消失が見えなくなる)');
      // 保存則の材料として、必ず rawCount = 返した件数 + malformed が成り立つこと
      assert.equal(stats.rawCount, posts.length + stats.malformed);
    }
  );
});

test('fetchInstagramPosts: opts.stats を渡さなくても従来どおり動く(既存の呼び出しを壊さない)', async () => {
  await withMockedFetch(
    async () => ({
      status: 200,
      json: async () => [
        { url: 'https://www.instagram.com/p/A/', displayUrl: 'https://example.com/a.jpg', timestamp: '2026-07-20T10:00:00.000Z' },
      ],
    }),
    async () => {
      const posts = await fetchInstagramPosts('someone', { apifyApiToken: 'dummy' });
      assert.equal(posts.length, 1);
    }
  );
});

test('fetchInstagramPosts: 1件も捨てなかった場合は malformed が 0 になる', async () => {
  await withMockedFetch(
    async () => ({
      status: 200,
      json: async () => [
        { url: 'https://www.instagram.com/p/A/', displayUrl: 'https://example.com/a.jpg', timestamp: '2026-07-20T10:00:00.000Z' },
        { url: 'https://www.instagram.com/p/B/', displayUrl: 'https://example.com/b.jpg', timestamp: '2026-07-21T10:00:00.000Z' },
      ],
    }),
    async () => {
      const stats = {};
      await fetchInstagramPosts('someone', { apifyApiToken: 'dummy', stats });
      assert.equal(stats.rawCount, 2);
      assert.equal(stats.malformed, 0);
    }
  );
});

// ============================================================
// タイムアウトとリトライ(2026-08-01 dry-run #4 の失敗を受けて)
// ============================================================

test('★タイムアウト: 60秒に戻さない(dry-run #4 は1店目でちょうど60秒で落ちた)', () => {
  const { REQUEST_TIMEOUT_MS, MAX_ATTEMPTS } = require('./fetch-venue-posts-apify');
  // run-sync-get-dataset-items は【アクターの実行完了を待つ】ので、
  // Instagramのスクレイピング時間そのものを含む。60秒では足りないことが実測で分かっている。
  assert.ok(REQUEST_TIMEOUT_MS >= 120000, `短すぎる(${REQUEST_TIMEOUT_MS}ms)。60秒で落ちた実績がある`);
  // 長すぎるとワークフローの timeout-minutes を超える。6店 × 2回 × これ が上限。
  assert.ok(REQUEST_TIMEOUT_MS <= 300000, `長すぎる(${REQUEST_TIMEOUT_MS}ms)。ジョブ全体の予算を超える`);
  assert.ok(MAX_ATTEMPTS >= 2, 'リトライ無しだと一時的な失敗でその店の1日ぶんが飛ぶ');
  assert.ok(MAX_ATTEMPTS <= 3, '多すぎるとジョブ全体の最悪時間が伸びる');
  // 6店 × MAX_ATTEMPTS × タイムアウト が 90分(ワークフローの上限)に収まること
  const worstMin = (6 * MAX_ATTEMPTS * REQUEST_TIMEOUT_MS) / 60000;
  assert.ok(worstMin <= 60, `Apifyだけで最悪${worstMin}分。Visionのぶんが載らない`);
});

test('★リトライ: 一時的な失敗(タイムアウト/5xx/429)は1回やり直す', async () => {
  const { fetchInstagramPosts } = require('./fetch-venue-posts-apify');
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('The operation was aborted due to timeout');
      return {
        status: 200,
        json: async () => [
          { url: 'https://www.instagram.com/p/A/', displayUrl: 'https://example.com/a.jpg', timestamp: '2026-07-20T10:00:00.000Z' },
        ],
      };
    },
    async () => {
      const stats = {};
      const posts = await fetchInstagramPosts('someone', { apifyApiToken: 'dummy', stats });
      assert.equal(posts.length, 1, 'やり直して成功すること');
      assert.equal(calls, 2, '1回だけやり直すこと');
      assert.equal(stats.attempts, 2, '何回目で成功したかを記録すること');
      assert.ok(stats.elapsedMs >= 0, '所要時間を記録すること(次のタイムアウト調整の材料)');
    }
  );
});

test('★リトライ: 直らない失敗(4xx)はやり直さない', async () => {
  const { fetchInstagramPosts } = require('./fetch-venue-posts-apify');
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls += 1;
      return { status: 401, text: async () => 'unauthorized' };
    },
    async () => {
      await assert.rejects(() => fetchInstagramPosts('someone', { apifyApiToken: 'bad' }), /HTTP 401/);
      assert.equal(calls, 1, 'トークン不正はやり直しても直らないので1回で諦めること');
    }
  );
});

test('リトライの判定: 一時的な失敗と恒久的な失敗を取り違えない', () => {
  const { isRetriable } = require('./fetch-venue-posts-apify');
  for (const m of ['The operation was aborted due to timeout', 'Apify呼び出しに失敗: HTTP 503', 'Apify呼び出しに失敗: HTTP 429', 'fetch failed', 'socket hang up']) {
    assert.equal(isRetriable(new Error(m)), true, `やり直すこと: ${m}`);
  }
  for (const m of ['Apify呼び出しに失敗: HTTP 401', 'Apify呼び出しに失敗: HTTP 404', 'Apifyのレスポンス形式が想定外です(配列ではありません)。', 'APIFY_API_TOKEN が未設定です(Apify呼び出しに必須)。']) {
    assert.equal(isRetriable(new Error(m)), false, `やり直さないこと: ${m}`);
  }
});
