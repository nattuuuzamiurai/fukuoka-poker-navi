'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const monitor = require('./sns-monitor-instagram');
const merge = require('./tournament-merge');

class FakeAuthWallError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'AuthWallError';
  }
}

function fixtureSource() {
  const tournaments = [
    {
      id: 'past-1',
      venueId: 'v40',
      name: '過去の大会',
      date: '2020-01-01',
      start: '19:00',
      buyin: 1000,
      addon: null,
      stack: 10000,
      guarantee: null,
      reentry: false,
      prize: null,
      tags: [],
      source: 'auto',
      verified: false,
    },
    {
      id: 'other-1',
      venueId: 'v99',
      name: '他店',
      date: '2026-08-01',
      start: '19:00',
      buyin: 1000,
      addon: null,
      stack: 10000,
      guarantee: null,
      reentry: false,
      prize: null,
      tags: [],
      source: 'manual',
      verified: true,
    },
  ];
  return `const VENUES = [];\nconst TOURNAMENTS = ${JSON.stringify(tournaments, null, 2)};\nconst AREAS = [];\n`;
}

function writeFixture() {
  const file = path.join(os.tmpdir(), `data-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, fixtureSource());
  return file;
}

function baseStoreState() {
  return {
    handle: 'triple_orio',
    cadenceType: 'monthly',
    observedIntervals: [],
    lastFoundPostDate: null,
    lastFoundPostUrl: null,
    nextCheckWindow: { start: '2026-07-28', end: '2026-08-03' },
    missThresholdDate: '2026-08-03',
    consecutiveMisses: 0,
    lastAttemptDate: null,
    missReportedForCycle: false,
  };
}

function makeMockBrowserLib({ authWallOnProfile = false, authWallOnPost = false } = {}) {
  return {
    AuthWallError: FakeAuthWallError,
    async withInstagramContext(cookie, fn) {
      const context = {
        async newPage() {
          return {
            async goto() {},
            url() {
              return 'https://www.instagram.com/p/AAAA/';
            },
            async screenshot() {
              return Buffer.from('post-fallback-screenshot');
            },
          };
        },
      };
      return fn(context);
    },
    async screenshotProfileFeed(context, handle) {
      if (authWallOnProfile) throw new FakeAuthWallError('ログイン画面にリダイレクトされました(テスト)');
      return { screenshot: Buffer.from('feed-screenshot'), page: { fake: true } };
    },
    async listRecentPostLinks(page, limit) {
      return ['https://www.instagram.com/p/AAAA/'];
    },
    async detectAuthWall(page) {
      if (authWallOnPost) return { blocked: true, reason: 'テスト用のブロック検知' };
      return { blocked: false, reason: null };
    },
  };
}

const noOpOembedLib = {
  async fetchOembedHtml() {
    return null; // 常にフォールバック(開いているページを直接スクショ)させる
  },
  async renderOembedScreenshot() {
    return null;
  },
};

function makeMockVisionLib({ hasNewPost, isScheduleAnnouncement = true, tournaments = [] } = {}) {
  return {
    async detectNewPost() {
      return { hasNewPost, isScheduleAnnouncement, postIndex: 0, reasoning: 'test' };
    },
    async extractTournaments() {
      return tournaments;
    },
  };
}

test('checkStore: 新着なしのときはdata.jsを書き換えずmiss扱いになる', async () => {
  const file = writeFixture();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const storeState = baseStoreState();
    const { nextState, alert } = await monitor.checkStore('v40', storeState, '2026-07-29', {
      browserLib: makeMockBrowserLib(),
      oembedLib: noOpOembedLib,
      visionLib: makeMockVisionLib({ hasNewPost: false }),
      dryRun: false,
      dataJsPath: file,
    });
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'data.jsは一切書き換わらない');
    assert.equal(alert, null, 'ウィンドウ途中のmissでは(missThresholdDate未到達なら)報告しない');
    assert.equal(nextState.lastAttemptDate, '2026-07-29');
  } finally {
    fs.unlinkSync(file);
  }
});

test('checkStore: missThresholdDateに到達した日のmissはアラートを返す', async () => {
  const file = writeFixture();
  try {
    const storeState = baseStoreState();
    const { alert } = await monitor.checkStore('v40', storeState, '2026-08-03', {
      browserLib: makeMockBrowserLib(),
      oembedLib: noOpOembedLib,
      visionLib: makeMockVisionLib({ hasNewPost: false }),
      dryRun: false,
      dataJsPath: file,
    });
    assert.ok(alert, 'missThresholdDate到達時はアラートが返る');
    assert.equal(alert.type, 'missed_deadline');
    assert.equal(alert.venueId, 'v40');
  } finally {
    fs.unlinkSync(file);
  }
});

test('checkStore: 新着発見時はVision抽出結果をdata.jsにsource=auto/verified=falseでupsertする', async () => {
  const file = writeFixture();
  try {
    const storeState = baseStoreState();
    const scraped = [
      {
        date: '2026-08-10',
        start: '19:00',
        name: '新イベント',
        buyin: 1500,
        addon: null,
        stack: 15000,
        guarantee: null,
        reentry: false,
        prize: null,
        tags: ['ターボ'],
      },
    ];
    const { nextState, alert } = await monitor.checkStore('v40', storeState, '2026-08-01', {
      browserLib: makeMockBrowserLib(),
      oembedLib: noOpOembedLib,
      visionLib: makeMockVisionLib({ hasNewPost: true, tournaments: scraped }),
      dryRun: false,
      dataJsPath: file,
    });

    assert.equal(alert, null);
    assert.equal(nextState.lastFoundPostDate, '2026-08-01');
    assert.equal(nextState.lastFoundPostUrl, 'https://www.instagram.com/p/AAAA/');
    assert.deepEqual(nextState.observedIntervals, [S_offset()]);

    const parsed = merge.readDataJs(file);
    const added = parsed.arr.find((t) => t.venueId === 'v40' && t.date === '2026-08-10');
    assert.ok(added, '新しいトーナメントがdata.jsに追加されていること');
    assert.equal(added.source, 'auto');
    assert.equal(added.verified, false);
    assert.equal(added.name, '新イベント');

    // 過去日・他店は無変化
    const past = parsed.arr.find((t) => t.id === 'past-1');
    assert.equal(past.name, '過去の大会');
    const other = parsed.arr.find((t) => t.id === 'other-1');
    assert.equal(other.name, '他店');

    function S_offset() {
      // cycleAnchor(2026-07-31) から found(2026-08-01) までのオフセット = +1
      return 1;
    }
  } finally {
    fs.unlinkSync(file);
  }
});

test('checkStore: --dry-run 相当(dryRun:true)ではdata.jsを一切書き換えない', async () => {
  const file = writeFixture();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const storeState = baseStoreState();
    const scraped = [{ date: '2026-08-10', start: '19:00', name: '新イベント', buyin: 1500 }];
    await monitor.checkStore('v40', storeState, '2026-08-01', {
      browserLib: makeMockBrowserLib(),
      oembedLib: noOpOembedLib,
      visionLib: makeMockVisionLib({ hasNewPost: true, tournaments: scraped }),
      dryRun: true,
      dataJsPath: file,
    });
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'dryRunではdata.jsを書き換えない');
  } finally {
    fs.unlinkSync(file);
  }
});

test('checkStore: Vision抽出が0件のときはdata.jsを書き換えずmiss扱いになる(誤検知安全側)', async () => {
  const file = writeFixture();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const storeState = baseStoreState();
    const { alert } = await monitor.checkStore('v40', storeState, '2026-07-29', {
      browserLib: makeMockBrowserLib(),
      oembedLib: noOpOembedLib,
      visionLib: makeMockVisionLib({ hasNewPost: true, tournaments: [] }),
      dryRun: false,
      dataJsPath: file,
    });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(alert, null);
  } finally {
    fs.unlinkSync(file);
  }
});

test('checkStore: プロフィール読み込み時のブロック検知はAuthWallErrorとしてそのまま投げる', async () => {
  const file = writeFixture();
  try {
    const storeState = baseStoreState();
    await assert.rejects(
      () =>
        monitor.checkStore('v40', storeState, '2026-07-29', {
          browserLib: makeMockBrowserLib({ authWallOnProfile: true }),
          oembedLib: noOpOembedLib,
          visionLib: makeMockVisionLib({ hasNewPost: false }),
          dryRun: false,
          dataJsPath: file,
        }),
      (e) => e.name === 'AuthWallError'
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('checkStore: 投稿ページ側でのブロック検知もAuthWallErrorとして投げる(data.jsは書き換わらない)', async () => {
  const file = writeFixture();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const storeState = baseStoreState();
    await assert.rejects(
      () =>
        monitor.checkStore('v40', storeState, '2026-07-29', {
          browserLib: makeMockBrowserLib({ authWallOnPost: true }),
          oembedLib: noOpOembedLib,
          visionLib: makeMockVisionLib({ hasNewPost: true }),
          dryRun: false,
          dataJsPath: file,
        }),
      (e) => e.name === 'AuthWallError'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'ブロック検知時はdata.jsを書き換えない');
  } finally {
    fs.unlinkSync(file);
  }
});
