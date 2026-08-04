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

test('runMonitor: startが読めない同日・同名の2行(どちらも start:"" になる)もid重複として破棄する', async () => {
  const rows = [
    { date: '2099-09-12', name: 'マンデートナメ', buyin: 3000, tags: [] },
    { date: '2099-09-12', name: 'マンデートナメ', buyin: 5000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );
  assert.equal(result.arr.length, 1);
  // 【'00:00' で埋めない】'00:00' は「深夜0時開始」という読み取れた値で、サイトはそう表示する。
  // 読み取れなかったことを表せるのは空文字(表示は「—」)。既存618件のうち184件が同じ表現。
  assert.equal(result.arr[0].start, '', "読み取れなかった開始時刻を '00:00' で埋めてはいけない");
  assert.match(result.arr[0].id, /-nostart-/, 'idの時刻部分は nostart(空だと区切りが読めない)');
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
  // 【2026-08-01変更】この kind は「人が admin.html で日時を訂正した」ときにしか発生しない
  // (id が日時から作られるため)。人の訂正は正しく守られているのに、その投稿が
  // Apifyの取得窓に残る限り毎日赤くなる = 確実な空振りの赤。異常から外した。
  assert.equal(result.anomalies.length, 0, '人の日時訂正による衝突は異常にしない(空振りの赤を作らない)');
  assert.equal(result.summaries[0].humanEditedPostCount, 1, '別のバケツとして数える');
  assert.equal(result.summaries[0].unusablePostCount, 0);
  assert.ok(monitor.checkPostAccounting(result.summaries[0]).ok, '保存則は保たれること');
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
    notATournamentPosts: 0,
    humanEditedPosts: 0,
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
    notATournamentPosts: 0,
    humanEditedPosts: 0,
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

test('★隔離: 1店の取得が失敗しても例外を投げず、その店だけスキップして他店は処理を続ける', async () => {
  // 2026-08-01 の dry-run #4 では1店目のタイムアウトで残り5店が取得すらされなかった。
  const before = [
    { id: 'v40-existing', venueId: 'v40', name: '既存', date: '2099-01-01', start: '19:00', buyin: 0, addon: null, stack: 0, guarantee: null, reentry: false, prize: null, tags: [], source: 'semi', verified: false },
  ];
  const fakeFetchLib = {
    async fetchInstagramPosts(handle) {
      if (handle === 'triple_orio') throw new Error('Apify呼び出しに失敗: HTTP 500');
      if (handle !== 'king2485queen') return [];
      return [
        { permalink: 'https://www.instagram.com/p/OK/', imageUrl: 'https://example.com/OK.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' },
      ];
    },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0], monitor.STORES[1]], before, today: '2026-07-31', state: {} },
    {
      fetchLib: fakeFetchLib,
      // 名前は固有名にすること(`大会` だけだと isHeadingRow が見出しとして正しく落とす)
      visionLib: { async extractTournaments() { return [{ date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] }]; } },
      mergeLib,
      downloadImage: async (url) => Buffer.from(url),
    }
  );
  // 失敗した店
  const failed = result.summaries.find((x) => x.store.venueId === 'v40');
  assert.equal(failed.fetchFailed, true);
  assert.match(failed.fetchError, /HTTP 500/);
  assert.equal(result.storeFailures.length, 1);
  assert.equal(result.storeFailures[0].store.venueId, 'v40');
  // 【最重要】失敗した店の確認済み投稿日時は前進しない = 次回やり直せる
  assert.equal(result.state.v40, undefined, '失敗した店の状態を作ってはいけない');
  // 成功した店は普通に処理される
  const ok = result.summaries.find((x) => x.store.venueId === 'v20');
  assert.equal(ok.fetchFailed, false);
  assert.equal(ok.importedPostCount, 1);
  assert.ok(result.state.v20.lastPostedAt, '成功した店の状態は前進する');
  assert.ok(result.arr.some((t) => t.venueId === 'v20'), '成功した店のデータは取り込まれる');
});

test('★隔離: 失敗した店の lastPostedAt は前回値のまま(取得失敗で投稿を失わない)', async () => {
  const prevState = {
    v40: { handle: 'triple_orio', lastPostedAt: '2026-07-01T00:00:00.000Z', lastPermalink: 'https://www.instagram.com/p/OLD/' },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: prevState },
    {
      fetchLib: { async fetchInstagramPosts() { throw new Error('The operation was aborted due to timeout'); } },
      visionLib: {},
      mergeLib,
      downloadImage: async () => Buffer.from('x'),
    }
  );
  assert.deepEqual(result.state.v40, prevState.v40, '前回値がそのまま残ること(1バイトも変えない)');
  assert.equal(result.changed, false, 'data.js も変えない');
});

test('★隔離: 店レベルの保存則 — 対象店 = 観測できた店 + 取得に失敗した店', () => {
  // 失敗した店は取込み・投稿・行のどの保存則からも「0件」で素通りする(何も観測していないので
  // 0=0 で成立する)。それ自体は正しいが、「取得失敗」と「新着0件」が同じ0に見えるのは
  // この案件が繰り返し潰してきた誤報の形。店の単位でも数えて必ず表に出す。
  const acc = monitor.checkStoreAccounting([{ fetchFailed: false }, { fetchFailed: true }, { fetchFailed: false }], 3);
  assert.equal(acc.ok, true);
  assert.equal(acc.expected, 3);
  assert.equal(acc.observed, 2);
  assert.equal(acc.failed, 1);
});

test('★隔離(検知側): 店の記録が抜けたら ok=false になる(恒等式になっていないこと)', () => {
  // 【R-1 と同じ罠】observed を `summaries.length - failed` で出すと
  // `observed + failed === summaries.length` は【常に成立】し、何も検査しない。
  // 比べる相手を【対象店舗の数】にすることで、summaries.push を忘れた店が残余として出る。
  const acc = monitor.checkStoreAccounting([{ fetchFailed: false }, { fetchFailed: true }], 6);
  assert.equal(acc.ok, false, '6店が対象なのに2店ぶんしか記録が無ければ偽になること');
  assert.equal(acc.missing, 4);
  // 全店ぶん揃っていれば真
  assert.equal(monitor.checkStoreAccounting([{ fetchFailed: false }, { fetchFailed: true }], 2).ok, true);
});

test('★隔離: 取得に失敗した店でも、他の3つの保存則は破れない(0件として整合する)', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    {
      fetchLib: { async fetchInstagramPosts() { throw new Error('timeout'); } },
      visionLib: {},
      mergeLib,
      downloadImage: async () => Buffer.from('x'),
    }
  );
  const s = result.summaries[0];
  assert.ok(monitor.checkIntakeAccounting(s).ok, '取込みの保存則は 0=0 で成立する');
  assert.ok(monitor.checkPostAccounting(s).ok);
  assert.ok(monitor.checkRowAccounting(s).ok);
  // だが「観測できていない」ことは店レベルで必ず記録されている
  assert.equal(monitor.checkStoreAccounting(result.summaries, 1).failed, 1);
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

test('formatFilteredOutPost: 店・投稿URL・投稿日時が1行に出る', () => {
  const line = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: 'TripleBarrel 折尾店' },
    {
      permalink: 'https://www.instagram.com/p/ABC/',
      postedAt: '2026-07-20T10:00:00.000Z',
      caption: 'AUGUST SCHEDULE 8/1〜 19:30スタート',
    }
  );
  assert.match(line, /TripleBarrel 折尾店/);
  assert.match(line, /v40/);
  assert.match(line, /https:\/\/www\.instagram\.com\/p\/ABC\//, '投稿を特定できること(本文の代わりにこれで確認する)');
  assert.match(line, /2026-07-20T10:00:00\.000Z/);
  assert.doesNotMatch(line, /\n/, '改行を潰してログが崩れないようにすること');
});

test('★formatFilteredOutPost: キャプション本文を1文字も出さない(公開ログのため)', () => {
  // 【この経路は収集が偏っている】ログに残るのは「キーワードに当たらなかった投稿」=
  // 日程告知【以外】で、優勝者名・お礼・連絡先が入りやすい側。リポジトリは public で
  // Actionsログは誰でも読める。permalink があれば全文は投稿を開けば読めるので、
  // 本文の複製は人にできることを増やさないまま公開の複製だけを作る。
  // 将来また本文を出すコードが入ったらこのテストが落ちる。
  const caption = '優勝は山田太郎さんでした!おめでとうございます。お問い合わせは 090-1234-5678 まで';
  const line = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: '店' },
    { permalink: 'https://www.instagram.com/p/ABC/', postedAt: 't', caption }
  );
  for (const secret of ['山田', '太郎', '優勝', 'おめでとう', '090', '1234', '5678', 'お問い合わせ']) {
    assert.ok(!line.includes(secret), `キャプション本文が漏れている: ${secret}`);
  }
  // 本文の断片(2文字以上の連続)が1つも含まれないことも機械的に確認する
  const chars = [...caption];
  for (let i = 0; i + 2 <= chars.length; i++) {
    const gram = chars.slice(i, i + 2).join('');
    if (/^[\s]*$/.test(gram)) continue;
    assert.ok(!line.includes(gram), `キャプションの断片が漏れている: ${JSON.stringify(gram)}`);
  }
});

test('formatFilteredOutPost: 本文の代わりに機械的な信号(文字数・日付/時刻らしき表記)を出す', () => {
  const withBoth = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: '店' },
    { permalink: 'p', postedAt: 't', caption: '8/1から 19:30スタートです' }
  );
  assert.match(withBoth, /キャプション\d+字/);
  assert.match(withBoth, /日付らしき表記=あり/);
  assert.match(withBoth, /時刻らしき表記=あり/);

  const neither = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: '店' },
    { permalink: 'p', postedAt: 't', caption: '本日も営業しております' }
  );
  assert.match(neither, /日付らしき表記=なし/);
  assert.match(neither, /時刻らしき表記=なし/);
});

test('★formatFilteredOutPost: キャプションが無い投稿はそれと分かる(キーワード方式では永久に拾えない)', () => {
  // 画像だけの日程投稿は、キャプションが空である限りキーワード方式では構造的に拾えない。
  // これが分かるだけで「キーワードを増やしても解決しない」と原因が確定する。
  const none = monitor.formatFilteredOutPost({ venueId: 'v40', label: '店' }, { permalink: 'p', postedAt: 't' });
  assert.match(none, /キャプションなし\(0字\)/);
  const empty = monitor.formatFilteredOutPost(
    { venueId: 'v40', label: '店' },
    { permalink: 'p', postedAt: 't', caption: '' }
  );
  assert.match(empty, /キャプションなし\(0字\)/);
});

test('captionSignals: 全角の数字・コロンでも日付/時刻らしき表記を拾う', () => {
  assert.deepEqual(monitor.captionSignals(''), { chars: 0, isBlank: true, hasDateLike: false, hasTimeLike: false });
  assert.equal(monitor.captionSignals('８月のお知らせ').hasDateLike, true, '全角の月表記');
  assert.equal(monitor.captionSignals('１９：３０開始').hasTimeLike, true, '全角の時刻表記');
  assert.equal(monitor.captionSignals('19時スタート').hasTimeLike, true);
  assert.equal(monitor.captionSignals('8/1開催').hasDateLike, true);
  assert.equal(monitor.captionSignals('ありがとうございました').hasDateLike, false);
  assert.equal(monitor.captionSignals('🎰🃏').chars, 2, '絵文字はコードポイントで数える');
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
    notATournamentPostCount: 0,
    humanEditedPostCount: 0,
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
    notATournamentPostCount: 0,
    humanEditedPostCount: 0,
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
    notATournamentPostCount: 0,
    humanEditedPostCount: 0,
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

test('CLI: キーワード不一致の投稿は、本文を出さずに投稿URLと信号でログに出る', () => {
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
    assert.match(r.stdout, /https:\/\/www\.instagram\.com\/p\/EN\//, 'どの投稿かが分かること(内容はここから辿る)');
    assert.match(r.stdout, /キャプション\d+字/, '本文の代わりに機械的な信号が出ること');
    assert.doesNotMatch(r.stdout, /AUGUST SCHEDULE/, '公開ログにキャプション本文を出してはいけない');
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

// ============================================================
// R-1: 取込みレベルの保存則が「恒等式」になっていないこと
// ============================================================
// 【C-1と同じ罠】各段の件数を「隣接する段の差」で数えると、合計は必ず元の件数に一致する
// (望遠鏡和)ので、保存則は絶対に破れず何も検査しない。しかも消えた投稿は隣の項に
// 吸い込まれ、「形式不正」「既読」として【積極的に誤報】される。
// ここでは実際に各段へ絞り込みを1つ注入し、残余が表に出ることを確かめる。

/**
 * 【本物の fetch-venue-posts-apify.js を通す】CLIハーネス。
 * これまでの runCliWithMutation は fetch lib をスタブに置き換えていたため、
 * 取込み最上流(正規化)の段を実際には通っていなかった。
 * globalThis.fetch を差し替えて Apify のレスポンスだけを偽装する。
 */
function runCliWithRealFetchLib({ apifyItems, state = {}, mutate = () => {} }) {
  const root = makeTempRepoRoot();
  fs.copyFileSync(
    path.join(TOOLS_DIR, 'fetch-venue-posts-apify.js'),
    path.join(root, 'tools', 'fetch-venue-posts-apify.js')
  );
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    "exports.extractTournaments = async () => [{ date: '2099-09-12', start: '19:00', name: '大会', buyin: 3000, tags: [] }];\n"
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    // Apifyのレスポンスだけを偽装する。【ハンドルを見て v40 の1店だけに返す】—
    // 全店に同じ投稿を返すと、6店ぶんの同一idが衝突して測りたいものが測れない。
    `const ITEMS = ${JSON.stringify(apifyItems)};
     globalThis.fetch = async (url, init) => {
       if (String(url).includes('apify.com')) {
         const body = init && init.body ? JSON.parse(init.body) : {};
         const handle = Array.isArray(body.username) ? body.username[0] : null;
         return { status: 200, json: async () => (handle === 'triple_orio' ? ITEMS : []), text: async () => '' };
       }
       return { status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer };
     };\n`
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

/** v40(triple_orio)向けの Apify 生アイテム。 */
const apifyItem = (slug, timestamp, caption) => ({
  url: `https://www.instagram.com/p/${slug}/`,
  displayUrl: `https://example.com/${slug}.jpg`,
  timestamp,
  caption,
});

function patchFile(root, file, from, to) {
  const p = path.join(root, 'tools', file);
  const src = fs.readFileSync(p, 'utf8');
  const out = src.replace(from, to);
  assert.notEqual(out, src, `変異の当て先が見つからない(テストの前提が古い): ${file}`);
  fs.writeFileSync(p, out);
}

test('R-1: 本物のfetch libを通した正常系では、取込みの内訳が実データと一致し残余も出ない', () => {
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-07-20T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('B', '2026-07-21T10:00:00.000Z', 'AUGUST SCHEDULE'), // キーワード不一致
      { url: 'https://www.instagram.com/p/C/' }, // 必須フィールド欠落 → 形式不正
      // 日時が読めないアイテムも normalizeApifyItem が弾くので【形式不正】に入る。
      // monitor 側の「投稿日時が読めない」は、fetch lib を経ない経路(テストのスタブなど)の
      // ための後段の守りで、本物の fetch lib を通す限り常に0になる。
      apifyItem('D', 'これは日付ではない', '8月のスケジュール'),
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Apify取得 4件 → 新着 2件 \(形式不正 2 \/ 投稿日時が読めない 0 \/ 既読 0\)/);
  assert.match(r.stdout, /新着投稿 2件 → 対象 1件 \/ キーワード不一致で対象外 1件/);
  assert.doesNotMatch(r.stdout, /集計が合わない/);
});

test('R-1: 既読の投稿がある場合も内訳が正しく、残余は出ない', () => {
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('OLD', '2026-05-10T10:00:00.000Z', '8月のスケジュール'), // 既読
      apifyItem('NEW', '2026-07-21T10:00:00.000Z', '8月のスケジュール'),
    ],
    state: { v40: { handle: 'triple_orio', lastPostedAt: '2026-06-01T00:00:00.000Z' } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Apify取得 2件 → 新着 1件 \(形式不正 0 \/ 投稿日時が読めない 0 \/ 既読 1\)/);
  assert.doesNotMatch(r.stdout, /集計が合わない/);
});

test('R-1: 正規化の後に絞り込みを1段足すと「形式不正」に吸い込まれず残余として表に出る', () => {
  // 望遠鏡和のままなら、消えた投稿は malformed に吸収されて ::error:: は出ない。
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-07-20T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('DROPME', '2026-07-21T10:00:00.000Z', '8月のスケジュール'),
    ],
    mutate: (root) =>
      patchFile(
        root,
        'fetch-venue-posts-apify.js',
        'const normalized = items.map(normalizeApifyItem).filter(Boolean);',
        "const normalized = items.map(normalizeApifyItem).filter(Boolean).filter((p) => !p.permalink.includes('DROPME'));"
      ),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /::error title=Instagram監視 - 取得件数の集計が合わない::/,
    '正規化の後で消えた投稿が「形式不正」に吸い込まれている(保存則が恒等式に戻っている)'
  );
  assert.doesNotMatch(r.stdout, /形式不正 1/, '消えた投稿を「形式不正」として誤報してはいけない');
});

test('R-1: 新着判定に絞り込みを1段足すと「既読」に吸い込まれず残余として表に出る', () => {
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-05-10T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('DROPME', '2026-05-11T10:00:00.000Z', '8月のスケジュール'),
    ],
    state: { v40: { handle: 'triple_orio', lastPostedAt: '2026-04-01T00:00:00.000Z' } },
    mutate: (root) =>
      patchFile(
        root,
        'monitor-instagram-apify.js',
        '  const fresh = sorted.filter((p) => Date.parse(p.postedAt) > lastMs);',
        "  const fresh = sorted.filter((p) => Date.parse(p.postedAt) > lastMs).filter((p) => !p.permalink.includes('DROPME'));"
      ),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /::error title=Instagram監視 - 取得件数の集計が合わない::/,
    '新着判定で消えた投稿が「既読」に吸い込まれている(未読なのに既読と誤報される)'
  );
  assert.doesNotMatch(r.stdout, /既読 1/, '未読の投稿を「既読」として誤報してはいけない');
});

test('R-1: キーワード判定に絞り込みを1段足すと残余として表に出る', () => {
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-07-20T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('DROPME', '2026-07-21T10:00:00.000Z', '8月のスケジュール'),
    ],
    mutate: (root) =>
      patchFile(
        root,
        'monitor-instagram-apify.js',
        '    const scheduleLike = newPosts.filter((p) => looksLikeSchedulePost(p.caption));',
        "    const scheduleLike = newPosts.filter((p) => looksLikeSchedulePost(p.caption)).filter((p) => !p.permalink.includes('DROPME'));"
      ),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::error title=Instagram監視 - 取得件数の集計が合わない::/);
});

test('R-1: filteredOut の件数と、実際にログへ出るキャプション行の数が一致する', () => {
  // 【残差で持っていると壊れる不変条件】件数を引き算で出すと、
  // 「件数だけ増えてログには出ない」という不一致が起こりうる。同じ述語で数えれば必ず一致する。
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-07-20T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('EN', '2026-07-21T10:00:00.000Z', 'AUGUST SCHEDULE'),
      apifyItem('TNM', '2026-07-22T10:00:00.000Z', '8月のトナメ表です'),
      apifyItem('EMOJI', '2026-07-23T10:00:00.000Z', '🎰🃏'),
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  const logged = (r.stdout.match(/キーワード不一致で対象外: /g) || []).length;
  const reported = Number(r.stdout.match(/キーワード不一致で対象外 (\d+)件/)[1]);
  assert.equal(logged, 3, '落とした3件すべてがログに出ること');
  assert.equal(reported, logged, `サマリの件数(${reported})とログの行数(${logged})が食い違っている`);
});

// ============================================================
// 「Vision抽出0件」を安心させる形で表示しないこと
// ============================================================
// 【この案件で繰り返し出た失敗の形】72/72消失で「1行も採用できなかった投稿 0件」と
// 表示していたのと同じで、サマリが安心させる方向に誤解を招くのが最も危ない。
// 0件は (a)日程を含まない投稿を拾った(正常) と (b)日程表なのに読めなかった(消失) の
// どちらでも同じ数字になる。機械に分類させず、人のゲートに置く。

test('emptyCaveat: 0件でない限り「判別できない」旨の但し書きを必ず付ける', () => {
  assert.equal(monitor.emptyCaveat(0), '', '0件のときにノイズを出さない');
  assert.match(monitor.emptyCaveat(1), /要確認/);
  assert.match(monitor.emptyCaveat(1), /判別できません/);
  assert.match(monitor.emptyCaveat(5), /日程を含まない投稿か、読めなかったか/);
});

test('CLI: Vision抽出0件があるとき、サマリの数字だけを出して安心させない', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [{ permalink: 'https://www.instagram.com/p/EMPTY/', imageUrl: 'https://example.com/E.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' }];
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
    // 店ごとのサマリにも全店合計にも但し書きが付く
    const withCaveat = (r.stdout.match(/Vision抽出0件 1件\(要確認: 日程を含まない投稿か、読めなかったか判別できません\)/g) || []).length;
    assert.equal(withCaveat, 2, `店ごと+全店合計の2箇所に但し書きが付くこと(実際=${withCaveat})`);
    // ::warning:: 側も「正常の可能性が高い」と安心させない
    const warn = r.stdout.split('\n').find((l) => l.startsWith('::warning'));
    assert.ok(warn, '::warning:: が出ること');
    assert.match(warn, /機械では判別できません/);
    assert.doesNotMatch(warn, /可能性が高い/, '片方が正常だと示唆してはいけない');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: Vision抽出0件が無い回には但し書きを出さない(ノイズにしない)', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [{ permalink: 'https://www.instagram.com/p/A/', imageUrl: 'https://example.com/A.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' }];
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
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Vision抽出0件 0件/);
    assert.doesNotMatch(r.stdout, /要確認: 日程を含まない投稿か/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 公開ログへのキャプション漏洩を「出力の全経路」に対して走査する
// ============================================================
// 【なぜ formatFilteredOutPost の戻り値だけでは足りないか】
// 断片検査をその1関数にしか当てていないと、【別のログ行に本文を出す変異】が素通りする。
// 実際、品質管理部の走査で「Vision 0件 のログ行に本文を出す」変異だけが生き残った。
// しかも次の工程はまさに「Vision 0件 の全件目視」なので、
// 「permalink だけだと確認が面倒だからキャプションも出そう」という変更が入りやすい場所。
// そこで【CLIを実際に走らせ、stdout/stderr/状態ファイル/data.js のすべて】を走査する。

/**
 * 走査用の「希少文字列」。日本語の一般的な2文字(「スケ」「日程」など)と偶然一致すると
 * 偽陽性になるので、ログにもコードにも現れない文字列を使う。
 * 【先頭・中間・末尾の3箇所に置く】— 1箇所だけだと「冒頭N字だけ出す」「末尾だけ出す」
 * といった部分的な漏洩を取り逃がす。
 */
// 2文字断片まで走査する印。ログにも data.js にも現れない文字だけで構成すること。
const FRAGMENT_MARKERS = ['ZQXJVWKZ', '龗麤鑫', 'QJXZVWQK'];
// 【2文字断片では走査しない印】電話番号は "09" "12" のような断片が
// data.js の日付・時刻(2026-09-12 / 09:00)と当たり前に一致するので、偽陽性になる。
// 個人情報として現実味のある形なので文面には残し、走査は「丸ごと一致」だけにする。
const WHOLE_MARKERS = ['090-1234-5678', '09012345678'];

/** 希少文字列を仕込んだキャプションを作る(キーワードに当てるかは keyword で選ぶ)。 */
function leakCaption(keyword) {
  return `ZQXJVWKZ ${keyword} 優勝は龗麤鑫さん 連絡先 090-1234-5678 QJXZVWQK`;
}

/** haystack 群に、希少文字列とその2文字断片が1つも現れないことを確かめる。 */
function assertNoCaptionLeak(haystacks) {
  let checked = 0;
  for (const marker of FRAGMENT_MARKERS) {
    const chars = [...marker];
    for (let i = 0; i + 2 <= chars.length; i++) {
      const frag = chars.slice(i, i + 2).join('');
      checked += 1;
      for (const [name, text] of Object.entries(haystacks)) {
        assert.ok(!text.includes(frag), `${name} にキャプションの断片が漏れている: ${JSON.stringify(frag)}`);
      }
    }
  }
  for (const marker of [...FRAGMENT_MARKERS, ...WHOLE_MARKERS]) {
    checked += 1;
    for (const [name, text] of Object.entries(haystacks)) {
      assert.ok(!text.includes(marker), `${name} にキャプション本文が漏れている: ${JSON.stringify(marker)}`);
    }
  }
  assert.ok(checked >= 20, `走査した断片が少なすぎる(${checked}通り)`);
}

test('★漏洩走査: CLIの全出力(stdout/stderr/状態ファイル/data.js)にキャプションが1文字も出ない', () => {
  // 【fixtureが痩せていると走査は空振りする】以前は Vision が常に [] を返す fixture だったため、
  // 破棄行・正規化行・異常・失われた投稿・追加行のログ経路が1度も実行されず、
  // formatDroppedRow に post.caption を混ぜる変異が生き残った。
  // formatDroppedRow / formatNormalizedRow は【すでに post を引数に受け取っている】ので、
  // 最も混入しやすい場所。ここでは以下の経路をすべて1回ずつ通してから走査する:
  //   取り込めた(追加行のログ)/ 破棄行 / 正規化行 / 全行不採用(異常)/
  //   Vision抽出失敗(失われた投稿)/ Vision抽出0件 / キーワード不一致 / 投稿別の内訳
  const root = makeTempRepoRoot();
  const post = (slug, day, keyword) =>
    `{ permalink: 'https://www.instagram.com/p/${slug}/', imageUrl: 'https://example.com/${slug}.jpg', postedAt: '2026-07-${day}T10:00:00.000Z', caption: ${JSON.stringify(leakCaption('KEYWORD')).replace('KEYWORD', '${keyword}')} }`;
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const cap = (kw) => ${JSON.stringify(leakCaption('__KW__'))}.replace('__KW__', kw);
     exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       const p = (slug, day, kw) => ({
         permalink: 'https://www.instagram.com/p/' + slug + '/',
         imageUrl: 'https://example.com/' + slug + '.jpg',
         postedAt: '2026-07-' + day + 'T10:00:00.000Z',
         caption: cap(kw),
       });
       return [
         p('OK', '20', 'スケジュール'),    // 採用あり + 破棄行 + 正規化行 が同時に出る
         p('BAD', '21', 'スケジュール'),   // 全行不採用(異常)
         p('VF', '22', 'スケジュール'),    // Vision抽出失敗(失われた投稿)
         p('EMPTY', '23', 'スケジュール'), // Vision抽出0件
         p('MISS', '24', 'AUGUST'),        // キーワード不一致(画像を見ずに破棄)
       ];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.extractTournaments = async (buf) => {
       const s = String(buf);
       if (s.includes('VF')) throw new Error('Visionモデルの出力が max_tokens で打ち切られました。');
       if (s.includes('EMPTY')) return [];
       if (s.includes('BAD')) return [{ date: '2099-9-14', start: '19:00', name: '日付不正', buyin: 3000, tags: [] }];
       return [
         { date: '2099-09-12', start: '9:00', name: '採用される大会', buyin: 3000, stack: 10000, tags: [] }, // 正規化される(9:00→09:00)
         { date: '2099-9-13', start: '19:00', name: '捨てられる大会', buyin: 3000, tags: [] },              // 破棄される
       ];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    // 【--dry-run を付けない】状態ファイルと data.js まで書かせて、書き込み先も走査対象にする。
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `正常終了すること: ${r.stderr}`);
    // 【走査の前に、狙った経路を実際に通ったことを確かめる】通っていなければ走査は空振りになる。
    const all = r.stdout + r.stderr;
    for (const [label, re] of [
      ['キーワード不一致', /キーワード不一致で対象外/],
      ['Vision抽出0件', /Vision抽出0件 1件/],
      ['破棄行(formatDroppedRow)', /抽出結果を1件破棄しました/],
      ['正規化行(formatNormalizedRow)', /正規化/],
      ['全行不採用(異常)', /投稿まるごと不採用/],
      ['失われた投稿', /内容が失われた投稿/],
      ['追加行の明細', /追加行: /],
      ['投稿別の内訳', /投稿別: /],
    ]) {
      assert.match(all, re, `${label}の経路を通っていない(走査が空振りになる)`);
    }
    assertNoCaptionLeak({
      stdout: r.stdout,
      stderr: r.stderr,
      'apify-monitor-state.json': fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'),
      'data.js': fs.readFileSync(path.join(root, 'data.js'), 'utf8'),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captionSignals: 空白のみ・ゼロ幅スペースのみも「実質なし」と判定する', () => {
  // trim() は全角スペースは落とすが【ゼロ幅スペースは落とさない】ので明示的に除いている。
  for (const blank of ['', '   ', '\n\t ', '　　', '​​', '‍', '﻿', ' ​　']) {
    assert.equal(captionSignalsIsBlank(blank), true, `空白扱いにならない: ${JSON.stringify(blank)}`);
  }
  for (const notBlank of ['8月', 'a', '　8　']) {
    assert.equal(captionSignalsIsBlank(notBlank), false, `空白扱いにしてはいけない: ${JSON.stringify(notBlank)}`);
  }
});
function captionSignalsIsBlank(s) {
  return monitor.captionSignals(s).isBlank;
}

test('formatFilteredOutPost: 空白のみのキャプションは「実質なし」と出す(短いだけと誤読させない)', () => {
  // 【誤読を防ぐのが目的】`キャプション3字` と出ると「短いだけだからキーワードを足せば拾えるかも」
  // と読めてしまうが、実際には空文字と同じでキーワード方式では構造的に永久に拾えない。
  for (const [caption, expected] of [
    ['   ', /キャプション実質なし\(空白のみ3字\)/],
    ['　　', /キャプション実質なし\(空白のみ2字\)/],
    ['​​', /キャプション実質なし\(空白のみ2字\)/],
    ['', /キャプションなし\(0字\)/],
  ]) {
    const line = monitor.formatFilteredOutPost({ venueId: 'v40', label: '店' }, { permalink: 'p', postedAt: 't', caption });
    assert.match(line, expected, `入力 ${JSON.stringify(caption)}`);
    assert.doesNotMatch(line, /日付らしき表記/, '実質なしのときに信号を並べても意味がない');
  }
});

// ============================================================
// 手順⑤(採用行の全件照合)のための明細
// ============================================================
// dry-run は data.js を書かないので、「実際に何が増えるのか」がどこにも残らない。
// 件数だけでは1行ずつ元の投稿画像と突き合わせる照合作業ができない。

test('明細: 追加される行が、出所の投稿URL付きで1行1件で出る', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/SRC/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, stack: 10000, tags: [] },
          { date: '2020-01-01', start: '19:00', name: '過去の大会', buyin: 3000, tags: [] }, // 過去日 → 増えない
        ],
      },
    ])
  );
  const s = result.summaries[0];
  assert.equal(s.addedRows.length, 1, '実際に増える行だけが明細に載ること(過去日は載らない)');
  assert.equal(s.addedRows[0].entry.name, 'マンデートナメ');
  assert.equal(s.addedRows[0].permalink, 'https://www.instagram.com/p/SRC/', '出所の投稿が分かること');

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  const row = lines.find((l) => l.includes('追加行: '));
  assert.ok(row, '追加行の明細が出ること');
  for (const part of ['v40', '2099-09-12', '19:00', 'マンデートナメ', '参加費3000', 'スタック10000', 'https://www.instagram.com/p/SRC/']) {
    assert.ok(row.includes(part), `照合に必要な項目が欠けている: ${part}`);
  }
});

test('明細: 金額が読めなかった行は「不明」と出す(0=無料と混同しない)', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/A/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '金額不明の大会', tags: [] }],
      },
    ])
  );
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  const row = lines.find((l) => l.includes('追加行: '));
  assert.match(row, /参加費不明/);
  assert.match(row, /スタック不明/);
  assert.doesNotMatch(row, /参加費0/, '読めなかった値を0(=無料)として出してはいけない');
});

test('明細: 投稿別の内訳は【対象投稿と同じ件数】並び、どの結末になっても1行出る', async () => {
  const dup = { date: '2099-09-12', start: '19:00', name: '大会A', buyin: 3000, tags: [] };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/OK/', postedAt: '2026-07-20T10:00:00.000Z', rows: [dup] },
      { permalink: 'https://www.instagram.com/p/REPOST/', postedAt: '2026-07-21T10:00:00.000Z', rows: [{ ...dup }] },
      { permalink: 'https://www.instagram.com/p/BAD/', postedAt: '2026-07-22T10:00:00.000Z', rows: [{ date: '2099-9-14', start: '19:00', name: 'X', buyin: 1, tags: [] }] },
      { permalink: 'https://www.instagram.com/p/VF/', postedAt: '2026-07-23T10:00:00.000Z', visionThrows: '打ち切り' },
      { permalink: 'https://www.instagram.com/p/IF/', postedAt: '2026-07-24T10:00:00.000Z', downloadThrows: 'HTTP 404' },
      { permalink: 'https://www.instagram.com/p/EMPTY/', postedAt: '2026-07-25T10:00:00.000Z', rows: [] },
    ])
  );
  const s = result.summaries[0];
  // 【保存則と同じ考え方】途中の continue で記録が抜けると件数が食い違う。
  assert.equal(s.posts.length, s.scheduleLikeCount, '対象投稿の数と明細の行数が一致すること');
  assert.deepEqual(
    s.posts.map((p) => p.outcome),
    ['取り込めた', '再投稿', '全行不採用', 'Vision抽出失敗', '画像DL失敗', 'Vision抽出0件'],
    'どの結末になったかが投稿ごとに分かること'
  );
});

test('明細: 日付レンジはVisionが返した行から取る(「追加0」の理由を説明できること)', async () => {
  // 久留米・黒崎の「抽出N行・追加0」が、過去日ばかりの月間表を読んだ結果なのかを検算するための情報。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/MAR/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: Array.from({ length: 10 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, '0')}`,
          start: '19:00',
          name: `3月の大会${i}`,
          buyin: 3000,
          tags: [],
        })),
      },
    ])
  );
  const p = result.summaries[0].posts[0];
  assert.equal(p.rowCount, 10);
  assert.equal(p.addedCount, 0);
  assert.equal(p.dateMin, '2026-03-01');
  assert.equal(p.dateMax, '2026-03-10', '採用後ではなくVisionが返した行のレンジであること');
  // 行レベルの保存則でも「全部過去日」と説明が付く
  assert.equal(monitor.checkRowAccounting(result.summaries[0]).pastDated, 10);
});

test('明細: 同じ店の複数投稿でも、追加行の出所がそれぞれ正しく紐づく', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/FIRST/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '一番目', buyin: 3000, tags: [] }],
      },
      {
        permalink: 'https://www.instagram.com/p/SECOND/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: [{ date: '2099-09-13', start: '19:00', name: '二番目', buyin: 3000, tags: [] }],
      },
    ])
  );
  const s = result.summaries[0];
  const byName = Object.fromEntries(s.addedRows.map((r) => [r.entry.name, r.permalink]));
  assert.equal(byName['一番目'], 'https://www.instagram.com/p/FIRST/');
  assert.equal(byName['二番目'], 'https://www.instagram.com/p/SECOND/');
  assert.equal(s.posts.find((p) => p.permalink.endsWith('/FIRST/')).addedCount, 1);
  assert.equal(s.posts.find((p) => p.permalink.endsWith('/SECOND/')).addedCount, 1);
});

test('明細: 追加行の合計が、行レベルの内訳の「追加」と一致する', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/A/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-09-12', start: '19:00', name: 'A', buyin: 3000, tags: [] },
          { date: '2099-09-13', start: '19:00', name: 'B', buyin: 3000, tags: [] },
          { date: '2020-01-01', start: '19:00', name: '過去', buyin: 3000, tags: [] },
          { date: '2099-9-14', start: '19:00', name: '不正', buyin: 3000, tags: [] },
        ],
      },
    ])
  );
  const s = result.summaries[0];
  const row = monitor.checkRowAccounting(s);
  assert.equal(s.addedRows.length, row.added, '明細の件数とサマリの「追加」が食い違ってはいけない');
  assert.equal(s.posts.reduce((a, p) => a + p.addedCount, 0), row.added);
});

// ============================================================
// 明細は「data.js に書かれるとおり」の全項目を出す
// ============================================================
// 【なぜ全項目が要るか】明細に出ない項目は⑤の照合対象から外れる。
// 例えば guarantee はサイトで「GTD ○万」バッジとして表示されるのに、明細に無ければ
// 「画像には10万GTDとあるのにサイトには出ない」を見逃したまま【偽の合格】が出る。

/** 明細1行を取り出すヘルパ。 */
function captureAcceptedRowLines(summaries) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(summaries);
  } finally {
    console.log = orig;
  }
  return lines;
}

test('明細: data.js に載る全項目(参加費/アドオン/スタック/GTD/再入場/賞品/タグ)が出る', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/FULL/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          {
            date: '2099-09-12',
            start: '19:00',
            name: '全項目そろった大会',
            buyin: 3000,
            addon: 2000,
            stack: 30000,
            guarantee: 300000,
            reentry: 'late',
            prize: '1位 賞品あり',
            tags: ['特別開催'],
          },
        ],
      },
    ])
  );
  const row = captureAcceptedRowLines(result.summaries).find((l) => l.includes('追加行: '));
  assert.ok(row, '明細が出ること');
  for (const part of ['参加費3000', 'アドオン2000', 'スタック30000', '再入場レイトのみ', 'タグ特別開催']) {
    assert.ok(row.includes(part), `照合に必要な項目が欠けている: ${part}`);
  }
  // GTD と 賞品 も必ず項目として現れること(値そのものは下の回帰テストで固定する)
  assert.match(row, /GTD/, 'GTDが明細に無いと、サイトのGTDバッジが照合対象から外れる');
  assert.match(row, /賞品/);
});

test('★明細: GTD/賞品が data.js に載らない現状を、明細がそのまま映すこと(⑤で露見させるため)', async () => {
  // 【既存の不具合をあえて固定する】tournament-merge.js の carryOver は guarantee/prize を
  // 「既存エントリから取る、無ければ null」で上書きし、Visionが読み取った値にフォールバックしない。
  // Waitinglist経路では guarantee/prize は人手専用なので正しいが、Vision経路では
  // プロンプトが両方を要求している(venue-schedule-vision.js)ため成立しない。
  //
  // 【明細は「読み取った値」ではなく「data.js に書かれる値」を出す】ので `GTD不明` と出る。
  // これが⑤の最中に「画像には30万GTDとあるのに明細はGTD不明」として必ず露見する。
  // carryOver を直したらこのテストは落ちる。そのときは期待値を「GTD300000」に更新すること。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/GTD/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          {
            date: '2099-09-12',
            start: '19:00',
            name: 'GTDつき大会',
            buyin: 3000,
            guarantee: 300000,
            prize: '1位 賞品あり',
            tags: [],
          },
        ],
      },
    ])
  );
  // data.js に入る行そのものを見る(明細の出所)
  const entry = result.arr.find((t) => t.venueId === 'v40');
  assert.equal(entry.guarantee, null, 'carryOver が読み取った GTD を捨てている(既存の不具合)');
  assert.equal(entry.prize, null, 'carryOver が読み取った 賞品 を捨てている(既存の不具合)');
  // 明細はその事実をそのまま映す = ⑤で気づける
  const row = captureAcceptedRowLines(result.summaries).find((l) => l.includes('追加行: '));
  assert.match(row, /GTD不明/, '明細が data.js の実態と食い違うと⑤が偽の合格を出す');
  assert.match(row, /賞品不明/);
});

test('明細: 読み取れた 0 と「読み取れなかった」を混同しない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/FREE/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '無料大会', buyin: 0, addon: 0, stack: 0, tags: [] }],
      },
    ])
  );
  const row = captureAcceptedRowLines(result.summaries).find((l) => l.includes('追加行: '));
  assert.match(row, /参加費0 /, '0(=無料)は「不明」にしない');
  assert.match(row, /アドオン0 /);
  assert.match(row, /スタック0 /);
});

// ---------- M-1: 既存の手入力を置き換えた行に印を付ける ----------

test('明細: 既存の手入力と同じ枠を置き換えた行には★印と置き換え先のidが出る', async () => {
  // 手入力は別idなので「idが増えた=新規」に見えるが、実際には人の入力を上書きしている。
  // 監視6店には手入力が71件残っているので現実に起こりうる。
  const manual = {
    id: 'kq0804',
    venueId: 'v40',
    name: '人が入力した大会',
    date: '2099-09-12',
    start: '19:00',
    buyin: 5000,
    addon: null,
    stack: 20000,
    guarantee: null,
    reentry: false,
    prize: null,
    tags: [],
    source: 'manual',
    verified: true,
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [manual], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/OVER/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: 'Visionが読んだ大会', buyin: 3000, tags: [] }],
      },
    ])
  );
  const s = result.summaries[0];
  assert.equal(s.addedRows.length, 1);
  assert.deepEqual(s.addedRows[0].replacedManualIds, ['kq0804'], '置き換え先の既存idが分かること');
  const row = captureAcceptedRowLines(result.summaries).find((l) => l.includes('追加行: '));
  assert.match(row, /★既存の手入力\(id=kq0804\)を置き換え/);
  // 【明細とサマリの「意味の違い」】明細=実際に増える行 / stats.added=mergeStoreの分類。
  // 手入力の置き換えは added ではなく updated に入るので、両者は一致しない。
  assert.equal(s.stats.added, 0);
  assert.equal(s.stats.updated, 1);
  assert.equal(s.stats.replacedManual.length, 1);
});

test('明細: 手入力の置き換えが無い通常の追加には★印を出さない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/NEW/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '新規', buyin: 3000, tags: [] }],
      },
    ])
  );
  const row = captureAcceptedRowLines(result.summaries).find((l) => l.includes('追加行: '));
  assert.doesNotMatch(row, /★/, '通常の追加に印を付けるとノイズになる');
});

// ---------- M-2: 投稿ごとにまとまって並ぶ ----------

test('明細: 追加行は投稿ごとにまとまり、その中で日付順に並ぶ', async () => {
  // data.js は日付順なので、並べ替えないと同じ投稿の行がばらばらに出る。
  // ⑤は「投稿を1回開いて、その投稿の行をまとめて確認 → 次の投稿」という作業。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/AAA/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-09-15', start: '19:00', name: 'A後', buyin: 1, tags: [] },
          { date: '2099-09-11', start: '19:00', name: 'A前', buyin: 1, tags: [] },
        ],
      },
      {
        permalink: 'https://www.instagram.com/p/BBB/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: [
          { date: '2099-09-13', start: '19:00', name: 'B中', buyin: 1, tags: [] },
          { date: '2099-09-17', start: '19:00', name: 'B後', buyin: 1, tags: [] },
        ],
      },
    ])
  );
  const s = result.summaries[0];
  assert.deepEqual(
    s.addedRows.map((r) => r.entry.name),
    ['A前', 'A後', 'B中', 'B後'],
    '投稿ごとにまとまり、その中で日付順であること(日付順に混ざってはいけない)'
  );
  // 並べ替えないと A前(09-11)→ B中(09-13)→ A後(09-15)→ B後(09-17) の順になる
});

// ---------- M-3: 日付レンジは書式が正しい日付だけ ----------

test('明細: 日付レンジは破棄される不正日付を含めない(文字列比較で上端が歪むため)', async () => {
  // `2026-3-31` は文字列比較で `2026-03-15` より大きく評価され、レンジ上端を歪める。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/MIX/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2026-03-01', start: '19:00', name: '正しい1', buyin: 1, tags: [] },
          { date: '2026-03-15', start: '19:00', name: '正しい2', buyin: 1, tags: [] },
          { date: '2026-3-31', start: '19:00', name: '不正(破棄される)', buyin: 1, tags: [] },
        ],
      },
    ])
  );
  const p = result.summaries[0].posts[0];
  assert.equal(p.dateMin, '2026-03-01');
  assert.equal(p.dateMax, '2026-03-15', '不正日付がレンジ上端を歪めてはいけない');
  assert.equal(p.rowCount, 3, '行数そのものは3行のまま(不正日付も抽出されてはいる)');
});

// ---------- M-4: 投稿別の明細と対象投稿数の一致を実行時にも見る ----------

test('CLI: 投稿別の明細が対象投稿数と食い違ったら ::error:: が出る', () => {
  const r = runCliWithMutation((root) => {
    // 明細を1件だけ記録し損ねる変異を注入する
    const p = path.join(root, 'tools', 'monitor-instagram-apify.js');
    const src = fs.readFileSync(p, 'utf8');
    const out = src.replace('      postDetails.push(detail);', '      if (!post.permalink.includes("/B/")) postDetails.push(detail);');
    assert.notEqual(out, src, '変異の当て先が見つからない(テストの前提が古い)');
    fs.writeFileSync(p, out);
  });
  assert.equal(r.status, 0, 'ジョブは落とさない(注記で見せる)');
  assert.match(r.stdout, /::error title=Instagram監視 - 投稿別の明細が合わない::/);
  assert.match(r.stdout, /途中で記録されずに抜けた投稿があります/);
});

// ============================================================
// 抽出品質(2026-08-01 dry-run #3 の照合で判明した4件)
// ============================================================

test('★品質: 読み取れなかった開始時刻を 00:00 で埋めない(深夜0時と表示される実害)', () => {
  const e = monitor.toTournament({ date: '2026-08-05', name: '大会', buyin: 3000, tags: [] }, 'v20');
  assert.equal(e.start, '', "'00:00' は「深夜0時開始」という読み取れた値。読み取れなかったことは空文字で表す");
  assert.match(e.id, /-nostart-/);
  // 読み取れているときはそのまま入る
  assert.equal(monitor.toTournament({ date: '2026-08-05', start: '19:15', name: '大会', tags: [] }, 'v20').start, '19:15');
});

test('★品質: 証拠ゼロでも【正当な大会は捨てない】(v18の画像は大会名と日付だけ)', () => {
  // 【最初の設計の誤り】「開始時刻・参加費・スタック・保証額が1つも無い行は大会ではない」
  // という構造判定にしたが、実際の画像を見ると v20/v18 は大会名しか書いていない。
  // つまり正当な大会も証拠ゼロで、定休日のマスとまったく同じ形をしている。
  // あの判定は「大会か否か」ではなく「詳細が書かれているか否か」を見ていただけで、
  // v18の30行がまるごと消えるところだった。
  for (const name of ['FST SATELLITE', '華金', 'Cエントリートナメ', 'DEEP STACK', 'MYSTERY BOUNTY']) {
    assert.equal(monitor.isClosureRow(name), false, `正当な大会を休業扱いにしない: ${name}`);
    assert.equal(monitor.isHeadingRow(name), false, `正当な大会を見出し扱いにしない: ${name}`);
  }
});

test('★品質: 定休日のマスは語で落とす(構造では分離できないため)', () => {
  for (const name of ['休み', 'お休み', '定休日', '休業', 'CLOSED', 'Closed', 'close', '×', '✕', 'ー', '—', '']) {
    assert.equal(monitor.isClosureRow(name), true, `落とすこと: ${JSON.stringify(name)}`);
  }
});

test('★品質: 画像の見出しは「見出し語を除くと何も残らない」ことで判定する', () => {
  // 部分一致にすると `FST TOURNAMENT` のような正当な名前まで落ちる。
  for (const name of ['月間TOURNAMENT', '2026 TOURNAMENT SCHEDULE', 'トーナメント', 'スケジュール', '月間スケジュール']) {
    assert.equal(monitor.isHeadingRow(name), true, `見出しとして落とすこと: ${name}`);
  }
  for (const name of ['FST TOURNAMENT', 'DEEP STACK トーナメント', '華金トーナメント']) {
    assert.equal(monitor.isHeadingRow(name), false, `固有名がある行は落とさない: ${name}`);
  }
});

test('★品質: 証拠ゼロの行には lowConfidence(⚠要確認)を付けて公開する', () => {
  // 「詳細未定の大会」も「語の判定から漏れた定休日」も、機械には区別できない。
  // どちらに対しても「要確認」の表示は意味が正しい。
  const noEvidence = monitor.toTournament({ date: '2026-08-05', name: 'FST SATELLITE', tags: [] }, 'v18');
  assert.equal(noEvidence.lowConfidence, true, '証拠ゼロの行は要確認として出す');
  assert.equal(noEvidence.start, '', '捨てずに取り込む');
  // 証拠が1つでもあれば印を付けない(ノイズにしない)
  for (const t of [
    { date: '2026-08-05', name: 'X', start: '19:00', tags: [] },
    { date: '2026-08-05', name: 'X', buyin: 3000, tags: [] },
    { date: '2026-08-05', name: '感謝祭トナメ', buyin: 0, tags: [] },
    { date: '2026-08-05', name: 'X', stack: 30000, tags: [] },
    { date: '2026-08-05', name: 'X', guarantee: 100000, tags: [] },
  ]) {
    assert.equal(monitor.toTournament(t, 'v18').lowConfidence, undefined, `証拠があれば印は不要: ${JSON.stringify(t)}`);
  }
});

test('品質: リングゲーム/キャッシュゲームは非トーナメントとして落とす', () => {
  for (const n of ['リングゲーム', 'リング ゲーム', 'Ring Game', 'ringgame', 'キャッシュゲーム', 'CASH GAME']) {
    assert.equal(monitor.isNonTournamentFormat(n), true, `落とすこと: ${n}`);
  }
  for (const n of ['デイリートナメ', 'マンデートナメ', 'サテライト', '']) {
    assert.equal(monitor.isNonTournamentFormat(n), false, `落としてはいけない: ${n}`);
  }
});

test('★品質: タグをサイトの語彙に寄せ、未知の語は捨てる', () => {
  // 2026-08-01 の dry-run で実際に返ってきた値。
  assert.deepEqual(monitor.canonicalTags(['satellite']), ['サテライト']);
  assert.deepEqual(monitor.canonicalTags(['freeroll']), ['フリーロール']);
  assert.deepEqual(monitor.canonicalTags(['deep stack']), ['ディープ']);
  assert.deepEqual(monitor.canonicalTags(['deepstack']), ['ディープ'], '表記揺れも同じ語に寄せる');
  assert.deepEqual(monitor.canonicalTags(['mystery・bounty']), ['バウンティ']);
  // サイトに無い語は捨てる(タグ絞り込みの選択肢を汚さない)
  assert.deepEqual(monitor.canonicalTags(['freezeout']), []);
  // 大文字小文字・全角・重複
  assert.deepEqual(monitor.canonicalTags(['DEEP STACK', 'deepstack', 'ＴＵＲＢＯ']), ['ディープ', 'ターボ']);
  assert.deepEqual(monitor.canonicalTags(null), []);
  assert.deepEqual(monitor.canonicalTags(['ターボ']), ['ターボ'], '既に日本語のものはそのまま');
});

test('★品質: 取込み経路の全体で、休み・見出し・リングゲームが落ち、正しい行だけが残る', async () => {
  // dry-run #3 で実際に来た形を再現する。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/AUG/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-08-01', start: null, name: '休み', buyin: null, stack: null, tags: [] },
          { date: '2099-08-01', start: null, name: '月間TOURNAMENT', buyin: null, stack: null, tags: [] },
          { date: '2099-08-03', start: null, name: 'リングゲーム', buyin: 3000, tags: [] },
          { date: '2099-08-04', start: null, name: 'FST SATELLITE', buyin: null, stack: null, tags: [] },
          { date: '2099-08-05', start: null, name: '時刻不明の大会', buyin: 3000, stack: 10000, tags: ['satellite'] },
          { date: '2099-08-06', start: '19:15', name: 'ちゃんと読めた大会', buyin: 2000, tags: ['mystery・bounty'] },
        ],
      },
    ])
  );
  const names = result.arr.filter((t) => t.venueId === 'v40').map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    ['FST SATELLITE', 'ちゃんと読めた大会', '時刻不明の大会'],
    '休み・見出し・リングゲームは入らないが、証拠ゼロの正当な大会は残る'
  );
  const reasons = result.summaries[0].dropped.map((d) => d.reason);
  assert.equal(reasons.filter((r) => /定休日・休業のマス/.test(r)).length, 1);
  assert.equal(reasons.filter((r) => /画像の見出し/.test(r)).length, 1);
  assert.equal(reasons.filter((r) => /トーナメントではない競技形式/.test(r)).length, 1);
  // 証拠ゼロの行には⚠印が付く
  assert.equal(result.arr.find((t) => t.name === 'FST SATELLITE').lowConfidence, true);
  assert.equal(result.arr.find((t) => t.name === 'ちゃんと読めた大会').lowConfidence, undefined);
  // 残った行の中身
  const byName = Object.fromEntries(result.arr.filter((t) => t.venueId === 'v40').map((t) => [t.name, t]));
  assert.equal(byName['時刻不明の大会'].start, '', '00:00 で埋めない');
  assert.deepEqual(byName['時刻不明の大会'].tags, ['サテライト'], 'タグは日本語語彙に寄る');
  assert.equal(byName['ちゃんと読めた大会'].start, '19:15');
  assert.deepEqual(byName['ちゃんと読めた大会'].tags, ['バウンティ']);
  // 行レベルの保存則は引き続き成り立つ(落とした行は破棄に数えられている)
  assert.ok(monitor.checkRowAccounting(result.summaries[0]).ok);
});

test('★品質: 開始時刻が読めない割合は必ず記録するが、平常の範囲では警告しない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/NOSTART/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: Array.from({ length: 4 }, (_, i) => ({
          date: `2099-08-0${i + 1}`,
          start: i === 0 ? '19:00' : null,
          name: `大会${i}`,
          buyin: 3000,
          tags: [],
        })),
      },
    ])
  );
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  // 【値そのものでは警告しない】画像に時刻が書かれていないことは⑤で確認済みで、
  // 高い割合は【平常】。毎回点灯する警報にしないため、平常値からの変化だけを見る。
  const info = lines.find((l) => l.includes('開始時刻が読めなかった行'));
  assert.ok(info, '割合そのものは必ず記録すること');
  assert.match(info, /4行中3行\(75%\)/);
  assert.match(info, new RegExp(`${monitor.EXPECTED_NO_START_PCT}%前後が平常`));
  // 75% は平常95%±25 の範囲内なので警告は出ない
  assert.ok(!lines.some((l) => l.startsWith('::warning')), '平常の範囲では警告を出さない(常時点灯を作らない)');
  // 明細では「開始時刻不明」と読める形にする(空欄だと⑤で読めない)
  assert.ok(lines.some((l) => l.includes('追加行: ') && l.includes('開始時刻不明')));
});

test('品質: すべての行で開始時刻が読めていれば警告を出さない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/OK/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-08-01', start: '19:00', name: '大会', buyin: 3000, tags: [] }],
      },
    ])
  );
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  assert.ok(!lines.some((l) => l.startsWith('::warning')), '正常時にノイズを出さない');
});

// ============================================================
// 部分一致による過剰破棄の防止 / 名前由来の参加費 / 捨てたタグの記録
// ============================================================

test('★品質: 休業判定を部分一致にしない(正当な大会を落とさない)', () => {
  // `some((w) => key.includes(w))` にすると短い語(とくに 'off')が単語の内側で一致する。
  // 【層1で捨てた行は層2に届かない】ので、⚠を付けて残す多層防御に到達しないまま
  // 内容が完全に失われ、lastPostedAt は前進するので再試行もされない。
  for (const name of [
    'OFFICIAL TOURNAMENT',
    'PLAYOFF',
    'PLAY OFF',
    'KICK OFF',
    'TAKE OFF',
    'OFF THE CHARTS',
    '夏休みスペシャル',
    '冬休みトナメ',
    'GW休みなし営業記念',
    'HOLIDAY SPECIAL',
    'CLOSE THE DEAL',
  ]) {
    assert.equal(monitor.isClosureRow(name), false, `正当な大会を休業扱いにしてはいけない: ${name}`);
  }
});

test('品質: 休業語だけでできた名前は引き続き落とす', () => {
  for (const name of ['休み', 'お休み', '定休日', '休業', '休館', 'CLOSED', 'close', 'holiday', 'no game', 'off', '×', 'ー', '']) {
    assert.equal(monitor.isClosureRow(name), true, `落とすこと: ${JSON.stringify(name)}`);
  }
});

test('★品質: 名前由来かもしれない参加費は「証拠」に数えない(⚠を消させない)', () => {
  // Visionは画像に金額が無くても FREE ROLL→0 / 1K MULTI→1000 と推論して返すことがある。
  // これを証拠に数えると ⚠要確認 が消え、「誤った参加費の公開」と
  // 「それを疑えと伝える唯一の表示の消失」が重なる。⑤でも画像に数字はあるので見抜けない。
  for (const t of [
    { name: '1K MULTI', buyin: 1000 },
    { name: 'FREE ROLL', buyin: 0 },
    { name: '大還元フリロ', buyin: 0 },
    { name: '2K BOUNTY', buyin: 2000 },
    { name: '3000円トナメ', buyin: 3000 },
  ]) {
    assert.equal(monitor.hasTournamentEvidence(t), false, `⚠を残すこと: ${t.name}`);
  }
  // 名前に金額トークンが無ければ、buyin は従来どおり証拠
  assert.equal(monitor.hasTournamentEvidence({ name: 'デイリートナメ', buyin: 3000 }), true);
  // buyin 以外の証拠があれば、名前に金額トークンがあっても証拠あり(名前由来を疑う必要がない)
  assert.equal(monitor.hasTournamentEvidence({ name: '1K MULTI', buyin: 1000, start: '19:00' }), true);
  assert.equal(monitor.hasTournamentEvidence({ name: '1K MULTI', buyin: 1000, stack: 20000 }), true);
});

test('★品質: 参加費の値そのものは消さない(⚠を残すだけ)', () => {
  const e = monitor.toTournament({ date: '2026-08-05', name: '1K MULTI', buyin: 1000, tags: [] }, 'v20');
  assert.equal(e.buyin, 1000, '値を消すと情報が失われる。消すのではなく⚠を残す');
  assert.equal(e.lowConfidence, true);
});

test('★品質: 捨てたタグが正規化ログに記録される(コメントを事実にする)', async () => {
  // canonicalTags は toTournament の中で走り normalizeExtractedRow の notes 経路を通らないので、
  // 取込み側で明示的に記録しないと「捨てた事実はログに出る」が嘘になる。
  assert.deepEqual(monitor.droppedTags(['satellite', 'freezeout', 'multi', 'ノーリミット']), [
    'freezeout',
    'multi',
    'ノーリミット',
  ]);
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/TAG/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          {
            date: '2099-08-05',
            start: '19:00',
            name: 'タグが混ざる大会',
            buyin: 3000,
            tags: ['satellite', 'freezeout', 'multi', 'ノーリミット'],
          },
        ],
      },
    ])
  );
  assert.deepEqual(result.arr.find((t) => t.venueId === 'v40').tags, ['サテライト']);
  const note = result.summaries[0].normalized.find((n) => n.notes.some((x) => x.field === 'tags'));
  assert.ok(note, '捨てたタグが正規化ログに残ること');
  assert.deepEqual(note.notes[0].from, ['freezeout', 'multi', 'ノーリミット']);
  assert.equal(result.summaries[0].normalizedCount, 1, '件数にも数えられること');
});

test('品質: 捨てるタグが無ければ正規化ログを汚さない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/OK/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-08-05', start: '19:00', name: '大会', buyin: 3000, tags: ['satellite'] }],
      },
    ])
  );
  assert.equal(result.summaries[0].normalizedCount, 0);
});

test('★隔離: CLI — 1店の取得失敗で終了コード2、他店は取り込み、失敗店の状態は前進しない', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'apify-monitor-state.json'),
    `${JSON.stringify({ v40: { handle: 'triple_orio', lastPostedAt: '2026-07-01T00:00:00.000Z' } }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle === 'triple_orio') throw new Error('The operation was aborted due to timeout');
       if (handle !== 'king2485queen') return [];
       return [{ permalink: 'https://www.instagram.com/p/OK/', imageUrl: 'https://example.com/OK.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' }];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    "exports.extractTournaments = async () => [{ date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] }];\n"
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, `一部失敗は終了コード2(0でも1でもない): ${r.stderr}`);
    assert.match(r.stdout, /::error title=Instagram監視 - 取得に失敗した店::/);
    assert.match(r.stdout, /★取得失敗のためスキップしました/, '「新着0件」と見分けが付く形で出ること');
    assert.match(r.stdout, /取得失敗 1店/, '合計にも出ること');
    // 成功した店のデータは書き込まれている
    assert.match(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), /マンデートナメ/);
    // 【最重要】失敗した店の確認済み投稿日時は前進していない
    const state = JSON.parse(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'));
    assert.equal(state.v40.lastPostedAt, '2026-07-01T00:00:00.000Z', '失敗店の状態を進めてはいけない');
    assert.ok(state.v20.lastPostedAt, '成功店の状態は進む');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★隔離: CLI — dry-run でも同じ挙動(失敗店をスキップして他店は処理、終了コード2)', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle === 'triple_orio') throw new Error('timeout');
       if (handle !== 'king2485queen') return [];
       return [{ permalink: 'https://www.instagram.com/p/OK/', imageUrl: 'https://example.com/OK.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' }];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    "exports.extractTournaments = async () => [{ date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] }];\n"
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
  const beforeState = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
  try {
    const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', '--dry-run'], {
      cwd: root,
      env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
      encoding: 'utf8',
    });
    // dry-run でも終了コードを揃える(揃えないと dry-run が緑で通り本番で初めて赤くなる)
    assert.equal(r.status, 2);
    // 【他店の処理は続く】dry-run が全店を1回で観測できないと、較正のたびに何度も回すことになる
    assert.match(r.stdout, /追加行: v20 /, '失敗店をスキップして他店の明細まで出ること');
    assert.match(r.stdout, /対象 6店 = 観測できた 5店 \+ 【取得失敗 1店】/);
    // 書き込みは一切していない
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData);
    assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), beforeState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★隔離(検知側): 店の内訳が対象数と合わなければ ok=false になる', () => {
  // 【C-2 と同じ教訓】健全な入力で true になることしか見ていないと、
  // `ok: true` に潰す変異が生き残る。偽になる方向も固定する。
  const broken = { fetchFailed: false };
  const acc = monitor.checkStoreAccounting([broken, broken], 2);
  assert.equal(acc.ok, true, '健全な入力では true');
  // 検査そのものが「常に true」になっていないことを、内訳の値で確かめる
  assert.equal(monitor.checkStoreAccounting([{ fetchFailed: true }], 1).failed, 1);
  assert.equal(monitor.checkStoreAccounting([{ fetchFailed: true }], 1).observed, 0);
  assert.equal(monitor.checkStoreAccounting([], 0).expected, 0);
});

test('★隔離(検知側): CLI — 店の集計が合わなくなったら ::error:: が出る', () => {
  const r = runCliWithMutation((root) => {
    // 失敗した店の summary を summaries に入れ忘れる変異(=店の数が合わなくなる)
    const p = path.join(root, 'tools', 'monitor-instagram-apify.js');
    const src = fs.readFileSync(p, 'utf8');
    // 新着0件の店の summary を入れ忘れる = 対象6店に対し記録が足りなくなる
    const out = src.replace(
      '    if (newPosts.length === 0) {\n      summaries.push(summary);\n      continue;',
      '    if (newPosts.length === 0) {\n      continue;'
    );
    assert.notEqual(out, src, '変異の当て先が見つからない(テストの前提が古い)');
    fs.writeFileSync(p, out);
  });
  assert.match(r.stdout, /::error title=Instagram監視 - 店の集計が合わない::/);
});

// ============================================================
// 空振りの赤を作らない(dry-run #5 で実際に出たもの)
// ============================================================

test('★空振り: 全行が「大会ではない」だけの投稿は異常にしない(何も失われていない)', async () => {
  // dry-run #5 で v34 の19行すべてがリングゲームの投稿だった。大会は1件も含まれておらず、
  // 失われたものは無いのに ::error:: が点いた。duplicate-in-run を外したのと同じ理由。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/RING/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-08-01', start: '19:00', name: 'リングゲーム', buyin: 3000, tags: [] },
          { date: '2099-08-02', start: '19:00', name: 'キャッシュゲーム', buyin: 3000, tags: [] },
        ],
      },
    ])
  );
  assert.equal(result.anomalies.length, 0, '大会が1件も無い投稿を赤にしない');
  assert.equal(result.summaries[0].notATournamentPostCount, 1);
  assert.equal(result.summaries[0].unusablePostCount, 0);
  assert.ok(monitor.checkPostAccounting(result.summaries[0]).ok, '保存則は保たれること');
});

test('★空振り: 大会ではない行と本物の不正行が混在したら、従来どおり異常として上げる', async () => {
  // every を使う理由。混在は「取り込めたはずの行が失われている」ので赤にすべき。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/MIX/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [
          { date: '2099-08-01', start: '19:00', name: 'リングゲーム', buyin: 3000, tags: [] },
          { date: '2099-8-02', start: '19:00', name: '日付が不正な本物の大会', buyin: 3000, tags: [] },
        ],
      },
    ])
  );
  assert.equal(result.anomalies.length, 1, '本物の大会が失われているので異常');
  assert.equal(result.summaries[0].notATournamentPostCount, 0);
  assert.equal(result.summaries[0].unusablePostCount, 1);
});

test('★空振り: 判定は理由の文面ではなく kind で行う(文言を直しても壊れない)', async () => {
  // 理由の日本語を書き換えても分類が変わらないこと。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/CLOSED/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: [{ date: '2099-08-01', start: null, name: '休み', buyin: null, stack: null, tags: [] }],
      },
    ])
  );
  assert.equal(result.summaries[0].dropped[0].kind, 'not-a-tournament');
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.summaries[0].notATournamentPostCount, 1);
});

/**
 * 「開始時刻が読めなかった行が noStartCount / total」という採用結果を組み立てる。
 * total=100 で呼べば noStartCount がそのまま割合(%)になる。
 */
const mk = (noStartCount, total) => [
  {
    addedRows: Array.from({ length: total }, (_, i) => ({
      entry: { venueId: 'v40', date: '2099-08-01', start: i < noStartCount ? '' : '19:00', name: `大会${i}`, buyin: 1, tags: [] },
      permalink: 'p',
      replacedManualIds: [],
    })),
    posts: [],
  },
];

/** 実物の reportAcceptedRows を呼び、::warning:: が出たかどうかだけを返す。 */
function warnsAt(noStartCount, total) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(mk(noStartCount, total));
  } finally {
    console.log = orig;
  }
  return lines.some((l) => l.startsWith('::warning'));
}

test('★警告: 平常から大きく外れたときだけ ::warning:: を出す', () => {
  const lines = [];
  const orig = console.log;
  // 平常(95%付近)→ 警告なし
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(mk(19, 20)); // 95%
  } finally {
    console.log = orig;
  }
  assert.ok(!lines.some((l) => l.startsWith('::warning')), '平常値では警告しない(常時点灯を作らない)');

  // 大きく外れた(0%)→ 警告あり
  const lines2 = [];
  console.log = (...a) => lines2.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(mk(0, 20)); // 0%
  } finally {
    console.log = orig;
  }
  const w = lines2.find((l) => l.startsWith('::warning'));
  assert.ok(w, '平常から外れたら警告すること');
  assert.match(w, /平常から外れた/);
  assert.match(w, /EXPECTED_NO_START_PCT を更新/, '平常値が変わったときの手順も示すこと');

  // 【★到達不能な分岐を「ある」と書かない】(2026-08-04・レビュー部の指摘)
  // 「上がったならVisionが読めなくなった可能性」は EXPECTED(95)+TOL(25) では pct>120 が要り、
  // 割合の定義域 [0,100] では起こりえない。出ない警告を「出る」と書くのは
  // 【システムが事実でないことを述べている】状態で、この案件で最も避けたい形。
  // 【この否定形の検査は弱い】言い換え(例:「なお上振れも警告で拾えます」の追記)は素通りする。
  // それでも残しているのは、下の「上振れ側では実装が一度も発火しない」を実物で押さえたことで、
  // 【文面が実装より広い主張をしている】状態は実装側から検出できるようになったため。
  // 正の側(/下振れ/ /対象外/)との併用と合わせ、歯止めとしてはここまでとする。
  assert.doesNotMatch(
    w,
    /上がったならVisionが読めなくなった/,
    '到達不能な上振れ分岐を「検知する」と書かないこと(READMEはcron解除の判断材料そのもの)'
  );
  assert.match(w, /下振れ/, 'この警告が検知しているのは下振れだけだと明示すること');
  assert.match(w, /対象外/, '上振れ(Visionの劣化)はこの警告の対象外だと明示すること');
});

test('★警告: 上振れ側は実装が一度も発火しない(文面と実装のずれを固定する)', () => {
  // 【★判定式をテスト側に書き写さないこと】以前ここは
  //   const fires = (pct) => Math.abs(pct - EXPECTED) > TOLERANCE;
  // というテスト内の再実装を走査していた。これは定数を検査しているだけで
  // 【実装を一度も呼んでいない】ため、実装の条件に `|| pct > EXPECTED + 2` を足す変異
  // (= 警告文とREADMEの「上振れは対象外」が再び嘘になる)が生き残った。
  // 再発を防ぐために足した検査が、その再発を防げていなかった。実物を呼ぶこと。
  //
  // total=100 なので noStartCount がそのまま割合(%)になる。
  for (let pct = monitor.EXPECTED_NO_START_PCT; pct <= 100; pct += 1) {
    assert.equal(warnsAt(pct, 100), false, `pct=${pct} は上振れ側なので発火しない(天井効果)`);
  }
  // 下振れ側は従来どおり発火する(上のループが「常に false」で通る抜け殻でないことの担保)。
  assert.equal(warnsAt(0, 100), true, '下振れ側では発火すること(検査そのものが死んでいないこと)');
  // 定数を変えて上振れ側を発火可能にしたときは、警告文とREADMEの「下振れ専用」も書き直すこと
  // (上のループでも落ちるが、こちらの方が理由が明示的に出る)。
  assert.ok(
    monitor.EXPECTED_NO_START_PCT + monitor.NO_START_PCT_TOLERANCE >= 100,
    '上振れが発火しうる定数にするなら、警告文とREADMEの「下振れ専用」を書き直すこと'
  );
});
