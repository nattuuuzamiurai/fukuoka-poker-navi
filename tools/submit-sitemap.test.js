'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { parseArgs, sitemapSubmitUrl, submitSitemap } = require('./submit-sitemap');

const TOOLS_DIR = __dirname;

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

test('parseArgs: 既定値はfukuokapoker.comのsite/sitemap', () => {
  const args = parseArgs([]);
  assert.equal(args.site, 'https://fukuokapoker.com/');
  assert.equal(args.sitemap, 'https://fukuokapoker.com/sitemap.xml');
});

test('parseArgs: --site / --sitemap で上書きできる', () => {
  const args = parseArgs(['--site=https://example.com/', '--sitemap=https://example.com/sitemap.xml']);
  assert.equal(args.site, 'https://example.com/');
  assert.equal(args.sitemap, 'https://example.com/sitemap.xml');
});

test('sitemapSubmitUrl: siteUrl・sitemapUrlの両方をURLエンコードして組み立てる', () => {
  const url = sitemapSubmitUrl('https://fukuokapoker.com/', 'https://fukuokapoker.com/sitemap.xml');
  assert.equal(
    url,
    'https://www.googleapis.com/webmasters/v3/sites/' +
      encodeURIComponent('https://fukuokapoker.com/') +
      '/sitemaps/' +
      encodeURIComponent('https://fukuokapoker.com/sitemap.xml')
  );
  // 素朴に埋め込んだ場合と違うことを直接確認する(スラッシュがエンコードされていること)
  assert.ok(!url.includes('sites/https://'), 'siteUrlがエンコードされずに埋め込まれています');
  assert.ok(url.includes('sites/https%3A%2F%2Ffukuokapoker.com%2F'));
  assert.ok(url.includes('/sitemaps/https%3A%2F%2Ffukuokapoker.com%2Fsitemap.xml'));
});

test('submitSitemap: PUTメソッド・Authorizationヘッダー・正しいURLでリクエストする', async () => {
  let capturedUrl;
  let capturedInit;
  await withMockedFetch(
    async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, text: async () => '' };
    },
    async () => {
      const status = await submitSitemap('dummy-access-token', 'https://fukuokapoker.com/', 'https://fukuokapoker.com/sitemap.xml');
      assert.equal(status, 200);
      assert.equal(capturedUrl, sitemapSubmitUrl('https://fukuokapoker.com/', 'https://fukuokapoker.com/sitemap.xml'));
      assert.equal(capturedInit.method, 'PUT');
      assert.equal(capturedInit.headers.Authorization, 'Bearer dummy-access-token');
      // GETと違いボディは不要(sitemaps.submitはPUTのみでボディなし)
      assert.equal(capturedInit.body, undefined);
    }
  );
});

test('submitSitemap: HTTP異常時はレスポンスボディを含めて例外を投げる', async () => {
  await withMockedFetch(
    async () => ({ ok: false, status: 403, text: async () => 'insufficient permission' }),
    async () => {
      await assert.rejects(
        () => submitSitemap('dummy-access-token', 'https://fukuokapoker.com/', 'https://fukuokapoker.com/sitemap.xml'),
        /HTTP 403.*insufficient permission/s
      );
    }
  );
});

// ============================================================
// メインプロセスとしての実行(exit code / スキップ挙動)
// ============================================================
// 【なぜ別プロセスで実行するか】process.env と process.exitCode の副作用を、
// このテストファイル自身や他のテストから隔離するため(execFileSyncで子プロセスに閉じ込める)。

test('CLI: GSC_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS が未設定なら exit 0 でスキップする', () => {
  const env = { ...process.env };
  delete env.GSC_SERVICE_ACCOUNT_KEY;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  const out = execFileSync(process.execPath, [path.join(TOOLS_DIR, 'submit-sitemap.js')], {
    env,
    encoding: 'utf8',
  });
  assert.match(out, /スキップします/);
});

test('CLI: GSC_SERVICE_ACCOUNT_KEY が壊れたJSONの場合はexit 1で落ちる(握りつぶさない)', () => {
  const env = { ...process.env, GSC_SERVICE_ACCOUNT_KEY: '{not valid json' };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  assert.throws(() => {
    execFileSync(process.execPath, [path.join(TOOLS_DIR, 'submit-sitemap.js')], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, /Command failed/);
});
