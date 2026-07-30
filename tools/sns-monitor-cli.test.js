'use strict';

/**
 * sns-monitor-instagram.js を実際にCLIとして(子プロセスで)実行する結合テスト。
 * ここで確認したいのは主に「シークレットが無い場合に安全に何もせず終了すること」
 * (品質管理部のテスト観点として明示されている要件)。
 * 実際のInstagram/Vision APIへのアクセスは行わない(そこまで到達する前に安全に止まる)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TOOLS_DIR = __dirname;
const FILES_TO_COPY = [
  'sns-monitor-instagram.js',
  'sns-schedule.js',
  'tournament-merge.js',
  'dashboard-report.js',
  'instagram-browser.js',
  'instagram-oembed.js',
  'instagram-vision.js',
];

function makeTempRepoRoot({ stateFixture, dataJsFixture }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-monitor-cli-'));
  fs.mkdirSync(path.join(root, 'tools'));
  for (const f of FILES_TO_COPY) {
    fs.copyFileSync(path.join(TOOLS_DIR, f), path.join(root, 'tools', f));
  }
  fs.writeFileSync(path.join(root, 'sns-monitor-state.json'), JSON.stringify(stateFixture, null, 2));
  fs.writeFileSync(path.join(root, 'data.js'), dataJsFixture);
  return root;
}

function stateFixtureWithOneStoreDueToday(todayIso) {
  return {
    _comment: 'test fixture',
    _pausedReason: null,
    v40: {
      handle: 'triple_orio',
      cadenceType: 'monthly',
      observedIntervals: [],
      lastFoundPostDate: null,
      lastFoundPostUrl: null,
      // 終端日 = 今日 なので必ずチェック対象(shouldCheckToday が確率1で true になる)
      nextCheckWindow: { start: todayIso, end: todayIso },
      missThresholdDate: todayIso,
      consecutiveMisses: 0,
      lastAttemptDate: null,
      missReportedForCycle: false,
    },
  };
}

function dataJsFixture() {
  return 'const VENUES = [];\nconst TOURNAMENTS = [];\n;\nconst AREAS = [];\n';
}

test('CLI: INSTAGRAM_SESSION_COOKIE 未設定なら何もせず正常終了する(state/data.js とも無変更)', () => {
  const today = '2026-08-01';
  const root = makeTempRepoRoot({
    stateFixture: stateFixtureWithOneStoreDueToday(today),
    dataJsFixture: dataJsFixture(),
  });
  try {
    const beforeState = fs.readFileSync(path.join(root, 'sns-monitor-state.json'), 'utf8');
    const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');

    const env = { ...process.env };
    delete env.INSTAGRAM_SESSION_COOKIE;
    delete env.ANTHROPIC_API_KEY;
    delete env.DASHBOARD_WRITE_TOKEN;
    env.SNS_MONITOR_FAKE_TODAY_JST = today;
    env.SNS_MONITOR_FAKE_HOUR_JST = '12';

    const out = execFileSync('node', ['tools/sns-monitor-instagram.js'], { cwd: root, env, encoding: 'utf8' });

    assert.match(out, /巡回対象: v40/, '本来はチェック対象になっているはず');
    assert.match(out, /INSTAGRAM_SESSION_COOKIE.*未設定/, '未設定である旨がログに出ること');

    assert.equal(fs.readFileSync(path.join(root, 'sns-monitor-state.json'), 'utf8'), beforeState, 'state は書き換わらない');
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData, 'data.js は書き換わらない');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --schedule-only はネットワークアクセス無しで対象店舗だけ表示して終了する', () => {
  const today = '2026-08-01';
  const root = makeTempRepoRoot({
    stateFixture: stateFixtureWithOneStoreDueToday(today),
    dataJsFixture: dataJsFixture(),
  });
  try {
    const env = {
      ...process.env,
      SNS_MONITOR_FAKE_TODAY_JST: today,
      SNS_MONITOR_FAKE_HOUR_JST: '12',
      // 万一 --schedule-only が正しく早期終了しない実装だった場合に、意図せず本物の
      // シークレットでネットワークへ出て行かないことも兼ねて明示的に外しておく
      INSTAGRAM_SESSION_COOKIE: '',
    };
    const out = execFileSync('node', ['tools/sns-monitor-instagram.js', '--schedule-only'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.match(out, /巡回対象: v40/);
    assert.match(out, /--schedule-only のためここで終了/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: _pausedReason が設定されていれば何もせず即終了する(ブロック検知後の一時停止)', () => {
  const today = '2026-08-01';
  const fixture = stateFixtureWithOneStoreDueToday(today);
  fixture._pausedReason = 'テスト: 2026-07-30T00:00:00.000Z v40: ログイン画面にリダイレクトされました';
  const root = makeTempRepoRoot({ stateFixture: fixture, dataJsFixture: dataJsFixture() });
  try {
    const beforeState = fs.readFileSync(path.join(root, 'sns-monitor-state.json'), 'utf8');
    const env = {
      ...process.env,
      SNS_MONITOR_FAKE_TODAY_JST: today,
      SNS_MONITOR_FAKE_HOUR_JST: '12',
      INSTAGRAM_SESSION_COOKIE: 'dummy-should-not-be-used',
    };
    const out = execFileSync('node', ['tools/sns-monitor-instagram.js'], { cwd: root, env, encoding: 'utf8' });
    assert.match(out, /一時停止中のため何もしません/);
    assert.equal(fs.readFileSync(path.join(root, 'sns-monitor-state.json'), 'utf8'), beforeState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
