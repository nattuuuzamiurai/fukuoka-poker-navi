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
