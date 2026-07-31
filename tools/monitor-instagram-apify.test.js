'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const monitor = require('./monitor-instagram-apify');
const mergeLib = require('./tournament-merge');

// 監視対象は monitor-instagram-apify.js の STORES が唯一の正。ここに書き写さない。
// 【理由】以前は ['v40','v20','v18','v21','v34','v35'] と直書きしていたが、それだと
//   店を1つ足しただけで【機能は何も壊れていないのに】このテストが落ちる。
//   ここで見たいのは「どの6店か」ではなく「設定した全店の状態が前進すること」なので、
//   店リストは設定から引く(recurring-dedupe.test.js の冒頭コメントと同じ理由)。
const TARGET_VENUE_IDS = monitor.STORES.map((s) => s.venueId);

test('STORES: 監視対象の設定が空になっていない / 必要な項目が揃っている', () => {
  // 店リストを直書きしなくなったぶん、設定そのものの形はここで押さえる
  // (STORES が空になると、下の各テストが「0店ぶん確認して合格」になってしまうため)。
  assert.ok(monitor.STORES.length > 0, 'STORES が空');
  for (const s of monitor.STORES) {
    assert.ok(s.venueId && s.handle && s.label, `STORES の項目が欠けている: ${JSON.stringify(s)}`);
  }
  assert.equal(new Set(TARGET_VENUE_IDS).size, TARGET_VENUE_IDS.length, 'venueId が重複している');
});

// ---------- 新着検知ロジック(pickNewPosts) ----------

test('pickNewPosts: 記録済みの投稿日時より新しいものだけを、古い順に返す', () => {
  const posts = [
    { permalink: 'p2', postedAt: '2026-07-20T00:00:00.000Z' },
    { permalink: 'p1', postedAt: '2026-07-10T00:00:00.000Z' },
    { permalink: 'p3', postedAt: '2026-07-25T00:00:00.000Z' },
  ];
  const result = monitor.pickNewPosts(posts, '2026-07-15T00:00:00.000Z');
  assert.deepEqual(
    result.map((p) => p.permalink),
    ['p2', 'p3']
  );
});

test('pickNewPosts: 記録が無い(初回)場合は取得分をそのまま古い順で返す', () => {
  const posts = [
    { permalink: 'p2', postedAt: '2026-07-20T00:00:00.000Z' },
    { permalink: 'p1', postedAt: '2026-07-10T00:00:00.000Z' },
  ];
  const result = monitor.pickNewPosts(posts, null);
  assert.deepEqual(
    result.map((p) => p.permalink),
    ['p1', 'p2']
  );
});

test('pickNewPosts: 記録済みと完全に同時刻の投稿は「新着」に含めない(境界値)', () => {
  const posts = [{ permalink: 'p1', postedAt: '2026-07-15T00:00:00.000Z' }];
  const result = monitor.pickNewPosts(posts, '2026-07-15T00:00:00.000Z');
  assert.equal(result.length, 0);
});

test('pickNewPosts: postedAtが読み取れない投稿は無視する', () => {
  const posts = [
    { permalink: 'p1', postedAt: 'not-a-date' },
    { permalink: 'p2' },
    { permalink: 'p3', postedAt: '2026-07-20T00:00:00.000Z' },
  ];
  const result = monitor.pickNewPosts(posts, null);
  assert.deepEqual(
    result.map((p) => p.permalink),
    ['p3']
  );
});

test('looksLikeSchedulePost: キーワードを含む/含まないキャプションを判定する', () => {
  assert.equal(monitor.looksLikeSchedulePost('9月のスケジュールです🔥'), true);
  assert.equal(monitor.looksLikeSchedulePost('今日も盛り上がりました!ありがとうございました'), false);
  assert.equal(monitor.looksLikeSchedulePost(''), false);
  assert.equal(monitor.looksLikeSchedulePost(undefined), false);
});

// ---------- runMonitor(中核ロジック。依存注入・ファイルI/Oなし) ----------

function addDaysJst(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

test('runMonitor: 実データ(v40等)を使った統合テストで、新着スケジュール投稿だけを反映し他店舗・過去日は一切変化しない', async () => {
  const REAL_DATA_JS = path.join(__dirname, '..', 'data.js');
  const tmpDataJs = path.join(os.tmpdir(), `data-real-copy-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.copyFileSync(REAL_DATA_JS, tmpDataJs);
  try {
    const file = mergeLib.readDataJs(tmpDataJs);
    const before = file.arr;
    const today = monitor.todayJst();
    const futureDate = addDaysJst(today, 10);

    const fakeFetchLib = {
      async fetchInstagramPosts(handle) {
        if (handle === 'triple_orio') {
          return [
            {
              permalink: 'https://www.instagram.com/p/FAKE1/',
              imageUrl: 'https://example.com/fake.jpg',
              postedAt: '2026-07-20T10:00:00.000Z',
              caption: '9月のスケジュールです🔥',
            },
          ];
        }
        return [];
      },
    };
    const fakeVisionLib = {
      async extractTournaments() {
        return [{ date: futureDate, start: '19:00', name: 'Apify統合テスト大会', buyin: 3000, tags: [] }];
      },
    };
    const fakeDownloadImage = async () => Buffer.from('fake-image-bytes');

    const result = await monitor.runMonitor(
      { stores: monitor.STORES, before, today, state: {} },
      { fetchLib: fakeFetchLib, visionLib: fakeVisionLib, mergeLib, downloadImage: fakeDownloadImage }
    );

    assert.equal(result.changed, true);

    const added = result.arr.find((t) => t.venueId === 'v40' && t.name === 'Apify統合テスト大会');
    assert.ok(added, '新着投稿から抽出したトーナメントが追加されていること');
    // source: 'semi'を使う理由は本体側のコメント参照(1投稿1イベント形式の店舗があるため
    // 'auto'だと前回検知分が消える。回帰テストは下記「1投稿1イベント形式」のテストを参照)
    assert.equal(added.source, 'semi');
    assert.equal(added.verified, false);
    assert.equal(added.date, futureDate);
    assert.ok(added.id.startsWith('ig-v40-'));

    // v40以外の全店舗(対象6店舗のうちv40以外・対象外の一般店舗すべて)は1件も変化していない
    const others = (list) => list.filter((t) => t.venueId !== 'v40');
    assert.deepEqual(others(result.arr), others(before));

    // v40に元々あったエントリ(この時点で全件将来日だが)もすべてそのまま残っている
    const originalV40 = before.filter((t) => t.venueId === 'v40');
    for (const t of originalV40) {
      assert.ok(
        result.arr.some((x) => JSON.stringify(x) === JSON.stringify(t)),
        `既存エントリ ${t.id} が失われています`
      );
    }

    // 対象6店舗いずれの過去日エントリも一切変化していない
    const pastOf = (list) => list.filter((t) => TARGET_VENUE_IDS.includes(t.venueId) && t.date < today);
    assert.deepEqual(pastOf(result.arr), pastOf(before));

    // 状態ファイルはv40のみ更新され、投稿が無かった他店舗は増えない
    assert.equal(Object.keys(result.state).length, 1);
    assert.ok(result.state.v40);
    assert.equal(result.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
    assert.equal(result.state.v40.lastPermalink, 'https://www.instagram.com/p/FAKE1/');
  } finally {
    fs.unlinkSync(tmpDataJs);
  }
});

// 回帰テスト(2026-07-31): 品質管理部がPR #16で発見した致命的バグの再発防止。
// pokerbar_iris等は「1投稿1イベント」形式で運用されており、1回の取得結果が今後の全日程を
// 含むとは限らない。`source: 'auto'`のままだと、tools/tournament-merge.jsのmergeStoreが
// 「対象店舗のautoエントリは毎回全部作り直す(取得結果に無いものは消す)」規則を適用するため、
// 1回目のマージで追加した未来日エントリが、2回目のマージ(別投稿・別イベントの検知)で
// 消えてしまう。`source: 'semi'`に修正したことで、対応する(date,start)が無いものは残る規則が
// 適用され、この消失が起きないことを確認する。
test('runMonitor: 1投稿1イベント形式で2回連続の新着投稿があっても、1回目に追加した未来日エントリが2回目のマージ後も残っている(回帰テスト)', async () => {
  const store = monitor.STORES.find((s) => s.handle === 'pokerbar_iris');
  assert.ok(store, 'pokerbar_iris がSTORESに存在すること(テストの前提)');

  const today = '2026-07-31';
  const dateA = '2026-08-10';
  const dateB = '2026-08-17';

  // 1回目: イベントAのみを含む投稿を検知
  const fetchLibRun1 = {
    async fetchInstagramPosts(handle) {
      if (handle !== store.handle) return [];
      return [
        {
          permalink: 'https://www.instagram.com/p/EVENTA/',
          imageUrl: 'https://example.com/a.jpg',
          postedAt: '2026-07-25T10:00:00.000Z',
          caption: '8/10 スケジュールのお知らせ',
        },
      ];
    },
  };
  const visionLibRun1 = {
    async extractTournaments() {
      return [{ date: dateA, start: '19:00', name: 'イベントA', buyin: 3000, tags: [] }];
    },
  };

  const run1 = await monitor.runMonitor(
    { stores: [store], before: [], today, state: {} },
    { fetchLib: fetchLibRun1, visionLib: visionLibRun1, mergeLib, downloadImage: async () => Buffer.from('a') }
  );

  const addedA = run1.arr.find((t) => t.venueId === store.venueId && t.name === 'イベントA');
  assert.ok(addedA, '1回目でイベントAが追加されていること');
  assert.equal(addedA.source, 'semi');
  assert.equal(addedA.date, dateA);

  // 2回目: イベントAとは別の投稿でイベントBのみを検知(1投稿1イベント形式なのでイベントAは含まない)
  const fetchLibRun2 = {
    async fetchInstagramPosts(handle) {
      if (handle !== store.handle) return [];
      return [
        {
          permalink: 'https://www.instagram.com/p/EVENTB/',
          imageUrl: 'https://example.com/b.jpg',
          postedAt: '2026-07-28T10:00:00.000Z',
          caption: '8/17 日程決まりました!',
        },
      ];
    },
  };
  const visionLibRun2 = {
    async extractTournaments() {
      return [{ date: dateB, start: '19:00', name: 'イベントB', buyin: 3000, tags: [] }];
    },
  };

  const run2 = await monitor.runMonitor(
    { stores: [store], before: run1.arr, today, state: run1.state },
    { fetchLib: fetchLibRun2, visionLib: visionLibRun2, mergeLib, downloadImage: async () => Buffer.from('b') }
  );

  const stillA = run2.arr.find((t) => t.venueId === store.venueId && t.name === 'イベントA');
  const addedB = run2.arr.find((t) => t.venueId === store.venueId && t.name === 'イベントB');
  assert.ok(stillA, '2回目のマージ後も1回目に追加したイベントAが残っていること(本題の回帰確認)');
  assert.equal(stillA.date, dateA);
  assert.ok(addedB, '2回目でイベントBが追加されていること');
  assert.equal(addedB.date, dateB);
});

// ---------- 抽出時バリデーション(層2。2026-07-31追加 / Issue #18) ----------
// Vision(LLM)が返す日付は無検証では使えない。不正な行【だけ】を捨て、残りは取り込み、
// 確認済み投稿日時(state)は前進させる。ここで例外を投げると6店ぶんが丸ごと書き込まれず、
// 翌日も同じ投稿から再試行して同じ所で落ちる(=パイプラインが永久に止まる)ため。

/** 1店・1投稿ぶんのフェイク依存を作る(Visionの戻り値だけを差し替えられる) */
function fakeLibsFor(rows, { caption = '9月のスケジュールです', permalink = 'https://www.instagram.com/p/FAKE/' } = {}) {
  return {
    fetchLib: {
      async fetchInstagramPosts() {
        return [{ permalink, imageUrl: 'https://example.com/x.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption }];
      },
    },
    visionLib: { async extractTournaments() { return rows; } },
    mergeLib,
    downloadImage: async () => Buffer.from('x'),
  };
}

test('runMonitor: Visionが返した不正な日付の行だけを捨て、正しい行は取り込む(状態も前進する)', async () => {
  const rows = [
    { date: '2099-01-05', start: '19:00', name: '正しい大会1', buyin: 3000, tags: [] },
    { date: '2099-1-5', start: '19:00', name: 'ゼロ埋めなし', buyin: 3000, tags: [] },
    { date: '1/5', start: '19:00', name: '年が無い', buyin: 3000, tags: [] },
    { date: '2099-01-05T00:00:00Z', start: '19:00', name: 'ISO日時', buyin: 3000, tags: [] },
    { date: '2099-02-31', start: '19:00', name: '存在しない日', buyin: 3000, tags: [] },
    { date: '2099-01-06', start: '20:00', name: '正しい大会2', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );

  const names = result.arr.map((t) => t.name).sort();
  assert.deepEqual(names, ['正しい大会1', '正しい大会2'], '正しい行だけが取り込まれること');
  assert.equal(result.changed, true);

  const summary = result.summaries[0];
  assert.equal(summary.extractedCount, 2);
  assert.equal(summary.droppedCount, 4);
  // 捨てた行から「どの店・どの投稿・どんな値だったか」が分かること
  for (const d of summary.dropped) {
    assert.equal(d.venueId, 'v40');
    assert.equal(d.permalink, 'https://www.instagram.com/p/FAKE/');
    assert.ok(d.reason, '理由が入っていること');
  }
  assert.deepEqual(summary.dropped.map((d) => d.date), ['2099-1-5', '1/5', '2099-01-05T00:00:00Z', '2099-02-31']);
  assert.match(summary.dropped[3].reason, /存在しない日付/);

  // 一部を捨てても確認済み投稿日時は前進する(翌日また同じ投稿を拾い直さない)
  assert.equal(result.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
  // 一部でも取り込めていれば「投稿まるごと不採用」ではない
  assert.equal(result.anomalies.length, 0);
});

test('runMonitor: 日付以外(name欠落・オブジェクトでない)の不正行も捨てて理由を残す', async () => {
  const rows = [
    { date: '2099-01-05', start: '19:00', name: '正しい大会', buyin: 3000, tags: [] },
    { date: '2099-01-07', start: '19:00', name: '   ' },
    { date: '2099-01-08', start: '19:00' },
    null,
    'ただの文字列',
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );
  assert.equal(result.arr.length, 1);
  assert.equal(result.summaries[0].droppedCount, 4);
  assert.match(result.summaries[0].dropped[0].reason, /name が空/);
  assert.match(result.summaries[0].dropped[2].reason, /オブジェクトではない/);
});

test('runMonitor: 投稿から1行も採用できなければ異常(anomalies)として記録するが、例外は投げず状態は前進する', async () => {
  const rows = [
    { date: '9/5', start: '19:00', name: '全部不正1' },
    { date: '9/6', start: '19:00', name: '全部不正2' },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows, { permalink: 'https://www.instagram.com/p/ALLBAD/' })
  );

  assert.equal(result.changed, false, 'data.jsは書き換え対象にならない');
  assert.deepEqual(result.arr, []);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].store.venueId, 'v40');
  assert.equal(result.anomalies[0].permalink, 'https://www.instagram.com/p/ALLBAD/');
  assert.equal(result.anomalies[0].rowCount, 2);
  assert.match(result.anomalies[0].reasons.join(''), /YYYY-MM-DD/);
  // 異常でも状態は進める(進めないと翌日も同じ投稿で同じ結果になり、永久に前へ進まない)
  assert.equal(result.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
});

test('runMonitor: 1店で不正が出ても、残りの店の取込みは完了し、全店の状態が前進する', async () => {
  // 「6店のうち1店」と数で書かない。店が増減しても意味が変わらないよう、すべて STORES から引く。
  const BROKEN = 'pokerbar_iris';
  const brokenVenueId = monitor.STORES.find((s) => s.handle === BROKEN).venueId;   // 現在は v18
  const okVenueIds = TARGET_VENUE_IDS.filter((id) => id !== brokenVenueId);
  const fetchLib = {
    async fetchInstagramPosts(handle) {
      return [
        {
          permalink: `https://www.instagram.com/p/${handle}/`,
          imageUrl: `https://example.com/${handle}.jpg`,
          postedAt: '2026-07-20T10:00:00.000Z',
          caption: '9月のスケジュール',
        },
      ];
    },
  };
  // どの店の画像かはダウンロード結果のバイト列で見分ける(実際のVisionは画像しか受け取らないため)
  const downloadImage = async (url) => Buffer.from(url);
  const visionLib = {
    async extractTournaments(buffer) {
      const handle = String(buffer).replace('https://example.com/', '').replace('.jpg', '');
      if (handle === BROKEN) return [{ date: '2099-9-5', start: '19:00', name: '不正な日付の大会', buyin: 3000, tags: [] }];
      return [{ date: '2099-09-05', start: '19:00', name: `${handle}の大会`, buyin: 3000, tags: [] }];
    },
  };

  const result = await monitor.runMonitor(
    { stores: monitor.STORES, before: [], today: '2026-07-31', state: {} },
    { fetchLib, visionLib, mergeLib, downloadImage }
  );

  assert.equal(result.changed, true);
  assert.equal(result.arr.length, okVenueIds.length, '不正だった1店を除く全店ぶんが取り込まれていること');
  const importedVenues = result.arr.map((t) => t.venueId).sort();
  assert.deepEqual(importedVenues, okVenueIds.slice().sort());
  assert.equal(result.arr.some((t) => t.venueId === brokenVenueId), false);

  // 全店の確認済み投稿日時が進む(1店の不正で全店が翌日も同じ投稿を拾い直す状態にしない)
  assert.deepEqual(Object.keys(result.state).sort(), TARGET_VENUE_IDS.slice().sort());
  for (const id of TARGET_VENUE_IDS) {
    assert.equal(result.state[id].lastPostedAt, '2026-07-20T10:00:00.000Z');
  }

  // 異常は不正だった店の1投稿ぶんだけ
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].store.venueId, brokenVenueId);
  const brokenSummary = result.summaries.find((s) => s.store.venueId === brokenVenueId);
  assert.equal(brokenSummary.droppedCount, 1);
  assert.equal(brokenSummary.extractedCount, 0);
});

// 重複ID(2026-07-31 / 品質管理部の指摘)。Visionが同じ行を2回返す、あるいは start が
// 読み取れない同名・同日の2行(どちらも既定の '00:00' になる)は id が衝突する。
// 層2で捨てないと data.js の id が重複し、コミット前ゲートが落ちて state が進まず、
// 翌日も6店すべてが同じ投稿から再試行して同じ所で止まる(本PRが消しに来た失敗モードそのもの)。
test('runMonitor: Visionが同じ行を2回返しても、2件目をid重複として破棄する', async () => {
  const row = { date: '2099-09-12', start: '19:00', name: 'NLH Tournament', buyin: 3000, tags: [] };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} }, // v18
    fakeLibsFor([row, { ...row }])
  );

  assert.equal(result.arr.length, 1, '採用されるのは1件だけ');
  assert.equal(result.summaries[0].droppedCount, 1);
  assert.match(result.summaries[0].dropped[0].reason, /同じidの行が重複/);
  // id が重複していない = コミット前ゲート(層1)が通る状態
  const ids = result.arr.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  // 一部は取り込めているので「投稿まるごと不採用」ではない
  assert.equal(result.anomalies.length, 0);
});

test('runMonitor: startが読めない同日・同名の2行(どちらも00:00になる)もid重複として破棄する', async () => {
  const rows = [
    { date: '2099-09-12', name: 'マンデートナメ', buyin: 3000, tags: [] },
    { date: '2099-09-12', name: 'マンデートナメ', buyin: 5000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );
  assert.equal(result.arr.length, 1);
  assert.equal(result.arr[0].start, '00:00');
  assert.match(result.summaries[0].dropped[0].reason, /同じidの行が重複/);
});

test('runMonitor: 既存data.jsに同じidで別日時のエントリがあれば衝突として破棄する', async () => {
  // 人が admin.html で日時だけ直した等で、id と (date,start) がズレている既存エントリ。
  // mergeStore はスロット一致でしか置き換えないので、放置すると両方残って id が重複する。
  const existing = {
    id: 'ig-v18-2099-09-12-1900-nlh-tournament',
    venueId: 'v18',
    name: 'NLH Tournament',
    date: '2099-09-13',
    start: '20:00',
    buyin: 3000,
    addon: null,
    stack: 0,
    guarantee: null,
    reentry: false,
    prize: null,
    tags: [],
    source: 'semi',
    verified: false,
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [existing], today: '2026-07-31', state: {} },
    fakeLibsFor([{ date: '2099-09-12', start: '19:00', name: 'NLH Tournament', buyin: 3000, tags: [] }])
  );
  assert.equal(result.changed, false);
  assert.deepEqual(result.arr, [existing]);
  assert.match(result.summaries[0].dropped[0].reason, /既存エントリと id が衝突/);
  assert.equal(result.summaries[0].dropped[0].kind, 'existing-slot-conflict');
  // 内容がどこにも入らないままなので、これは本物の異常(再投稿とは別物)
  assert.equal(result.anomalies.length, 1, '1行も採用できていないので異常として記録される');
});

// ---------- 再投稿の偽警告(2026-07-31 / PR #19のフォローアップ) ----------
// 店が同じ画像を再投稿すると、2件目の投稿は全行がid重複で破棄され「採用0件」になる。
// だが内容は1件目で取り込めており【何も失われていない】。これを ::error:: にすると、
// 初回実行という一度きりのrunで唯一の警告チャネルが空振りで埋まり、本物の異常が読めなくなる。

/** 同一店の複数投稿(古い順)ぶんのフェイク依存を作る。Visionの戻り値は投稿ごとに指定する */
function fakeLibsForPosts(posts) {
  return {
    fetchLib: {
      async fetchInstagramPosts() {
        return posts.map((p, i) => ({
          permalink: p.permalink,
          imageUrl: `https://example.com/${i}.jpg`,
          postedAt: p.postedAt,
          caption: 'スケジュールのお知らせ',
        }));
      },
    },
    visionLib: {
      async extractTournaments(buffer) {
        const i = Number(String(buffer).replace('https://example.com/', '').replace('.jpg', ''));
        return posts[i].rows;
      },
    },
    mergeLib,
    downloadImage: async (url) => Buffer.from(url),
  };
}

test('runMonitor: 店が同じ画像を再投稿しても異常(::error::)にはせず、ログには「取込み済み」として残す', async () => {
  const rows = [
    { date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '20:00', name: 'チューズデー', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForPosts([
      { permalink: 'https://www.instagram.com/p/FIRST/', postedAt: '2026-07-20T10:00:00.000Z', rows },
      // 同じ画像の再投稿(よくある)。抽出結果も当然同じになる
      { permalink: 'https://www.instagram.com/p/REPOST/', postedAt: '2026-07-21T10:00:00.000Z', rows: rows.map((r) => ({ ...r })) },
    ])
  );

  assert.equal(result.arr.length, 2, '1件目の投稿ぶんが取り込まれていること');
  assert.equal(result.anomalies.length, 0, '再投稿は異常ではない(何も失われていない)');
  const summary = result.summaries[0];
  assert.equal(summary.repostedPostCount, 1);
  assert.equal(summary.unusablePostCount, 0);
  // 捨てた事実自体はログ用の記録に残る(「既に取込み済み」と分かる形で)
  assert.equal(summary.droppedCount, 2);
  for (const d of summary.dropped) {
    assert.equal(d.kind, 'duplicate-in-run');
    assert.match(d.reason, /既に取込み済み/);
    assert.equal(d.permalink, 'https://www.instagram.com/p/REPOST/');
  }
  // 状態ファイルからも「破棄されたのは再投稿ぶんである」ことが読めること。
  // 【deepEqual のままにしてある】このオブジェクトはコミットされてgit履歴に残る記録なので、
  // 形を変えるときは意図的に気づけた方がよい(勝手にフィールドが増減しないことの固定)。
  assert.deepEqual(result.state.v18.lastExtraction, {
    checkedAt: '2026-07-31',
    posts: 2,
    kept: 2,
    dropped: 2,
    normalized: 0,
    unusablePosts: 0,
    reposts: 1,
    apifyRaw: 2,
    malformed: 0,
    invalidPostedAt: 0,
    alreadySeen: 0,
    newPosts: 2,
    filteredOut: 0,
    importedPosts: 1,
    visionFailed: 0,
    imageFailed: 0,
    emptyResult: 0,
    visionRows: 4,
    pastDated: 0,
    added: 2,
    updated: 0,
    unchanged: 0,
  });
  // 投稿レベル・行レベルの保存則がどちらも成り立っていること
  assert.ok(monitor.checkPostAccounting(summary).ok, `投稿の内訳が合わない: ${JSON.stringify(monitor.checkPostAccounting(summary))}`);
  assert.ok(monitor.checkRowAccounting(summary).ok, `行の内訳が合わない: ${JSON.stringify(monitor.checkRowAccounting(summary))}`);
});

test('runMonitor: 再投稿でも、id重複以外の理由が1件でも混じれば異常として報告する', async () => {
  const rows = [
    { date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '20:00', name: 'チューズデー', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForPosts([
      { permalink: 'https://www.instagram.com/p/FIRST/', postedAt: '2026-07-20T10:00:00.000Z', rows },
      {
        permalink: 'https://www.instagram.com/p/MIXED/',
        postedAt: '2026-07-21T10:00:00.000Z',
        // 1行は取込み済みの再掲だが、もう1行は日付が壊れていて【失われる】
        rows: [{ ...rows[0] }, { date: '2099-9-14', start: '19:00', name: '日付不正', buyin: 3000, tags: [] }],
      },
    ])
  );

  assert.equal(result.anomalies.length, 1, '本物の異常は従来どおり報告されること');
  assert.equal(result.anomalies[0].permalink, 'https://www.instagram.com/p/MIXED/');
  assert.equal(result.summaries[0].repostedPostCount, 0);
  assert.equal(result.summaries[0].unusablePostCount, 1);
});

test('runMonitor: 開始時刻が読み取れない形の行は破棄する(範囲外・書式違い)', async () => {
  const rows = [
    { date: '2099-09-12', start: '19:00', name: '正しい', buyin: 3000, tags: [] },
    { date: '2099-09-12', start: '7pm', name: '時刻が読めない', buyin: 3000, tags: [] },
    { date: '2099-09-12', start: '19:00\n<b>', name: '改行混入', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '25:00', name: '時が範囲外', buyin: 3000, tags: [] },
    { date: '2099-09-14', start: '19:70', name: '分が範囲外', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );
  assert.equal(result.arr.length, 1);
  assert.equal(result.summaries[0].droppedCount, 4);
  for (const reason of result.summaries[0].dropped.map((d) => d.reason)) {
    assert.match(reason, /開始時刻が HH:MM/);
  }
});

// ---------- 正規化(2026-07-31 / PR #19のフォローアップ) ----------
// lastPostedAt は採用件数に関係なく無条件で前進するので、捨てた行は「遅れる」のではなく
// 【自動経路から永久に失われる】。曖昧さゼロで直せる逸脱にまで破棄を使うのは過剰なので、
// 検査の前に正規化を通す。正規化しても不正なもの(範囲外の時刻など)は従来どおり破棄する。

test('runMonitor: 書式が揺れた開始時刻(ゼロ埋め漏れ・全角コロン・全角数字)は破棄せず正規化して取り込む(idと並び順も正規化後の値)', async () => {
  const rows = [
    { date: '2099-09-12', start: '9:00', name: 'モーニング', buyin: 3000, tags: [] },
    { date: '2099-09-12', start: '7:30', name: 'アーリーバード', buyin: 3000, tags: [] },
    { date: '2099-09-12', start: '19：00', name: 'ナイト', buyin: 3000, tags: [] },
    { date: '2099-09-12', start: '１２：００', name: 'ランチ', buyin: 3000, tags: [] },
    { date: '2099-09-12', start: '８:３０', name: 'ブレックファスト', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );

  assert.equal(result.arr.length, 5, '1件も破棄されないこと');
  assert.equal(result.summaries[0].droppedCount, 0);
  assert.equal(result.summaries[0].normalizedCount, 5);

  const byName = Object.fromEntries(result.arr.map((t) => [t.name, t]));
  assert.equal(byName['モーニング'].start, '09:00');
  assert.equal(byName['アーリーバード'].start, '07:30');
  assert.equal(byName['ナイト'].start, '19:00');
  assert.equal(byName['ランチ'].start, '12:00', '全角数字+全角コロン');
  assert.equal(byName['ブレックファスト'].start, '08:30', '全角数字+半角コロン');

  // id は正規化後の start から組み立てられていること(`-900-` ではなく `-0900-`)
  assert.ok(byName['モーニング'].id.includes('-0900-'), byName['モーニング'].id);
  assert.ok(byName['アーリーバード'].id.includes('-0730-'), byName['アーリーバード'].id);
  assert.ok(byName['ナイト'].id.includes('-1900-'), byName['ナイト'].id);
  assert.ok(byName['ランチ'].id.includes('-1200-'), byName['ランチ'].id);
  // 全角数字がそのまま id に入っていないこと(id は半角の数字だけで組み立て直される)
  for (const t of result.arr) assert.match(t.id, /^ig-v18-2099-09-12-\d{4}-/, t.id);

  // 同日内は start の文字列比較で並ぶ。正規化前だと '19:00' < '7:30' < '9:00' となり順序が壊れる
  const sameDay = result.arr.filter((t) => t.date === '2099-09-12').map((t) => t.name);
  assert.deepEqual(
    sameDay,
    ['アーリーバード', 'ブレックファスト', 'モーニング', 'ランチ', 'ナイト'],
    '07:30 → 08:30 → 09:00 → 12:00 → 19:00 の順'
  );

  // 正規化前の値がログ用の記録に残ること(Visionの出力形式を人が測るため)
  const froms = result.summaries[0].normalized.flatMap((n) => n.notes.map((x) => x.from));
  assert.deepEqual(froms, ['9:00', '7:30', '19：00', '１２：００', '８:３０']);
});

test('runMonitor: 読み取れない金額は【その項目だけ】nullにして行は残す(価格1項目で大会を失わない)', async () => {
  const rows = [
    { date: '2099-09-13', start: '19:00', name: 'カンマ金額', buyin: '3,500', tags: [] },
    { date: '2099-09-14', start: '19:00', name: '円マーク付き', buyin: '5000円', stack: 20000, tags: [] },
    { date: '2099-09-15', start: '19:00', name: 'スタックにk', buyin: 3000, stack: '20k', tags: [] },
    { date: '2099-09-16', start: '19:00', name: '空文字のbuyin', buyin: '', tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );

  assert.equal(result.arr.length, 4, '金額が読めなくても大会そのものは残ること');
  assert.equal(result.summaries[0].droppedCount, 0);
  assert.equal(result.summaries[0].normalizedCount, 4);

  const byName = Object.fromEntries(result.arr.map((t) => [t.name, t]));
  assert.equal(byName['カンマ金額'].buyin, null);
  assert.equal(byName['円マーク付き'].buyin, null);
  assert.equal(byName['円マーク付き'].stack, 20000, '読めた項目はそのまま残ること');
  assert.equal(byName['スタックにk'].stack, null);
  assert.equal(byName['スタックにk'].buyin, 3000);
  // Number('') は 0 になり「不明」が「無料」に化ける。null であること(0ではない)
  assert.strictEqual(byName['空文字のbuyin'].buyin, null);

  // 破棄ではないが情報は落ちているので、正規化前の値がログ用の記録に残ること
  const notes = result.summaries[0].normalized.flatMap((n) => n.notes);
  assert.deepEqual(notes.map((n) => [n.field, n.from, n.to]), [
    ['buyin', '3,500', null],
    ['buyin', '5000円', null],
    ['stack', '20k', null],
    ['buyin', '', null],
  ]);
});

test('toTournament: 金額が読み取れなかった行の buyin/stack は 0 ではなく null(0は「無料」の意味になる)', () => {
  const t = monitor.toTournament({ date: '2099-09-12', start: '19:00', name: '金額不明' }, 'v18');
  assert.strictEqual(t.buyin, null);
  assert.strictEqual(t.stack, null);
  assert.strictEqual(t.addon, null);
  assert.strictEqual(t.guarantee, null);
});

test('formatNormalizedRow: 正規化前の値・正規化後の値・店・投稿が1行に出る', () => {
  const line = monitor.formatNormalizedRow(
    { venueId: 'v40', label: 'TripleBarrel 折尾店' },
    { permalink: 'https://www.instagram.com/p/ABC/', postedAt: '2026-07-20T10:00:00.000Z' },
    { date: '2026-09-05', name: 'マンデートナメ' },
    [
      { field: 'start', from: '9:00', to: '09:00', reason: '開始時刻をゼロ埋めの HH:MM にそろえた' },
      { field: 'buyin', from: '3,500', to: null, reason: '数値として読めないため、この項目だけ未設定(null)にした。行は取り込む' },
    ]
  );
  assert.match(line, /TripleBarrel 折尾店\(v40\)/);
  assert.match(line, /https:\/\/www\.instagram\.com\/p\/ABC\//);
  assert.match(line, /"9:00" → "09:00"/, '正規化前の値が残ること');
  assert.match(line, /"3,500" → null/);
  assert.match(line, /"マンデートナメ"/);
});

test('runMonitor: 抽出品質(採用/破棄/不採用投稿の件数)を状態ファイルに残す', async () => {
  const rows = [
    { date: '2099-09-12', start: '19:00', name: '正しい', buyin: 3000, tags: [] },
    { date: '2099-9-12', start: '19:00', name: '不正', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );
  assert.deepEqual(result.state.v40.lastExtraction, {
    checkedAt: '2026-07-31',
    posts: 1,
    kept: 1,
    dropped: 1,
    normalized: 0,
    unusablePosts: 0,
    reposts: 0,
    apifyRaw: 1,
    malformed: 0,
    invalidPostedAt: 0,
    alreadySeen: 0,
    newPosts: 1,
    filteredOut: 0,
    importedPosts: 1,
    visionFailed: 0,
    imageFailed: 0,
    emptyResult: 0,
    visionRows: 2,
    pastDated: 0,
    added: 1,
    updated: 0,
    unchanged: 0,
  });

  // Vision抽出を行わなかった回(スケジュール告知らしき投稿が無い)は前回値を持ち越す
  //(毎回変わる値を足して無意味な日次差分を増やさないため)
  const next = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: result.arr, today: '2026-08-01', state: result.state },
    fakeLibsFor([], { caption: '今日もありがとうございました', permalink: 'https://www.instagram.com/p/NEXT/' })
  );
  assert.deepEqual(next.state.v40.lastExtraction, result.state.v40.lastExtraction);
  assert.equal(next.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
});

test('formatDroppedRow: 店・投稿・実際の値・理由がすべて1行に出る', () => {
  const line = monitor.formatDroppedRow(
    { venueId: 'v40', label: 'TripleBarrel 折尾店' },
    { permalink: 'https://www.instagram.com/p/ABC/', postedAt: '2026-07-20T10:00:00.000Z' },
    { date: '2026-9-5', name: 'マンデートナメ' },
    '日付が YYYY-MM-DD(ゼロ埋め)ではない'
  );
  assert.match(line, /TripleBarrel 折尾店/);
  assert.match(line, /v40/);
  assert.match(line, /https:\/\/www\.instagram\.com\/p\/ABC\//);
  assert.match(line, /2026-07-20T10:00:00\.000Z/);
  assert.match(line, /"2026-9-5"/);
  assert.match(line, /"マンデートナメ"/);
  assert.match(line, /YYYY-MM-DD/);
});

test('runMonitor: 新着はあるがスケジュール告知らしくない投稿はVision抽出せず、data.jsは変化しない(状態のみ進む)', async () => {
  const before = [
    { id: 'v40-existing', venueId: 'v40', name: '既存', date: '2099-01-01', start: '19:00', buyin: 0, addon: null, stack: 0, guarantee: null, reentry: false, prize: null, tags: [], source: 'semi', verified: false },
  ];
  const fakeFetchLib = {
    async fetchInstagramPosts() {
      return [
        {
          permalink: 'https://www.instagram.com/p/NOSCHED/',
          imageUrl: 'https://example.com/x.jpg',
          postedAt: '2026-07-20T10:00:00.000Z',
          caption: '今日も盛り上がりました!ありがとうございました🙏',
        },
      ];
    },
  };
  let visionCalled = false;
  const fakeVisionLib = {
    async extractTournaments() {
      visionCalled = true;
      return [];
    },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before, today: '2026-07-31', state: {} },
    { fetchLib: fakeFetchLib, visionLib: fakeVisionLib, mergeLib, downloadImage: async () => Buffer.from('x') }
  );
  assert.equal(visionCalled, false, 'スケジュール告知らしくない投稿はVisionに渡さない');
  assert.equal(result.changed, false);
  assert.deepEqual(result.arr, before);
  // 状態は「確認済み」まで進む(同じ投稿を毎回新着扱いし続けないため)
  assert.equal(result.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
});

test('runMonitor: Apify呼び出しが失敗した店舗があると例外を投げる(呼び出し側はdata.jsを書き換えない設計)', async () => {
  const before = [
    { id: 'v40-existing', venueId: 'v40', name: '既存', date: '2099-01-01', start: '19:00', buyin: 0, addon: null, stack: 0, guarantee: null, reentry: false, prize: null, tags: [], source: 'semi', verified: false },
  ];
  const fakeFetchLib = {
    async fetchInstagramPosts() {
      throw new Error('Apify呼び出しに失敗: HTTP 500');
    },
  };
  await assert.rejects(
    () =>
      monitor.runMonitor(
        { stores: [monitor.STORES[0]], before, today: '2026-07-31', state: {} },
        { fetchLib: fakeFetchLib, visionLib: {}, mergeLib, downloadImage: async () => Buffer.from('x') }
      ),
    /Apify呼び出しに失敗/
  );
});

// ---------- CLIとして(子プロセスで)実行する結合テスト ----------

const TOOLS_DIR = __dirname;

function makeTempRepoRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-instagram-apify-cli-'));
  fs.mkdirSync(path.join(root, 'tools'));
  for (const f of ['monitor-instagram-apify.js', 'tournament-merge.js', 'venue-schedule-vision.js', 'validate-data.js']) {
    fs.copyFileSync(path.join(TOOLS_DIR, f), path.join(root, 'tools', f));
  }
  const tournaments = [
    { id: 'other-1', venueId: 'v99', name: '対象外店舗(触ってはいけない)', date: '2099-01-01', start: '19:00', buyin: 0, addon: null, stack: 0, guarantee: null, reentry: false, prize: null, tags: [], source: 'manual', verified: true },
  ];
  fs.writeFileSync(
    path.join(root, 'data.js'),
    `const VENUES = [];\nconst TOURNAMENTS = ${JSON.stringify(tournaments, null, 2)};\nconst AREAS = [];\n` +
      'if (typeof module !== "undefined") { module.exports = { VENUES, TOURNAMENTS, AREAS }; }\n'
  );
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), '{}\n');
  return root;
}

function runCli(root, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return execFileSync('node', ['tools/monitor-instagram-apify.js'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('CLI: APIFY_API_TOKEN未設定ならApify呼び出し前(ネットワークアクセス無し)に安全終了し、data.js/状態ファイルを書き換えない', () => {
  const root = makeTempRepoRoot();
  try {
    const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    const beforeState = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
    const env = { ...process.env };
    delete env.APIFY_API_TOKEN;
    assert.throws(() => runCli(root, env));
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData);
    assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), beforeState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: Apify呼び出し自体が失敗したら異常終了し、data.js/状態ファイルを書き換えない', () => {
  const root = makeTempRepoRoot();
  // fetch-venue-posts-apify.js を「常に失敗するフェイク」に差し替える
  // (実際のApifyへのネットワーク呼び出しはモックし、失敗時の安全弁だけを検証する)
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    'exports.fetchInstagramPosts = async () => { throw new Error("模擬的なApify障害(テスト用)"); };\n'
  );
  try {
    const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    const beforeState = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
    assert.throws(() => runCli(root, { APIFY_API_TOKEN: 'dummy-token-for-test' }));
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData);
    assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), beforeState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: 1店で不正な日付が返っても、正常終了して他店ぶんを取り込み、状態ファイルは全店ぶん前進する', () => {
  const root = makeTempRepoRoot();
  // v40(triple_orio) = 正しい行 + 不正な行、v18(pokerbar_iris) = 不正な行のみ、他4店は投稿なし
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
      if (handle === 'triple_orio' || handle === 'pokerbar_iris') {
        return [{ permalink: 'https://www.instagram.com/p/' + handle + '/', imageUrl: 'https://example.com/' + handle + '.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'スケジュールのお知らせ' }];
      }
      return [];
    };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.extractTournaments = async (buf) => {
      if (String(buf).includes('pokerbar_iris')) {
        return [{ date: '2099-2-3', start: '19:00', name: 'IRIS不正日付', buyin: 1000, tags: [] }];
      }
      return [
        { date: '2099-01-01', start: '19:00', name: '取り込まれる大会', buyin: 1000, tags: [] },
        { date: '9/5', start: '20:00', name: '捨てられる大会', buyin: 1000, tags: [] },
      ];
    };\n`
  );
  // 画像ダウンロードは実ネットワークに出さない(どの店かはURLで判別できるようにする)
  const globalFetchStub =
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n';
  fs.writeFileSync(path.join(root, 'stub-fetch.js'), globalFetchStub);

  try {
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy-token-for-test' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `正常終了すること(stderr: ${r.stderr})`);

    // 正しい行だけが data.js に入っている
    const dataJs = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.match(dataJs, /取り込まれる大会/);
    assert.equal(/捨てられる大会/.test(dataJs), false);
    assert.equal(/IRIS不正日付/.test(dataJs), false);
    assert.equal(/"9\/5"/.test(dataJs), false);
    assert.equal(/2099-2-3/.test(dataJs), false);

    // 状態ファイルは投稿があった2店ぶんとも前進している(不正が出た v18 も含む)
    const state = JSON.parse(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'));
    assert.equal(state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
    assert.equal(state.v18.lastPostedAt, '2026-07-20T10:00:00.000Z');

    // 捨てた行のログから 店 / 投稿 / 値 / 理由 が特定できる
    assert.match(r.stderr, /抽出結果を1件破棄しました/);
    assert.match(r.stderr, /TripleBarrel 折尾店\(v40\)/);
    assert.match(r.stderr, /https:\/\/www\.instagram\.com\/p\/triple_orio\//);
    assert.match(r.stderr, /"9\/5"/);
    assert.match(r.stderr, /"捨てられる大会"/);
    // 1行も採用できなかった投稿(v18)は異常として目立たせる。ただしジョブは落とさない。
    // ワークフローコマンド(::error::)は【stdout】に出すこと。GitHubの仕様は
    // "sent to the runner over stdout" で、stderrで注記として認識される保証が無い。
    assert.match(r.stdout, /::error title=/);
    assert.equal(/::error title=/.test(r.stderr), false, '注記をstderrに出すと注記として扱われない');
    assert.match(r.stdout, /投稿まるごと不採用: 店=Poker Bar IRIS\(v18\)/);
    assert.match(r.stdout, /再試行されません/);

    // 書き込んだ data.js はコミット前ゲート(層1)も通る形になっている
    const validate = spawnSync('node', [path.join(TOOLS_DIR, 'validate-data.js'), root], { encoding: 'utf8' });
    // 件数の下限(500件)には満たないテスト用データなので、そこだけは別途除外して日付検査を見る
    assert.equal(/日付が YYYY-MM-DD/.test(validate.stderr), false, validate.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 実運用に一番近い形(CLIとして、実際に data.js を書いて層1ゲートにかける)での確認。
// 「Visionが実際に返しがちな逸脱」を注入し、行が失われないこと・値が正規化されること・
// 再投稿で ::error:: が上がらないことを、まとめて1本で見る。
test('CLI: 逸脱した値(9:00 / 7:30 / 19:00全角 / 3,500 / 5000円)を含む応答でも行を捨てず、再投稿では::error::を出さない', () => {
  const root = makeTempRepoRoot();
  // v40 = 逸脱を含む投稿 → その直後に【同じ内容の再投稿】、v18 = 範囲外の時刻(破棄されるべき)
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
      if (handle === 'triple_orio') {
        return [
          { permalink: 'https://www.instagram.com/p/FIRST/', imageUrl: 'https://example.com/first.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'スケジュールのお知らせ' },
          { permalink: 'https://www.instagram.com/p/REPOST/', imageUrl: 'https://example.com/repost.jpg', postedAt: '2026-07-21T10:00:00.000Z', caption: 'スケジュールのお知らせ(再掲)' },
        ];
      }
      if (handle === 'pokerbar_iris') {
        return [{ permalink: 'https://www.instagram.com/p/BADTIME/', imageUrl: 'https://example.com/badtime.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'スケジュールのお知らせ' }];
      }
      return [];
    };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.extractTournaments = async (buf) => {
      if (String(buf).includes('badtime')) {
        return [
          { date: '2099-01-05', start: '25:00', name: '時が範囲外', buyin: 1000, tags: [] },
          { date: '2099-01-05', start: '19:70', name: '分が範囲外', buyin: 1000, tags: [] },
        ];
      }
      // FIRST と REPOST は同じ画像なので同じ抽出結果になる
      return [
        { date: '2099-01-05', start: '9:00', name: 'Morning', buyin: '3,500', tags: [] },
        { date: '2099-01-05', start: '7:30', name: 'EarlyBird', buyin: '5000円', tags: [] },
        { date: '2099-01-05', start: '19：00', name: 'Night', buyin: 3000, tags: [] },
        { date: '2099-01-05', start: '１２：００', name: 'Lunch', buyin: 3000, tags: [] },
      ];
    };\n`
  );
  const globalFetchStub =
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n';
  fs.writeFileSync(path.join(root, 'stub-fetch.js'), globalFetchStub);

  try {
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy-token-for-test' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `正常終了すること(stderr: ${r.stderr})`);

    const { arr } = mergeLib.readDataJs(path.join(root, 'data.js'));
    const imported = arr.filter((t) => t.venueId === 'v40');
    assert.equal(imported.length, 4, '逸脱した値を含む4行がすべて取り込まれていること');

    const byName = Object.fromEntries(imported.map((t) => [t.name, t]));
    assert.equal(byName['Morning'].start, '09:00');
    assert.equal(byName['EarlyBird'].start, '07:30');
    assert.equal(byName['Night'].start, '19:00');
    assert.equal(byName['Lunch'].start, '12:00', '全角数字も正規化されること');
    assert.ok(byName['Morning'].id.includes('-0900-'), byName['Morning'].id);
    assert.ok(byName['Lunch'].id.includes('-1200-'), byName['Lunch'].id);
    // 読めなかった金額は【その項目だけ】null。0(=無料)にしない
    assert.strictEqual(byName['Morning'].buyin, null);
    assert.strictEqual(byName['EarlyBird'].buyin, null);
    assert.equal(byName['Night'].buyin, 3000);
    // data.js 上の並びも正規化後の start 順(同日内)
    assert.deepEqual(imported.map((t) => t.name), ['EarlyBird', 'Morning', 'Lunch', 'Night']);

    // 範囲外の時刻は従来どおり破棄される
    assert.equal(arr.some((t) => t.venueId === 'v18'), false);

    // 正規化は【正規化前の値ごと】ログに残る
    assert.match(r.stderr, /抽出結果を正規化しました/);
    assert.match(r.stderr, /"9:00" → "09:00"/);
    assert.match(r.stderr, /"１２：００" → "12:00"/);
    assert.match(r.stderr, /"3,500" → null/);
    assert.match(r.stderr, /"5000円" → null/);

    // 再投稿は異常ではない。ログには「取込み済み」と分かる形で残る
    assert.match(r.stdout, /再投稿と判断しました/);
    assert.match(r.stdout, /https:\/\/www\.instagram\.com\/p\/REPOST\//);
    assert.match(r.stderr, /既に取込み済み/);

    // 本物の異常(範囲外の時刻で1行も採用できなかった v18)だけが ::error:: として上がる
    assert.match(r.stdout, /::error title=/);
    assert.equal((r.stdout.match(/::error title=/g) || []).length, 1);
    assert.match(r.stdout, /投稿まるごと不採用: 店=Poker Bar IRIS\(v18\)/);
    assert.equal(/投稿まるごと不採用: 店=TripleBarrel/.test(r.stdout), false, '再投稿を不採用として報告しないこと');

    // 状態ファイルから「破棄されたのは再投稿ぶん」であることが読める
    const state = JSON.parse(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'));
    assert.equal(state.v40.lastExtraction.reposts, 1);
    assert.equal(state.v40.lastExtraction.unusablePosts, 0);
    // 正規化は「行」単位で数える(破棄した抽出行と同じ単位)。4行 × 2投稿(再投稿ぶんを含む)
    assert.equal(state.v40.lastExtraction.normalized, 8);
    assert.equal(state.v18.lastExtraction.unusablePosts, 1);

    // 書き込んだ data.js はコミット前ゲート(層1)も通る形(件数の下限だけは別途除外)
    const validate = spawnSync('node', [path.join(TOOLS_DIR, 'validate-data.js'), root], { encoding: 'utf8' });
    assert.equal(/日付が YYYY-MM-DD/.test(validate.stderr), false, validate.stderr);
    assert.equal(/id が重複/.test(validate.stderr), false, validate.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --dry-run では新着があってもdata.js/状態ファイルを書き換えない', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
      if (handle === 'triple_orio') {
        return [{ permalink: 'https://www.instagram.com/p/X/', imageUrl: 'https://example.com/x.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'スケジュールのお知らせ' }];
      }
      return [];
    };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.extractTournaments = async () => ([{ date: '2099-01-01', start: '19:00', name: 'DRY RUNテスト', buyin: 1000, tags: [] }]);\n`
  );
  try {
    const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    const beforeState = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
    const out = execFileSync('node', ['tools/monitor-instagram-apify.js', '--dry-run'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy-token-for-test' },
      encoding: 'utf8',
    });
    assert.match(out, /--dry-run/);
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData);
    assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), beforeState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 投稿レベル・行レベルの保存則(「静かに失われる経路」の再発防止)
// ============================================================
// 【なぜ個別のカウンタではなく保存則なのか】
// 2026-07-31 の dry-run では、72投稿すべてがVision抽出に失敗しながら注記が1件も出ず、
// サマリは「1行も採用できなかった投稿 0件」と表示していた(=積極的な誤報)。
// 原因は「投稿の結末が6通りあるのに、3つがどのカウンタにも入っていなかった」こと。
// カウンタを足すだけでは7本目の結末が生まれたときに同じことが起きるので、
// 「すべての投稿・すべての行がちょうど1つのバケツに入る」ことを固定する。

/** 指定した振る舞いをする1店ぶんのlibsを作る。posts[i] に rows / throwOn を持たせる。 */
function fakeLibsForBehaviour(posts) {
  return {
    fetchLib: {
      async fetchInstagramPosts() {
        return posts.map((p, i) => ({
          permalink: p.permalink,
          imageUrl: `https://example.com/${i}.jpg`,
          postedAt: p.postedAt,
          caption: p.caption != null ? p.caption : 'スケジュールのお知らせ',
        }));
      },
    },
    visionLib: {
      async extractTournaments(buffer) {
        const i = Number(String(buffer).replace('https://example.com/', '').replace('.jpg', ''));
        if (posts[i].visionThrows) throw new Error(posts[i].visionThrows);
        return posts[i].rows || [];
      },
    },
    mergeLib,
    downloadImage: async (url) => {
      const i = Number(String(url).replace('https://example.com/', '').replace('.jpg', ''));
      if (posts[i].downloadThrows) throw new Error(posts[i].downloadThrows);
      return Buffer.from(url);
    },
  };
}

test('保存則(投稿): 6通りの結末が同時に起きても、すべての投稿がちょうど1つに数えられる', async () => {
  const ok = (d, n) => ({ date: d, start: '19:00', name: n, buyin: 3000, tags: [] });
  const dup = ok('2099-09-12', 'マンデートナメ');
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      // 1. 取り込めた
      { permalink: 'https://www.instagram.com/p/OK/', postedAt: '2026-07-20T10:00:00.000Z', rows: [dup] },
      // 2. 再投稿(全行が取込み済み)
      { permalink: 'https://www.instagram.com/p/REPOST/', postedAt: '2026-07-21T10:00:00.000Z', rows: [{ ...dup }] },
      // 3. 全行不採用(日付不正)
      {
        permalink: 'https://www.instagram.com/p/BAD/',
        postedAt: '2026-07-22T10:00:00.000Z',
        rows: [{ date: '2099-9-14', start: '19:00', name: '日付不正', buyin: 3000, tags: [] }],
      },
      // 4. Vision抽出失敗
      { permalink: 'https://www.instagram.com/p/VF/', postedAt: '2026-07-23T10:00:00.000Z', visionThrows: 'max_tokensで打ち切られました' },
      // 5. 画像ダウンロード失敗
      { permalink: 'https://www.instagram.com/p/IF/', postedAt: '2026-07-24T10:00:00.000Z', downloadThrows: 'HTTP 404' },
      // 6. Visionが0件
      { permalink: 'https://www.instagram.com/p/EMPTY/', postedAt: '2026-07-25T10:00:00.000Z', rows: [] },
    ])
  );

  const s = result.summaries[0];
  assert.equal(s.scheduleLikeCount, 6);
  assert.equal(s.importedPostCount, 1);
  assert.equal(s.repostedPostCount, 1);
  assert.equal(s.unusablePostCount, 1);
  assert.equal(s.visionFailedCount, 1);
  assert.equal(s.imageFailedCount, 1);
  assert.equal(s.emptyResultCount, 1);

  const acc = monitor.checkPostAccounting(s);
  assert.ok(acc.ok, `投稿の保存則が破れている: ${JSON.stringify(acc)}`);
  assert.equal(acc.missing, 0);
});

test('保存則(投稿): 【誤報の再現】全投稿がVision抽出に失敗しても「異常なし」に見えないこと', async () => {
  // 修正前は unusablePostCount=0 のまま ::error:: も出ず、まさにこの状態が「正常」に見えていた。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour(
      Array.from({ length: 5 }, (_, i) => ({
        permalink: `https://www.instagram.com/p/VF${i}/`,
        postedAt: `2026-07-2${i}T10:00:00.000Z`,
        visionThrows: 'Visionモデルの出力が max_tokens(32768)で打ち切られました。',
      }))
    )
  );
  const s = result.summaries[0];
  assert.equal(s.visionFailedCount, 5, '失敗した投稿が数えられていること');
  assert.equal(result.lostPosts.length, 5, '失われた投稿として報告対象に入っていること');
  assert.ok(monitor.checkPostAccounting(s).ok);
  // data.js は1件も増えていない = 5投稿ぶんの内容が丸ごと失われている
  assert.equal(result.arr.length, 0);
  // その事実が ::error:: として出ること
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportLostPosts(result.lostPosts);
  } finally {
    console.log = orig;
  }
  const annotation = lines.find((l) => l.startsWith('::error'));
  assert.ok(annotation, '::error:: 注記が出ていない(=誰も気づけない)');
  assert.match(annotation, /Vision抽出失敗 5件/);
  assert.match(annotation, /再試行されません/);
});

test('保存則(投稿): 画像ダウンロード失敗も ::error:: の対象になる', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/IF/', postedAt: '2026-07-20T10:00:00.000Z', downloadThrows: 'HTTP 403' },
    ])
  );
  assert.equal(result.summaries[0].imageFailedCount, 1);
  assert.equal(result.lostPosts.length, 1);
  assert.equal(result.lostPosts[0].kind, 'image-failed');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportLostPosts(result.lostPosts);
  } finally {
    console.log = orig;
  }
  assert.match(lines.find((l) => l.startsWith('::error')), /画像ダウンロード失敗 1件/);
  assert.ok(lines.some((l) => l.includes('HTTP 403')), '理由が読めること');
});

test('保存則(投稿): Visionが0件を返した投稿は ::warning::(赤ではない)で報告する', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/EMPTY/', postedAt: '2026-07-20T10:00:00.000Z', rows: [] },
    ])
  );
  assert.equal(result.summaries[0].emptyResultCount, 1);
  assert.equal(result.emptyResults.length, 1);
  assert.equal(result.lostPosts.length, 0, '0件は「確実に失われた」とは限らないので赤の対象にしない');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportEmptyResults(result.emptyResults);
  } finally {
    console.log = orig;
  }
  assert.ok(
    lines.some((l) => l.startsWith('::warning')),
    '::warning:: が出ること(誤検知で赤が埋まると本物の異常が読めなくなる)'
  );
  assert.ok(!lines.some((l) => l.startsWith('::error')), '0件を赤にしてはいけない');
});

test('保存則(行): 抽出 = 追加 + 更新 + 変更なし + 過去日 + 破棄 が成り立つ', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/MIX/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-09-12', start: '19:00', name: '未来の大会', buyin: 3000, tags: [] }, // 追加
          { date: '2020-01-01', start: '19:00', name: '過去の大会', buyin: 3000, tags: [] }, // 過去日
          { date: '2099-9-14', start: '19:00', name: '日付不正', buyin: 3000, tags: [] }, // 破棄
        ],
      },
    ])
  );
  const s = result.summaries[0];
  const row = monitor.checkRowAccounting(s);
  assert.equal(row.rows, 3, 'Visionが返した行の総数');
  assert.equal(row.added, 1);
  assert.equal(row.pastDated, 1, '過去日はマージ前に落ちるが、数えられていること');
  assert.equal(row.dropped, 1);
  assert.equal(row.residual, 0, `説明の付かない残余があってはいけない: ${JSON.stringify(row)}`);
  assert.ok(row.ok);
});

test('保存則(行): 全行が過去日で追加0でも、内訳から「正常に過去日だった」と読める', async () => {
  // 2026-07-31 の dry-run で「久留米: 抽出20 / 破棄0 / 追加0」が説明できなかったケース。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/PAST/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: Array.from({ length: 20 }, (_, i) => ({
          date: `2026-07-${String(i + 1).padStart(2, '0')}`,
          start: '19:00',
          name: `過去の大会${i}`,
          buyin: 3000,
          tags: [],
        })),
      },
    ])
  );
  const s = result.summaries[0];
  const row = monitor.checkRowAccounting(s);
  assert.equal(row.rows, 20);
  assert.equal(row.added, 0);
  assert.equal(row.dropped, 0);
  assert.equal(row.pastDated, 20, '「追加0」の理由が過去日であると数字で説明できること');
  assert.ok(row.ok);
  assert.equal(result.arr.length, 0);
});

test('保存則(行): 2回目の取込みは「更新」に入る(この経路では「変更なし」は出ない)', async () => {
  // 【dry-runの数字を読むときに必要な知識】この監視は取り込んだ行に source:'semi' を付ける
  // (PR #16の「auto → semi」変更)。一方 mergeStore が「変更なし」を出せるのは既存が
  // source:'auto' のときだけで、'semi' は【手入力扱い】になるため、同じ内容を再取込みしても
  // unchanged ではなく updated(かつ replacedManual)として数えられる。
  // つまりこのパイプラインでは "変更なし" は基本的に0のままになる。
  // 保存則(残余0)はどちらに数えられても成り立つので、ここで固定するのは残余0の方。
  const rows = [
    { date: '2099-09-12', start: '19:00', name: '大会A', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '19:00', name: '大会B', buyin: 3000, tags: [] },
  ];
  const first = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([{ permalink: 'https://www.instagram.com/p/A/', postedAt: '2026-07-20T10:00:00.000Z', rows }])
  );
  assert.equal(monitor.checkRowAccounting(first.summaries[0]).added, 2);

  // 同じ内容 + 1件だけ金額が変わったものを、別の投稿として再取込み
  const second = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: first.arr, today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/B/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: [{ ...rows[0] }, { ...rows[1], buyin: 5000 }],
      },
    ])
  );
  const row = monitor.checkRowAccounting(second.summaries[0]);
  assert.equal(row.rows, 2);
  assert.equal(row.added, 0, '既存と同じスロットなので追加ではない');
  assert.equal(row.updated, 2, "source:'semi' は手入力扱いなので、同一内容の行も「更新」に入る");
  assert.equal(row.unchanged, 0, 'この経路では「変更なし」は出ない(上のコメント参照)');
  assert.equal(row.residual, 0, '数え方がどちらでも、残余は0でなければならない');
  assert.ok(row.ok);
  assert.equal(second.summaries[0].stats.replacedManual.length, 2, '既存2件が置き換え対象として数えられる');
});

// ============================================================
// キーワード判定で落ちた投稿(画像を1度も見ずに捨てる4本目の経路)
// ============================================================

test('キーワード不一致: 落とした投稿の件数とキャプションが分かる形で出る', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/EN/', postedAt: '2026-07-20T10:00:00.000Z', caption: 'AUGUST SCHEDULE', rows: [] },
      { permalink: 'https://www.instagram.com/p/JP/', postedAt: '2026-07-21T10:00:00.000Z', caption: '8月のスケジュールです', rows: [] },
    ])
  );
  const s = result.summaries[0];
  // 英語表記はキーワード(全て日本語)に1語も当たらないため対象外になる
  assert.equal(s.newPostCount, 2);
  assert.equal(s.scheduleLikeCount, 1);
  assert.equal(s.filteredOutCount, 1, '落とした件数が数えられていること');
  assert.equal(s.newPostCount, s.scheduleLikeCount + s.filteredOutCount);
});

test('formatFilteredOutPost: 店・投稿URL・キャプションの冒頭が1行に出る', () => {
  const line = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: 'TripleBarrel 折尾店' },
    {
      permalink: 'https://www.instagram.com/p/ABC/',
      postedAt: '2026-07-20T10:00:00.000Z',
      caption: 'AUGUST SCHEDULE\n本日も\t営業しております',
    }
  );
  assert.match(line, /TripleBarrel 折尾店/);
  assert.match(line, /v40/);
  assert.match(line, /https:\/\/www\.instagram\.com\/p\/ABC\//);
  assert.match(line, /AUGUST SCHEDULE/);
  assert.doesNotMatch(line, /\n/, '改行を潰してログが崩れないようにすること');
});

test('formatFilteredOutPost: 長いキャプションは切り詰め、空なら「(なし)」と出す', () => {
  const long = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: '店' },
    { permalink: 'p', postedAt: 't', caption: 'あ'.repeat(200) }
  );
  assert.match(long, /…/, '切り詰めたことが分かること');
  assert.ok(long.length < 200, `ログ1行が長すぎる: ${long.length}文字`);
  const none = monitor.formatFilteredOutPost({ venueId: 'v40', label: '店' }, { permalink: 'p', postedAt: 't' });
  assert.match(none, /\(なし\)/);
});

test('キーワード不一致: レビュー部が挙げた表記はすべて現状のキーワードから漏れる(実測の固定)', () => {
  // 【このテストは「漏れている」ことを固定するもの】キーワードを増やすかどうかは
  // 次のdry-runで実際のキャプションを見てから決める。想像で先回りしない。
  // ここが落ちたらキーワードを増やした証拠なので、そのとき期待値を更新すること。
  for (const caption of ['AUGUST SCHEDULE', '8月のトナメ表です', '8月分アップしました', '＼8月のイベント／', '🎰🃏', '']) {
    assert.equal(
      monitor.looksLikeSchedulePost(caption),
      false,
      `${JSON.stringify(caption)} がキーワードに当たるようになっている(期待値の更新が必要)`
    );
  }
  // 現状当たるもの(この判定自体が壊れていないことの確認)
  assert.equal(monitor.looksLikeSchedulePost('8月のスケジュールです'), true);
  assert.equal(monitor.looksLikeSchedulePost('今月の日程はこちら'), true);
});

// ============================================================
// 保存則の【検知側】が本当に働くか
// ============================================================
// 【なぜ別に要るか】上の保存則テストは「健全な入力に対して ok が true になること」しか
// 見ていない。それだと `ok: actual === expected` を `ok: true` に潰す変異が生き残り、
// 「7本目の経路が生まれたら落ちる」という主張の根拠が fixture 頼みになる。
// 壊れた入力に対して【偽になること】と、その結果【::error:: が実際に出ること】を固定する。

test('検知(投稿): 内訳の合計が対象数に足りなければ ok=false になり、不足分を報告する', () => {
  const broken = {
    scheduleLikeCount: 6,
    importedPostCount: 1,
    repostedPostCount: 1,
    unusablePostCount: 1,
    visionFailedCount: 0, // ← 本来1件あるべきものが数えられていない
    imageFailedCount: 0, // ← 同上
    emptyResultCount: 1,
  };
  const acc = monitor.checkPostAccounting(broken);
  assert.equal(acc.ok, false, '合計が合わないのに ok=true になっている(検査が潰れている)');
  assert.equal(acc.expected, 6);
  assert.equal(acc.actual, 4);
  assert.equal(acc.missing, 2, '不足している件数が分かること');
});

test('検知(投稿): 内訳が多すぎる(二重計上)場合も ok=false になる', () => {
  const doubled = {
    scheduleLikeCount: 1,
    importedPostCount: 1,
    repostedPostCount: 1, // ← 同じ投稿を2つのバケツに入れてしまった
    unusablePostCount: 0,
    visionFailedCount: 0,
    imageFailedCount: 0,
    emptyResultCount: 0,
  };
  const acc = monitor.checkPostAccounting(doubled);
  assert.equal(acc.ok, false, '二重計上も検知すること');
  assert.equal(acc.missing, -1, '多すぎる場合は負の値になる');
});

test('検知(投稿): 健全な入力では ok=true(検知側が常に false を返す実装になっていないこと)', () => {
  const sound = {
    scheduleLikeCount: 3,
    importedPostCount: 1,
    repostedPostCount: 1,
    unusablePostCount: 1,
    visionFailedCount: 0,
    imageFailedCount: 0,
    emptyResultCount: 0,
  };
  assert.equal(monitor.checkPostAccounting(sound).ok, true);
  assert.equal(monitor.checkPostAccounting(sound).missing, 0);
});

test('検知(行): 行き先の合計が抽出行数に足りなければ ok=false になり、残余を報告する', () => {
  const broken = {
    visionRowCount: 10,
    droppedCount: 1,
    stats: { pastDated: 2, added: 3, updated: 0, unchanged: 0 }, // 合計6行ぶんしか説明できていない
  };
  const row = monitor.checkRowAccounting(broken);
  assert.equal(row.ok, false, '残余があるのに ok=true になっている(検査が潰れている)');
  assert.equal(row.residual, 4, '説明の付かない行数が分かること');
});

test('検知(行): stats が無い(マージしなかった)店でも、破棄だけで説明が付かなければ ok=false', () => {
  // Visionが行を返したのに1件も採用されず、破棄にも数えられていない = どこかで消えている
  const broken = { visionRowCount: 5, droppedCount: 0, stats: null };
  const row = monitor.checkRowAccounting(broken);
  assert.equal(row.ok, false);
  assert.equal(row.residual, 5);
  // 逆に、全行を破棄したのなら説明が付く
  assert.equal(monitor.checkRowAccounting({ visionRowCount: 5, droppedCount: 5, stats: null }).ok, true);
});

test('検知(行): pastDated が「残差」で定義されていたら通ってしまう構図の回帰テスト', () => {
  // 【C-1】以前 pastDated は `scraped.length - rawFuture.length`(=rawFutureに入らなかった全て)
  // だったため、保存則が恒等式になっていた。mergeStore の絞り込み条件が1つ増えて未来日の行が
  // 黙って消えても、その差分が pastDated に吸い込まれ「過去日」として誤報された。
  // 現在は「実際に date < today だった行数」を数えるので、消えた未来日の行は残余として表に出る。
  const today = '2026-07-31';
  const scraped = [
    { id: 'a', venueId: 'v40', date: '2099-09-12', start: '19:00', name: '未来A', source: 'auto', tags: [] },
    { id: 'b', venueId: 'v40', date: '2099-09-13', start: '19:00', name: '未来B(サテライト)', source: 'auto', tags: [] },
    { id: 'c', venueId: 'v40', date: '2020-01-01', start: '19:00', name: '過去', source: 'auto', tags: [] },
  ];
  const { stats } = mergeLib.mergeStore([], 'v40', scraped, today);
  assert.equal(stats.pastDated, 1, '過去日は実際に過去日だった1件だけであること');
  assert.equal(stats.added, 2);
  // 3行すべての行き先が説明できる
  const row = monitor.checkRowAccounting({ visionRowCount: 3, droppedCount: 0, stats });
  assert.equal(row.residual, 0);
  assert.ok(row.ok);
});

test('検知(行): date が壊れた行は「過去日」に化けず、残余として表に出る', () => {
  // `undefined < '2026-07-31'` は false なので pastDated には入らない。
  // rawFuture(date >= today)にも入らないので、どこにも数えられず残余になる = 表に出る。
  const scraped = [
    { id: 'a', venueId: 'v40', date: undefined, start: '19:00', name: '日付なし', source: 'auto', tags: [] },
  ];
  const { stats } = mergeLib.mergeStore([], 'v40', scraped, '2026-07-31');
  assert.equal(stats.pastDated, 0, '日付が無い行を「過去日」として数えてはいけない');
  const row = monitor.checkRowAccounting({ visionRowCount: 1, droppedCount: 0, stats });
  assert.equal(row.ok, false, '行き先不明として表に出ること');
  assert.equal(row.residual, 1);
});

// ---------- CLIレベル: 検知結果が実際に stdout の注記になるか ----------

/** tools/ を temp にコピーし、指定ファイルに変異を入れてから CLI を dry-run で回す。 */
function runCliWithMutation(mutate) {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [
         { permalink: 'https://www.instagram.com/p/A/', imageUrl: 'https://example.com/A.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' },
         { permalink: 'https://www.instagram.com/p/B/', imageUrl: 'https://example.com/B.jpg', postedAt: '2026-07-21T10:00:00.000Z', caption: '8月のスケジュール' },
       ];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.extractTournaments = async (buf) => {
       if (String(buf).includes('A.jpg')) return [{ date: '2099-09-12', start: '19:00', name: '未来', buyin: 3000, tags: [] }];
       return [{ date: '2020-01-01', start: '19:00', name: '過去', buyin: 3000, tags: [] }];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  mutate(root);
  const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', '--dry-run'], {
    cwd: root,
    env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return r;
}

test('CLI: 投稿がどのバケツにも入らなくなったら ::error::(投稿の集計が合わない)が stdout に出る', () => {
  const r = runCliWithMutation((root) => {
    // 「7本目の静かな経路」を注入する: 1行だけ返した投稿を黙ってスキップする
    const p = path.join(root, 'tools', 'monitor-instagram-apify.js');
    const src = fs.readFileSync(p, 'utf8');
    const mutated = src.replace('      let keptFromPost = 0;', '      if (rows.length === 1) continue;\n      let keptFromPost = 0;');
    assert.notEqual(mutated, src, '変異の当て先が見つからない(テストの前提が古い)');
    fs.writeFileSync(p, mutated);
  });
  assert.equal(r.status, 0, `ジョブは落とさない(注記で見せる): ${r.stderr}`);
  assert.match(
    r.stdout,
    /::error title=Instagram監視 - 投稿の集計が合わない::/,
    'どこにも数えられない投稿があるのに注記が出ていない'
  );
  assert.match(r.stdout, /件がどこにも数えられていません/);
});

test('CLI: 行の行き先が説明できなくなったら ::error::(行の集計が合わない)が stdout に出る', () => {
  const r = runCliWithMutation((root) => {
    // pastDated を数えないようにする(C-1 で直した「残差定義」に相当する壊れ方)
    const p = path.join(root, 'tools', 'tournament-merge.js');
    const src = fs.readFileSync(p, 'utf8');
    const mutated = src.replace('pastDated: scraped.filter((t) => t.date < today).length,', 'pastDated: 0,');
    assert.notEqual(mutated, src, '変異の当て先が見つからない(テストの前提が古い)');
    fs.writeFileSync(p, mutated);
  });
  assert.equal(r.status, 0);
  assert.match(
    r.stdout,
    /::error title=Instagram監視 - 行の集計が合わない::/,
    '説明の付かない行があるのに注記が出ていない'
  );
  assert.match(r.stdout, /行の行き先が説明できません/);
  assert.match(r.stdout, /← 残余 \d+行/, 'サマリ行にも残余が出ること');
});

test('CLI: 健全な実行では集計が合わない注記は出ない(誤検知しないこと)', () => {
  const r = runCliWithMutation(() => {});
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /集計が合わない/, '正常な実行で偽陽性が出てはいけない');
  assert.match(r.stdout, /残余なし/, '合計行に「残余なし」が出ること');
});

test('CLI: キーワード不一致の投稿はキャプション付きでログに出る(次のdry-runの計画がこれに依存する)', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [{ permalink: 'https://www.instagram.com/p/EN/', imageUrl: 'https://example.com/EN.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'AUGUST SCHEDULE 8/1-8/31' }];
     };\n`
  );
  fs.writeFileSync(path.join(root, 'tools', 'venue-schedule-vision.js'), 'exports.extractTournaments = async () => [];\n');
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', '--dry-run'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /キーワード不一致で対象外/, 'このログが無いと次のdry-runで何も測れない');
    assert.match(r.stdout, /AUGUST SCHEDULE/, 'キャプションの中身が読めること');
    assert.match(r.stdout, /https:\/\/www\.instagram\.com\/p\/EN\//, 'どの投稿かが分かること');
    assert.match(r.stdout, /キーワード不一致で対象外 1件/, '件数もサマリに出ること');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 取込みレベルの保存則(4本目より更に上流の5本目の経路)
// ============================================================
// Apifyの応答を正規化する段階(必須フィールド欠落)と、投稿日時で選別する段階で
// 捨てられた投稿は、キーワード不一致よりも更に見えにくい。保存則の左辺を
// 「Apifyが返した件数」まで遡らせて塞ぐ。

test('取込み: Apifyが返した件数から、形式不正・日時不正・既読・キーワード不一致・対象まで数が合う', async () => {
  const fetchLib = {
    async fetchInstagramPosts(handle, opts) {
      // Apifyは5件返したが、2件は必須フィールド欠落で正規化に失敗した、という状況
      if (opts && opts.stats) {
        opts.stats.rawCount = 5;
        opts.stats.malformed = 2;
      }
      return [
        { permalink: 'https://www.instagram.com/p/A/', imageUrl: 'https://example.com/A.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' },
        { permalink: 'https://www.instagram.com/p/B/', imageUrl: 'https://example.com/B.jpg', postedAt: '2026-07-21T10:00:00.000Z', caption: 'AUGUST SCHEDULE' },
        { permalink: 'https://www.instagram.com/p/C/', imageUrl: 'https://example.com/C.jpg', postedAt: 'これは日付ではない', caption: '8月のスケジュール' },
      ];
    },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    {
      fetchLib,
      visionLib: { async extractTournaments() { return [{ date: '2099-09-12', start: '19:00', name: '大会', buyin: 3000, tags: [] }]; } },
      mergeLib,
      downloadImage: async (url) => Buffer.from(url),
    }
  );
  const s = result.summaries[0];
  assert.equal(s.apifyRawCount, 5, 'Apifyが返した生の件数');
  assert.equal(s.malformedCount, 2, '必須フィールド欠落で捨てた件数');
  assert.equal(s.invalidPostedAtCount, 1, '投稿日時が読めず捨てた件数');
  assert.equal(s.alreadySeenCount, 0);
  assert.equal(s.newPostCount, 2);
  assert.equal(s.filteredOutCount, 1, 'AUGUST SCHEDULE はキーワードに当たらない');
  assert.equal(s.scheduleLikeCount, 1);

  const intake = monitor.checkIntakeAccounting(s);
  assert.ok(intake.ok, `取込みの保存則が破れている: ${JSON.stringify(intake)}`);
  assert.equal(intake.missing, 0);
});

test('取込み: 既読の投稿は「消失」ではなく「既読」として数えられる', async () => {
  const posts = [
    { permalink: 'https://www.instagram.com/p/OLD/', imageUrl: 'https://example.com/OLD.jpg', postedAt: '2026-07-10T10:00:00.000Z', caption: '8月のスケジュール' },
    { permalink: 'https://www.instagram.com/p/NEW/', imageUrl: 'https://example.com/NEW.jpg', postedAt: '2026-07-25T10:00:00.000Z', caption: '8月のスケジュール' },
  ];
  const result = await monitor.runMonitor(
    {
      stores: [monitor.STORES[0]],
      before: [],
      today: '2026-07-31',
      state: { v40: { handle: 'triple_orio', lastPostedAt: '2026-07-20T10:00:00.000Z' } },
    },
    {
      fetchLib: { async fetchInstagramPosts(h, opts) { if (opts && opts.stats) { opts.stats.rawCount = 2; opts.stats.malformed = 0; } return posts; } },
      visionLib: { async extractTournaments() { return [{ date: '2099-09-12', start: '19:00', name: '大会', buyin: 3000, tags: [] }]; } },
      mergeLib,
      downloadImage: async (url) => Buffer.from(url),
    }
  );
  const s = result.summaries[0];
  assert.equal(s.alreadySeenCount, 1, '既読は正常な結末として数えること');
  assert.equal(s.newPostCount, 1);
  assert.ok(monitor.checkIntakeAccounting(s).ok);
});

test('検知(取込み): 上流で投稿が消えたら ok=false になり、不足分を報告する', () => {
  const broken = {
    apifyRawCount: 10,
    malformedCount: 0,
    invalidPostedAtCount: 0,
    alreadySeenCount: 0,
    filteredOutCount: 1,
    scheduleLikeCount: 2, // 合計3件しか説明できていない
  };
  const intake = monitor.checkIntakeAccounting(broken);
  assert.equal(intake.ok, false);
  assert.equal(intake.missing, 7);
});

test('取込み: fetchLibが件数を教えない実装でも、誤って残余を出さない', async () => {
  // 既存のテストスタブのように opts.stats を埋めない実装。
  // 「1件も捨てていない」とみなして偽陽性を出さないことを固定する。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor([{ date: '2099-09-12', start: '19:00', name: '大会', buyin: 3000, tags: [] }])
  );
  const s = result.summaries[0];
  assert.equal(s.malformedCount, 0);
  assert.ok(monitor.checkIntakeAccounting(s).ok, '件数不明の実装で偽陽性を出してはいけない');
});

test('pickNewPostsWithStats: 落とした理由ごとに件数を返す', () => {
  const posts = [
    { permalink: 'a', postedAt: '2026-07-10T10:00:00.000Z' },
    { permalink: 'b', postedAt: '2026-07-25T10:00:00.000Z' },
    { permalink: 'c', postedAt: 'not-a-date' },
    { permalink: 'd' },
  ];
  const r = monitor.pickNewPostsWithStats(posts, '2026-07-20T10:00:00.000Z');
  assert.equal(r.posts.length, 1);
  assert.equal(r.invalidPostedAt, 2, '日時が読めない/無いもの');
  assert.equal(r.alreadySeen, 1, '確認済みより古いもの');
  // 従来のAPIも同じ結果を返し続けること
  assert.deepEqual(monitor.pickNewPosts(posts, '2026-07-20T10:00:00.000Z'), r.posts);
});

// ============================================================
// M-2: キーワード不一致で全部落ちた店でも lastExtraction を残す
// ============================================================

test('永続化: 新着はあるが対象0件(折尾のケース)でも lastExtraction が書かれる', async () => {
  // 【このカウンタが最も必要な場面】新着12件→対象0件。ここで書かれないと
  // 「日程を投稿していない」のか「キーワードに当たらず全部素通り」なのかが
  // git履歴のどこにも残らず、runログが消える90日後には何も分からなくなる。
  const posts = Array.from({ length: 3 }, (_, i) => ({
    permalink: `https://www.instagram.com/p/X${i}/`,
    imageUrl: `https://example.com/X${i}.jpg`,
    postedAt: `2026-07-2${i}T10:00:00.000Z`,
    caption: 'AUGUST SCHEDULE',
  }));
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    {
      fetchLib: { async fetchInstagramPosts(h, opts) { if (opts && opts.stats) { opts.stats.rawCount = 3; opts.stats.malformed = 0; } return posts; } },
      visionLib: { async extractTournaments() { throw new Error('呼ばれてはいけない'); } },
      mergeLib,
      downloadImage: async () => { throw new Error('呼ばれてはいけない'); },
    }
  );
  const le = result.state.v40.lastExtraction;
  assert.ok(le, '対象0件でも lastExtraction が書かれること');
  assert.equal(le.newPosts, 3);
  assert.equal(le.filteredOut, 3, 'キーワード不一致の件数がgit履歴に残ること');
  assert.equal(le.posts, 0, 'Vision抽出の対象は0件');
  assert.equal(le.apifyRaw, 3);
  // 状態も前進している(=この投稿は二度と処理されない)ことが同時に読める
  assert.equal(result.state.v40.lastPostedAt, '2026-07-22T10:00:00.000Z');
});

test('永続化: 新着そのものが0件の店は、従来どおり前回値を持ち越す(無意味な日次差分を作らない)', async () => {
  const prevState = {
    v40: {
      handle: 'triple_orio',
      lastPostedAt: '2026-07-20T10:00:00.000Z',
      lastExtraction: { checkedAt: '2026-07-30', posts: 1, kept: 1 },
    },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: prevState },
    {
      fetchLib: { async fetchInstagramPosts() { return []; } },
      visionLib: {},
      mergeLib,
      downloadImage: async () => Buffer.from(''),
    }
  );
  assert.deepEqual(result.state.v40.lastExtraction, prevState.v40.lastExtraction, '前回値がそのまま残ること');
});

test('CLI: 取込みの上流で投稿が消えたら ::error::(取得件数の集計が合わない)が stdout に出る', () => {
  // Apifyは5件返したと報告するのに2件しか渡ってこない = 上流で3件消えている状況。
  // コードを変異させず、fetchLib の報告と実際の配列を食い違わせるだけで再現できる。
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle, opts) => {
       if (handle !== 'triple_orio') { if (opts && opts.stats) { opts.stats.rawCount = 0; opts.stats.malformed = 0; } return []; }
       if (opts && opts.stats) { opts.stats.rawCount = 5; opts.stats.malformed = 0; } // ← 5件返したと報告
       return [
         { permalink: 'https://www.instagram.com/p/A/', imageUrl: 'https://example.com/A.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' },
         { permalink: 'https://www.instagram.com/p/B/', imageUrl: 'https://example.com/B.jpg', postedAt: '2026-07-21T10:00:00.000Z', caption: '8月のスケジュール' },
       ];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    "exports.extractTournaments = async () => [{ date: '2099-09-12', start: '19:00', name: '大会', buyin: 3000, tags: [] }];\n"
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', '--dry-run'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'ジョブは落とさない(注記で見せる)');
    assert.match(
      r.stdout,
      /::error title=Instagram監視 - 取得件数の集計が合わない::/,
      'Vision に届く前に投稿が消えているのに注記が出ていない'
    );
    assert.match(r.stdout, /Vision に届く前の段階で投稿が消えています/);
    assert.match(r.stdout, /← 残余 3件/, '合計行にも残余が出ること');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
