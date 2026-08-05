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

// ---------- runMonitor(中核ロジック。依存注入・ファイルI/Oなし) ----------

function addDaysJst(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// ============================================================
// カレンダー形状の fixture ヘルパ(2026-08-04 のスコープ変更に伴う移行)
// ============================================================
// 【なぜ必要になったか】取込みの対象が「その店の最新月のカレンダー1枚」に絞られ、
// 判定はキャプションの語ではなく【Visionが読んだ結果の構造】で行うようになった:
//   支配月(最も日付が多い月)の異なる日付が MIN_CALENDAR_DATES 以上
//   かつ 日付の広がりが MIN_CALENDAR_SPAN_DAYS 日以上
// 旧 fixture は「1投稿 = 1〜2行」の形なので、そのままでは全部「カレンダーでない」と
// 判定され、行レベルの検査(破棄・正規化・id重複・タグ…)に1件も到達しない。
// つまり 53件の失敗は fixture が現実(=カレンダー)の形をしていないことによるもので、
// **閾値を下げて fixture に合わせるのは逆向き**。fixture の方をカレンダーの形にする。
//
// 【埋め行の性質】テストの主張を汚さないことが条件:
//   - 破棄されない・正規化されない(droppedCount / normalizedCount の期待値を変えない)
//   - lowConfidence が付かない(buyin を証拠として持つ)
//   - 名前で判別できる(realRows で「テストが主張したい行」だけを取り出せる)
//   - テスト行と日付がぶつからない日に置く(同日内の並び順の主張を壊さない)
// この4つが本当に成り立っていることは、下の「★ヘルパ自体の健全性」テストで固定する。
const FILLER_DAYS = [19, 22, 25, 28, 30]; // 異なる日付5・広がり11日 = 判定条件をちょうど満たす
const FILLER_PREFIX = 'カレンダー埋め';
const FILLER_COUNT = FILLER_DAYS.length;

/** `month` = 'YYYY-MM'。カレンダー判定を満たすためだけの行を返す。 */
function fillerRows(month) {
  return FILLER_DAYS.map((d) => ({
    date: `${month}-${String(d).padStart(2, '0')}`,
    start: '19:00',
    name: `${FILLER_PREFIX}${d}`,
    buyin: 3000,
    tags: [],
  }));
}

/** テストが主張したい行に、カレンダー判定を満たすための埋め行を足して1投稿ぶんの行にする。 */
function asCalendar(rows, month) {
  return [...rows, ...fillerRows(month)];
}

const isFiller = (t) => typeof (t && t.name) === 'string' && t.name.startsWith(FILLER_PREFIX);
/** 埋め行を除いた「テストが主張したい行」だけを取り出す。 */
const realRows = (list) => list.filter((t) => !isFiller(t));

test('★ヘルパ自体の健全性: 埋め行は1件も破棄・正規化されず、⚠も付かない(テストの主張を汚さない)', async () => {
  // 【このテストが要る理由】埋め行が黙って破棄されるようになると、
  // 下の各テストは realRows() で埋め行を除いて見ているため【気づかないまま緑になる】。
  // 埋め行の前提条件はここで正面から固定する。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(fillerRows('2099-09'))
  );
  const s = result.summaries[0];
  assert.equal(s.droppedCount, 0, '埋め行が破棄されている(下のテストの前提が崩れる)');
  assert.equal(s.normalizedCount, 0, '埋め行が正規化されている(normalizedCount の期待値が狂う)');
  assert.equal(s.extractedCount, FILLER_COUNT);
  assert.equal(result.arr.length, FILLER_COUNT);
  for (const t of result.arr) {
    assert.ok(isFiller(t), `埋め行の判別に失敗している: ${t.name}`);
    assert.equal(t.lowConfidence, undefined, '埋め行に⚠が付くと lowConfidence の主張が汚れる');
  }
  // 埋め行だけでカレンダー判定を満たすこと(テスト行が0行でも成立する = 主張を足し算にしない)
  assert.equal(s.importedPostCount, 1, '埋め行だけでカレンダーとして採用されること');
  assert.equal(s.notCalendarPostCount, 0);
});

test('★ヘルパ自体の健全性: 埋め行を抜くとカレンダー判定を満たさない(埋め行が効いていること)', () => {
  const shape = monitor.calendarShape(fillerRows('2099-09'));
  assert.equal(shape.isCalendar, true);
  assert.equal(shape.distinctDates, FILLER_COUNT);
  assert.equal(shape.dominantMonth, '2099-09');
  // 1行減らすと満たさなくなる = 閾値ぴったりに置いてあり、緩められたら下のテストが動く
  assert.equal(monitor.calendarShape(fillerRows('2099-09').slice(1)).isCalendar, false);
});

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
        // 【カレンダー1枚ぶんの行を返す】1行だけだと「カレンダーではない」と判定され、
        // 取込みそのものが起きない(このテストが見たい隔離の性質を確認できない)。
        return asCalendar(
          [{ date: futureDate, start: '19:00', name: 'Apify統合テスト大会', buyin: 3000, tags: [] }],
          futureDate.slice(0, 7)
        );
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
// `source: 'auto'`のままだと、tools/tournament-merge.jsのmergeStoreが
// 「対象店舗のautoエントリは毎回全部作り直す(取得結果に無いものは消す)」規則を適用するため、
// 1回目のマージで追加した未来日エントリが、2回目のマージ(別投稿の検知)で消えてしまう。
// `source: 'semi'`に修正したことで、対応する(date,start)が無いものは残る規則が
// 適用され、この消失が起きないことを確認する。
//
// 【2026-08-04 の書き換え】以前は「1投稿1イベント形式の店」を題材にしていたが、
// 取込み対象が【月間カレンダー1枚】に絞られたため、1投稿1イベントの投稿はそもそも
// カレンダーと判定されず取り込まれない = その題材では消失が起こりようがなくなった。
// 一方で【消失の危険は無くなっていない】: 店が翌月のカレンダーを出すと、2回目の取込みは
// 前月ぶんの行を1件も含まない。'auto' に戻せば前月の行はここで全部消える。
// 題材を「月をまたいだ2枚のカレンダー」に置き換えて、同じ回帰を見る。
test('runMonitor: 翌月のカレンダーを取り込んでも、前回のカレンダーで追加した未来日エントリが消えない(回帰テスト)', async () => {
  const store = monitor.STORES.find((s) => s.handle === 'pokerbar_iris');
  assert.ok(store, 'pokerbar_iris がSTORESに存在すること(テストの前提)');

  const today = '2026-07-31';
  const dateA = '2026-08-10';
  const dateB = '2026-09-17';

  // 1回目: 8月のカレンダーを検知
  const fetchLibRun1 = {
    async fetchInstagramPosts(handle) {
      if (handle !== store.handle) return [];
      return [
        {
          permalink: 'https://www.instagram.com/p/EVENTA/',
          imageUrl: 'https://example.com/a.jpg',
          postedAt: '2026-07-25T10:00:00.000Z',
          caption: '8月のスケジュール',
        },
      ];
    },
  };
  const visionLibRun1 = {
    async extractTournaments() {
      return asCalendar([{ date: dateA, start: '19:00', name: 'イベントA', buyin: 3000, tags: [] }], '2026-08');
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

  // 2回目: 別の投稿で【9月の】カレンダーを検知(8月ぶんの行は1件も含まれない)
  const fetchLibRun2 = {
    async fetchInstagramPosts(handle) {
      if (handle !== store.handle) return [];
      return [
        {
          permalink: 'https://www.instagram.com/p/EVENTB/',
          imageUrl: 'https://example.com/b.jpg',
          postedAt: '2026-07-28T10:00:00.000Z',
          caption: '9月のスケジュール',
        },
      ];
    },
  };
  const visionLibRun2 = {
    async extractTournaments() {
      return asCalendar([{ date: dateB, start: '19:00', name: 'イベントB', buyin: 3000, tags: [] }], '2026-09');
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
  // 8月の埋め行(=前月のカレンダーの残り)も1件残らず消えていないこと
  assert.equal(
    run2.arr.filter((t) => isFiller(t) && t.date.startsWith('2026-08')).length,
    FILLER_COUNT,
    '前月のカレンダーの行が翌月の取込みで消えている(source が auto に戻ると起きる)'
  );
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
    fakeLibsFor(asCalendar(rows, '2099-01'))
  );

  const names = realRows(result.arr).map((t) => t.name).sort();
  assert.deepEqual(names, ['正しい大会1', '正しい大会2'], '正しい行だけが取り込まれること');
  assert.equal(result.changed, true);

  const summary = result.summaries[0];
  assert.equal(summary.extractedCount, FILLER_COUNT + 2);
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
    fakeLibsFor(asCalendar(rows, '2099-01'))
  );
  assert.equal(realRows(result.arr).length, 1);
  assert.equal(result.summaries[0].droppedCount, 4);
  assert.match(result.summaries[0].dropped[0].reason, /name が空/);
  assert.match(result.summaries[0].dropped[2].reason, /オブジェクトではない/);
});

test('runMonitor: 投稿から1行も採用できなければ異常(anomalies)として記録するが、例外は投げず状態は前進する', async () => {
  // 【日付が全部壊れた投稿では再現できなくなった(2026-08-04)】
  // 日付が YYYY-MM-DD でない行はカレンダー判定の材料にならないので、
  // 「全行の日付が壊れている投稿」は【カレンダーではない】として画像の段階で対象外になり、
  // 行の検査そのものに到達しない(=異常ではなく「対象外」)。
  // ここで見たいのは「カレンダーとして採用した投稿から1行も取り込めなかったとき」なので、
  // 日付は正しく(=カレンダーとして採用され)、行としては全部捨てられる形にする。
  const rows = FILLER_DAYS.map((d) => ({
    date: `2099-01-${d}`,
    start: '19:00',
    name: '   ', // 大会名が読み取れない = 行としては採用できない
    buyin: 3000,
    tags: [],
  }));
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(rows, { permalink: 'https://www.instagram.com/p/ALLBAD/' })
  );

  assert.equal(result.changed, false, 'data.jsは書き換え対象にならない');
  assert.deepEqual(result.arr, []);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].store.venueId, 'v40');
  assert.equal(result.anomalies[0].permalink, 'https://www.instagram.com/p/ALLBAD/');
  assert.equal(result.anomalies[0].rowCount, rows.length);
  assert.match(result.anomalies[0].reasons.join(''), /name が空/);
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
  // 【不正な店は「カレンダーだが全行が捨てられる」形にする】日付が壊れた行だけを返すと
  // カレンダー判定に到達せず「対象外」になり、取込みの不正として扱われなくなるため。
  const brokenRows = FILLER_DAYS.map((d) => ({
    date: `2099-09-${d}`,
    start: '25:00', // 範囲外の時刻 = 行として採用できない
    name: '時刻が範囲外の大会',
    buyin: 3000,
    tags: [],
  }));
  const visionLib = {
    async extractTournaments(buffer) {
      const handle = String(buffer).replace('https://example.com/', '').replace('.jpg', '');
      if (handle === BROKEN) return brokenRows;
      return asCalendar([{ date: '2099-09-05', start: '19:00', name: `${handle}の大会`, buyin: 3000, tags: [] }], '2099-09');
    },
  };

  const result = await monitor.runMonitor(
    { stores: monitor.STORES, before: [], today: '2026-07-31', state: {} },
    { fetchLib, visionLib, mergeLib, downloadImage }
  );

  assert.equal(result.changed, true);
  assert.equal(realRows(result.arr).length, okVenueIds.length, '不正だった1店を除く全店ぶんが取り込まれていること');
  const importedVenues = realRows(result.arr).map((t) => t.venueId).sort();
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
  assert.equal(brokenSummary.droppedCount, brokenRows.length);
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
    fakeLibsFor(asCalendar([row, { ...row }], '2099-09'))
  );

  assert.equal(realRows(result.arr).length, 1, '採用されるのは1件だけ');
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
    fakeLibsFor(asCalendar(rows, '2099-09'))
  );
  const kept = realRows(result.arr);
  assert.equal(kept.length, 1);
  // 【'00:00' で埋めない】'00:00' は「深夜0時開始」という読み取れた値で、サイトはそう表示する。
  // 読み取れなかったことを表せるのは空文字(表示は「—」)。既存618件のうち184件が同じ表現。
  assert.equal(kept[0].start, '', "読み取れなかった開始時刻を '00:00' で埋めてはいけない");
  assert.match(kept[0].id, /-nostart-/, 'idの時刻部分は nostart(空だと区切りが読めない)');
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
    fakeLibsFor(asCalendar([{ date: '2099-09-12', start: '19:00', name: 'NLH Tournament', buyin: 3000, tags: [] }], '2099-09'))
  );
  assert.match(result.summaries[0].dropped[0].reason, /既存エントリと id が衝突/);
  assert.equal(result.summaries[0].dropped[0].kind, 'existing-slot-conflict');
  assert.equal(result.summaries[0].droppedCount, 1, '衝突した1行だけが捨てられること');
  // 【衝突した行以外は巻き添えにしない】カレンダー1枚のうち1行が衝突しても、
  // 残りの行は取り込まれ、既存エントリは1バイトも変わらない。
  assert.deepEqual(
    result.arr.filter((t) => !isFiller(t)),
    [existing],
    '衝突した行は入らず、既存エントリはそのまま残ること'
  );
  assert.equal(result.arr.filter(isFiller).length, FILLER_COUNT, '衝突していない行は普通に取り込まれること');
  // 1件でも採用できているので、投稿としては「取り込めた」= 異常ではない
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.summaries[0].importedPostCount, 1);
});

test('runMonitor: 全行が人の日時訂正と衝突した投稿は、異常ではなく別のバケツに数える(PR #32)', async () => {
  // 【2026-08-01変更】この kind は「人が admin.html で日時を訂正した」ときにしか発生しない
  // (id が日時から作られるため)。人の訂正は正しく守られているのに、その投稿が
  // Apifyの取得窓に残る限り毎日赤くなる = 確実な空振りの赤。異常から外した。
  //
  // 【カレンダー化に伴う書き換え(2026-08-04)】1行だけの投稿はカレンダーと判定されず
  // 行の検査に到達しないので、カレンダー1枚の【全行】が人の訂正と衝突する形にした。
  // 既存側は「同じ id・違うスロット」= 人が admin.html で日時だけ直した状態を再現する。
  const rows = fillerRows('2099-09');
  const humanEdited = rows.map((r, i) => ({
    ...monitor.toTournament(r, 'v18'),
    date: `2099-09-0${i + 1}`, // 人が日付を直した = idと(date,start)がズレる
    start: '20:00',
    source: 'manual',
    verified: true,
  }));
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: humanEdited, today: '2026-07-31', state: {} },
    fakeLibsFor(rows)
  );
  assert.equal(result.summaries[0].droppedCount, rows.length, '全行が衝突すること(テストの前提)');
  for (const d of result.summaries[0].dropped) assert.equal(d.kind, 'existing-slot-conflict');
  assert.equal(result.anomalies.length, 0, '人の日時訂正による衝突は異常にしない(空振りの赤を作らない)');
  assert.equal(result.summaries[0].humanEditedPostCount, 1, '別のバケツとして数える');
  assert.equal(result.summaries[0].unusablePostCount, 0);
  assert.ok(monitor.checkPostAccounting(result.summaries[0]).ok, '保存則は保たれること');
  // 人の訂正は1バイトも変わっていない
  assert.deepEqual(result.arr, humanEdited);
  assert.equal(result.changed, false);
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

test('runMonitor: 店が同じ画像を再投稿しても異常(::error::)にならず、二重取り込みも起きない', async () => {
  // 【防ぎ方が変わった(2026-08-04)】以前は2件目の投稿の全行が「id重複」で捨てられ、
  // その投稿を「再投稿」と分類することで偽の ::error:: を避けていた。
  // 今は【1店につき最新のカレンダー1枚しか取り込まない】ので、そもそも2枚目に触らない。
  // 守りたい性質(偽の赤を出さない / 内容を二重に入れない / 内容を失わない)は変わっていない。
  const rows = [
    { date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '20:00', name: 'チューズデー', buyin: 3000, tags: [] },
  ];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForPosts([
      { permalink: 'https://www.instagram.com/p/FIRST/', postedAt: '2026-07-20T10:00:00.000Z', rows: asCalendar(rows, '2099-09') },
      // 同じ画像の再投稿(よくある)。抽出結果も当然同じになる
      {
        permalink: 'https://www.instagram.com/p/REPOST/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: asCalendar(rows.map((r) => ({ ...r })), '2099-09'),
      },
    ])
  );

  assert.equal(realRows(result.arr).length, 2, '同じ行が2回入っていないこと');
  assert.equal(result.arr.length, FILLER_COUNT + 2);
  assert.equal(result.anomalies.length, 0, '再投稿は異常ではない(何も失われていない)');
  const summary = result.summaries[0];
  assert.equal(summary.importedPostCount, 1, '取り込むのは最新の1枚だけ');
  assert.equal(summary.unexaminedPostCount, 1, '古い方は「未確認(採用後に打ち切り)」として数えられること');
  assert.equal(summary.unusablePostCount, 0);
  assert.equal(summary.droppedCount, 0, '2枚目に触らないので、id重複の破棄そのものが発生しない');
  assert.equal(
    summary.currentMonthCalendar.permalink,
    'https://www.instagram.com/p/REPOST/',
    '採用するのは【新しい方】(古い方を採ると訂正版を取り逃がす)'
  );
  // 状態ファイルからも「1枚だけ見て打ち切った」ことが読めること。
  // 【deepEqual のままにしてある】このオブジェクトはコミットされてgit履歴に残る記録なので、
  // 形を変えるときは意図的に気づけた方がよい(勝手にフィールドが増減しないことの固定)。
  assert.deepEqual(result.state.v18.lastExtraction, {
    checkedAt: '2026-07-31',
    posts: 2,
    kept: FILLER_COUNT + 2,
    dropped: 0,
    normalized: 0,
    unusablePosts: 0,
    reposts: 0,
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
    notCalendar: 0,
    pastCalendar: 0,
    unexamined: 1,
    cacheHit: 0,
    visionRows: FILLER_COUNT + 2,
    notAdoptedRows: 0,
    pastDated: 0,
    added: FILLER_COUNT + 2,
    updated: 0,
    unchanged: 0,
    protectedRows: 0,
    protectedFields: 0,
  });
  // 投稿レベル・行レベルの保存則がどちらも成り立っていること
  assert.ok(monitor.checkPostAccounting(summary).ok, `投稿の内訳が合わない: ${JSON.stringify(monitor.checkPostAccounting(summary))}`);
  assert.ok(monitor.checkRowAccounting(summary).ok, `行の内訳が合わない: ${JSON.stringify(monitor.checkRowAccounting(summary))}`);
});

test('★runMonitor: 「再投稿」の分類は打ち切りにより到達しなくなった(免除が誤って広がらないこと)', async () => {
  // 【元のテストが見ていたもの】「全行がid重複なら異常にしない」という免除を広げすぎると、
  // 本当に失われた行が異常として報告されなくなる。これは実際に潰した誤報の形だった。
  //
  // 【今の構造】1回の実行で1店から取り込むのは最新のカレンダー1枚だけ。
  // id重複(duplicate-in-run)は同じ1枚の中でしか起きず、重複した行の【1件目は必ず採用される】
  // ので「全行がid重複」は成立しない = repostedPostCount は構造的に0のまま。
  // 免除が広がると、この 0 が動く。ここが落ちたら「免除の条件」か「打ち切り」のどちらかが
  // 変わったということなので、どちらの意味で変えたのかを確認すること。
  const dupRows = FILLER_DAYS.flatMap((d) => {
    const row = { date: `2099-09-${d}`, start: '19:00', name: `マンデートナメ${d}日目`, buyin: 3000, tags: [] };
    return [row, { ...row }]; // Visionが同じ行を2回返す(1枚の画像の中での重複)
  });
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[2]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForPosts([{ permalink: 'https://www.instagram.com/p/DUP/', postedAt: '2026-07-20T10:00:00.000Z', rows: dupRows }])
  );
  const s = result.summaries[0];
  assert.equal(s.repostedPostCount, 0, '「再投稿」は到達しない分類になっている');
  assert.equal(s.importedPostCount, 1, '1件目が採用されるので、投稿としては「取り込めた」');
  assert.equal(s.droppedCount, FILLER_DAYS.length, '2件目はid重複として捨てられ、その事実は記録される');
  for (const d of s.dropped) assert.equal(d.kind, 'duplicate-in-run');
  assert.equal(result.anomalies.length, 0, '1件でも採用できていれば異常ではない');
  assert.ok(monitor.checkPostAccounting(s).ok);
  assert.ok(monitor.checkRowAccounting(s).ok);
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
    fakeLibsFor(asCalendar(rows, '2099-09'))
  );
  assert.equal(realRows(result.arr).length, 1);
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
    fakeLibsFor(asCalendar(rows, '2099-09'))
  );

  assert.equal(realRows(result.arr).length, 5, '1件も破棄されないこと');
  assert.equal(result.summaries[0].droppedCount, 0);
  assert.equal(result.summaries[0].normalizedCount, 5, '正規化されるのはテスト対象の5行だけ(埋め行は正規化されない)');

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
  for (const t of realRows(result.arr)) assert.match(t.id, /^ig-v18-2099-09-12-\d{4}-/, t.id);

  // 同日内は start の文字列比較で並ぶ。正規化前だと '19:00' < '7:30' < '9:00' となり順序が壊れる
  // (埋め行は別の日に置いてあるので、この並びには入ってこない)
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
    fakeLibsFor(asCalendar(rows, '2099-09'))
  );

  assert.equal(realRows(result.arr).length, 4, '金額が読めなくても大会そのものは残ること');
  assert.equal(result.summaries[0].droppedCount, 0);
  assert.equal(result.summaries[0].normalizedCount, 4, '正規化されるのはテスト対象の4行だけ');

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
    fakeLibsFor(asCalendar(rows, '2099-09'))
  );
  assert.deepEqual(result.state.v40.lastExtraction, {
    checkedAt: '2026-07-31',
    posts: 1,
    kept: FILLER_COUNT + 1,
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
    // 【走査フェーズの行き先】これが無いと「新着N件・取込み0件」の理由が git履歴に残らない
    notCalendar: 0,
    pastCalendar: 0,
    unexamined: 0,
    cacheHit: 0,
    visionRows: FILLER_COUNT + 2,
    notAdoptedRows: 0,
    pastDated: 0,
    added: FILLER_COUNT + 1,
    updated: 0,
    unchanged: 0,
    protectedRows: 0,
    protectedFields: 0,
  });

  // 新着そのものが無かった回は前回値を持ち越す
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

test('runMonitor: カレンダーではない投稿(単発の告知など)は取り込まず、data.jsは変化しない(状態のみ進む)', async () => {
  // 【判定の場所が変わった(2026-08-04)】以前はキャプションのキーワードで画像を見る前に落として
  // いたが、キャプションが空の投稿には構造的に届かなかった(v40は12投稿すべてがこれで、
  // Vision に1度も渡っていなかった)。今は【画像を読んでから、読めた結果の構造で】判定する。
  // つまり Vision は呼ばれる。呼ばれたうえで「カレンダーではない」として取り込まないことを見る。
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
  let visionCalled = 0;
  const fakeVisionLib = {
    async extractTournaments() {
      visionCalled += 1;
      // 単発の大会告知。日付は正しいが1〜2日ぶんしかない = カレンダーではない
      return [
        { date: '2099-01-10', start: '19:00', name: '単発の特別トナメ', buyin: 3000, tags: [] },
        { date: '2099-01-11', start: '19:00', name: '単発の特別トナメDay2', buyin: 3000, tags: [] },
      ];
    },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before, today: '2026-07-31', state: {} },
    { fetchLib: fakeFetchLib, visionLib: fakeVisionLib, mergeLib, downloadImage: async () => Buffer.from('x') }
  );
  assert.equal(visionCalled, 1, '画像は読む(キャプションで事前に落とさない)');
  assert.equal(result.summaries[0].notCalendarPostCount, 1, 'カレンダーでない投稿として数えられること');
  assert.equal(result.changed, false);
  assert.deepEqual(result.arr, before, 'カレンダーでない投稿の行を1件も取り込まないこと');
  // 状態は「確認済み」まで進む(同じ投稿を毎回新着扱いし続けないため)
  assert.equal(result.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');
  // 判定結果はキャッシュされ、次回この投稿を再びVisionに渡さない
  assert.equal(result.state.v40.checkedPosts['https://www.instagram.com/p/NOSCHED/'], 'not-calendar');
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
      visionLib: {
        async extractTournaments() {
          return asCalendar([{ date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] }], '2099-09');
        },
      },
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

function makeTempRepoRoot(extraTournaments = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-instagram-apify-cli-'));
  fs.mkdirSync(path.join(root, 'tools'));
  for (const f of [
    'monitor-instagram-apify.js',
    'tournament-merge.js',
    'venue-schedule-vision.js',
    'validate-data.js',
    // 「機械が最後に書いた値」の控えと所有判定。tournament-merge.js が require するので必須。
    'machine-write-state.js',
    // 書き込み直前の最終自己チェック。monitor-instagram-apify.js が require するので必須。
    // 【★require を足したらここも足すこと★】足し忘れると全CLIテストが
    //   「Cannot find module」で終了コード1になり、落ち方が原因を示さない。
    'schedule-write-guard.js',
    // 店ごとの掲載ルール(社長指示)。monitor-instagram-apify.js が require するので必須。
    'venue-listing-rules.js',
  ]) {
    fs.copyFileSync(path.join(TOOLS_DIR, f), path.join(root, 'tools', f));
  }
  const tournaments = [
    { id: 'other-1', venueId: 'v99', name: '対象外店舗(触ってはいけない)', date: '2099-01-01', start: '19:00', buyin: 0, addon: null, stack: 0, guarantee: null, reentry: false, prize: null, tags: [], source: 'manual', verified: true },
    ...extraTournaments,
  ];
  fs.writeFileSync(
    path.join(root, 'data.js'),
    `const VENUES = [];\nconst TOURNAMENTS = ${JSON.stringify(tournaments, null, 2)};\nconst AREAS = [];\n` +
      'if (typeof module !== "undefined") { module.exports = { VENUES, TOURNAMENTS, AREAS }; }\n'
  );
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), '{}\n');
  return root;
}

/**
 * CLIテスト用の Vision スタブ(常にカレンダー1枚を返す)のソースを作る。
 * 【1行だけ返すスタブは使えない】カレンダーと判定されず、取込みの経路を1本も通らないため。
 */
function calendarVisionStubSource(name, month = '2099-09') {
  const rows = asCalendar([{ date: `${month}-12`, start: '19:00', name, buyin: 3000, tags: [] }], month);
  return `exports.extractTournaments = async () => (${JSON.stringify(rows)});\n`;
}

/** カレンダーだが全行が捨てられる(=投稿まるごと不採用になる)スタブ用の行。 */
function unusableCalendarRows(namePrefix, month = '2099-09') {
  return FILLER_DAYS.map((d) => ({
    date: `${month}-${String(d).padStart(2, '0')}`,
    start: '25:00', // 範囲外の時刻 → 行としては採用できない
    name: `${namePrefix}${d}`,
    buyin: 1000,
    tags: [],
  }));
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
  // v18 = カレンダーだが全行が捨てられる(1行も採用できない投稿)
  // v40 = カレンダーの中に1行だけ日付書式が壊れた行が混ざる
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const IRIS = ${JSON.stringify(unusableCalendarRows('IRIS不正行', '2099-01'))};
     const ORIO = ${JSON.stringify(
       asCalendar(
         [
           { date: '2099-01-01', start: '19:00', name: '取り込まれる大会', buyin: 1000, tags: [] },
           { date: '9/5', start: '20:00', name: '捨てられる大会', buyin: 1000, tags: [] },
         ],
         '2099-01'
       )
     )};
     exports.extractTournaments = async (buf) => {
      if (String(buf).includes('pokerbar_iris')) return IRIS;
      return ORIO;
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
    assert.equal(/IRIS不正行/.test(dataJs), false);
    assert.equal(/"9\/5"/.test(dataJs), false);
    assert.equal(/25:00/.test(dataJs), false, '範囲外の開始時刻を書き込んではいけない');

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
    `const BADTIME = ${JSON.stringify(unusableCalendarRows('範囲外の時刻', '2099-01'))};
     const ORIO = ${JSON.stringify(
       asCalendar(
         [
           { date: '2099-01-05', start: '9:00', name: 'Morning', buyin: '3,500', tags: [] },
           { date: '2099-01-05', start: '7:30', name: 'EarlyBird', buyin: '5000円', tags: [] },
           { date: '2099-01-05', start: '19：00', name: 'Night', buyin: 3000, tags: [] },
           { date: '2099-01-05', start: '１２：００', name: 'Lunch', buyin: 3000, tags: [] },
         ],
         '2099-01'
       )
     )};
     exports.extractTournaments = async (buf) => {
      if (String(buf).includes('badtime')) return BADTIME;
      // FIRST と REPOST は同じ画像なので同じ抽出結果になる
      return ORIO;
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
    const imported = arr.filter((t) => t.venueId === 'v40' && t.date === '2099-01-05');
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

    // 再投稿は異常ではない。【新しい方だけを採用し、古い方には触らない】
    assert.match(r.stdout, /★採用/);
    assert.match(r.stdout, /https:\/\/www\.instagram\.com\/p\/REPOST\//);
    assert.equal(/https:\/\/www\.instagram\.com\/p\/FIRST\/.*★採用/.test(r.stdout), false, '古い方を採用してはいけない');

    // 本物の異常(範囲外の時刻で1行も採用できなかった v18)だけが ::error:: として上がる
    assert.match(r.stdout, /::error title=/);
    assert.equal((r.stdout.match(/::error title=/g) || []).length, 1);
    assert.match(r.stdout, /投稿まるごと不採用: 店=Poker Bar IRIS\(v18\)/);
    assert.equal(/投稿まるごと不採用: 店=TripleBarrel/.test(r.stdout), false, '再投稿を不採用として報告しないこと');

    // 状態ファイルから「2枚あったが1枚だけ見て打ち切った」ことが読める
    const state = JSON.parse(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'));
    assert.equal(state.v40.lastExtraction.newPosts, 2);
    assert.equal(state.v40.lastExtraction.importedPosts, 1);
    assert.equal(state.v40.lastExtraction.unexamined, 1, '古い方は未確認として記録されること');
    assert.equal(state.v40.lastExtraction.reposts, 0);
    assert.equal(state.v40.lastExtraction.unusablePosts, 0);
    // 正規化は「行」単位で数える(破棄した抽出行と同じ単位)。採用した1投稿の4行ぶん
    assert.equal(state.v40.lastExtraction.normalized, 4);
    assert.equal(state.v18.lastExtraction.unusablePosts, 1);

    // 書き込んだ data.js はコミット前ゲート(層1)も通る形(件数の下限だけは別途除外)
    const validate = spawnSync('node', [path.join(TOOLS_DIR, 'validate-data.js'), root], { encoding: 'utf8' });
    assert.equal(/日付が YYYY-MM-DD/.test(validate.stderr), false, validate.stderr);
    assert.equal(/id が重複/.test(validate.stderr), false, validate.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★CLI: 「新着が無かった店」と「カレンダーが見つからなかった店」を同じ0にしない', () => {
  // 【この案件が繰り返し潰してきた誤報の形】0が並ぶだけで正常運転に見えるのが最も危ない。
  // 新着0件の店は【1枚も判定していない】ので、「カレンダーなし」と書いてはいけない。
  // 混ぜると「6店中5店でカレンダーが見つからない = 判定が厳しすぎる」と誤読し、
  // 閾値を根拠なく緩める判断につながる(実際に緩めると単発告知まで取り込む)。
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return []; // 他5店は新着なし
       return [{ permalink: 'https://www.instagram.com/p/X/', imageUrl: 'https://example.com/x.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '' }];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    "exports.extractTournaments = async () => ([{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }]);\n"
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
    assert.equal(r.status, 0, r.stderr);
    // 新着があってカレンダーが無かった店(1店)
    assert.match(r.stdout, /当月カレンダー: なし \(取得できた投稿の中にカレンダーが見つかりませんでした\)/);
    // 新着が無かった店(残り5店)は「なし」ではなく「未判定」と出る
    assert.equal(
      (r.stdout.match(/当月カレンダー: 今回は判定していません\(新着なし\)/g) || []).length,
      monitor.STORES.length - 1
    );
    // 合計でも3つを分けて出す
    assert.match(r.stdout, new RegExp(`当月カレンダー: あり 0店 / なし 1店 / 新着なしで未判定 ${monitor.STORES.length - 1}店`));
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

test('保存則(投稿): 8通りの結末が同時に起きても、すべての投稿がちょうど1つに数えられる', async () => {
  // 【結末の種類が増えた(2026-08-04)】走査フェーズの導入で「カレンダーでない」
  // 「過去月のカレンダー」「判定済み(キャッシュ)」「未確認(採用後に打ち切り)」が加わり、
  // 「再投稿」は到達しなくなった。保存則の意味は変わらない —
  // 【新着の1投稿は必ずどれか1つに数えられる】。9本目の経路が生まれたらここが落ちる。
  const result = await monitor.runMonitor(
    {
      stores: [monitor.STORES[0]],
      before: [],
      today: '2026-07-31',
      state: {
        v40: {
          handle: 'triple_orio',
          lastPostedAt: '2026-07-18T00:00:00.000Z',
          // 前回すでに「カレンダーでない」と判定済みの投稿(二度とVisionに渡さない)
          checkedPosts: { 'https://www.instagram.com/p/CACHED/': 'not-calendar' },
        },
      },
    },
    fakeLibsForBehaviour([
      // 【走査は新しい順】採用した投稿より古いものは見に行かない = 未確認
      { permalink: 'https://www.instagram.com/p/UNEXAMINED/', postedAt: '2026-07-19T10:00:00.000Z', rows: [] },
      // 1. 取り込めた(当月以降のカレンダー。ここで打ち切る)
      { permalink: 'https://www.instagram.com/p/OK/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
      // 2. 過去月のカレンダー(採用しないが走査は続ける)
      { permalink: 'https://www.instagram.com/p/PAST/', postedAt: '2026-07-21T10:00:00.000Z', rows: fillerRows('2026-05') },
      // 3. カレンダーでない(日付が少なく広がりも無い)
      {
        permalink: 'https://www.instagram.com/p/NOTCAL/',
        postedAt: '2026-07-22T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }],
      },
      // 4. Visionが0件
      { permalink: 'https://www.instagram.com/p/EMPTY/', postedAt: '2026-07-23T10:00:00.000Z', rows: [] },
      // 5. 判定済み(キャッシュ)= Visionに渡さない
      { permalink: 'https://www.instagram.com/p/CACHED/', postedAt: '2026-07-24T10:00:00.000Z', rows: fillerRows('2099-09') },
      // 6. Vision抽出失敗
      { permalink: 'https://www.instagram.com/p/VF/', postedAt: '2026-07-25T10:00:00.000Z', visionThrows: 'max_tokensで打ち切られました' },
      // 7. 画像ダウンロード失敗
      { permalink: 'https://www.instagram.com/p/IF/', postedAt: '2026-07-26T10:00:00.000Z', downloadThrows: 'HTTP 404' },
    ])
  );

  const s = result.summaries[0];
  assert.equal(s.scheduleLikeCount, 8);
  assert.equal(s.importedPostCount, 1);
  assert.equal(s.pastCalendarPostCount, 1);
  assert.equal(s.notCalendarPostCount, 1);
  assert.equal(s.emptyResultCount, 1);
  assert.equal(s.cacheHitCount, 1);
  assert.equal(s.visionFailedCount, 1);
  assert.equal(s.imageFailedCount, 1);
  assert.equal(s.unexaminedPostCount, 1);
  // 【件数と明細を同じ場所から数える】未確認を「総数 − 確認済み」のような残差で出すと、
  // 数え漏らした投稿がこの項に吸い込まれて保存則が恒等式になる(この案件で4回踏んだ罠)。
  // 実際に「未確認」と記録された明細の行数と一致することを、件数とは別に見る。
  assert.equal(
    s.posts.filter((p) => p.outcome === '未確認(採用後に打ち切り)').length,
    s.unexaminedPostCount,
    '未確認の件数と、明細に「未確認」と出ている行数が食い違ってはいけない'
  );
  assert.equal(s.repostedPostCount, 0, '「再投稿」は打ち切りにより到達しない分類');
  assert.equal(s.unusablePostCount, 0);
  // 【キャッシュに当たった投稿と画像DLに失敗した投稿はVisionに渡っていない】
  assert.equal(s.examinedPostCount, 5, 'Visionを呼んだのは OK/PAST/NOTCAL/EMPTY/VF の5件だけ');
  // 採用したのは【新しい順に走査して最初に見つかった当月以降のカレンダー】
  assert.equal(s.currentMonthCalendar.permalink, 'https://www.instagram.com/p/OK/');
  assert.equal(s.latestPastCalendar.month, '2026-05', '過去月のカレンダーは記録だけして走査を続ける');

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
        rows: asCalendar(
          [
            { date: '2099-09-12', start: '19:00', name: '未来の大会', buyin: 3000, tags: [] }, // 追加
            { date: '2020-01-01', start: '19:00', name: '過去の大会', buyin: 3000, tags: [] }, // 過去日
            { date: '2099-9-14', start: '19:00', name: '日付不正', buyin: 3000, tags: [] }, // 破棄
          ],
          '2099-09'
        ),
      },
    ])
  );
  const s = result.summaries[0];
  const row = monitor.checkRowAccounting(s);
  assert.equal(row.rows, FILLER_COUNT + 3, 'Visionが返した行の総数');
  assert.equal(row.added, FILLER_COUNT + 1);
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

test('保存則(行): 2回目の取込みは、変わった行だけが「更新」に入る', async () => {
  // 【★数え方が変わった(2026-08-04)。dry-runの数字を読むときに必要】
  // 以前は「source:'semi' は手入力扱い」だったため、内容が1文字も変わっていない行まで
  // すべて updated に入り、「変更なし」は構造的に0のままだった。
  // いまは【控えと突き合わせて同じidの行を素直に比べる】ので、
  // 内容が同じ行は unchanged、変わった行だけが updated になる。数字の意味が正確になった。
  // 保存則(残余0)はどちらに数えられても成り立つので、ここで固定するのは残余0の方。
  //
  // 【★controls を渡すこと(2026-08-04)】この経路が自分の行を更新できるのは
  // 【機械が最後に書いた値の控え】がある場合だけ。本番では main() が
  // instagram-write-state.json から読んで渡す。テストでも同じように前回の written を渡す。
  // 渡さない場合の挙動は次のテストで固定してある(=人の行として守られる)。
  const rows = [
    { date: '2099-09-12', start: '19:00', name: '大会A', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '19:00', name: '大会B', buyin: 3000, tags: [] },
  ];
  const first = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/A/', postedAt: '2026-07-20T10:00:00.000Z', rows: asCalendar(rows, '2099-09') },
    ])
  );
  assert.equal(monitor.checkRowAccounting(first.summaries[0]).added, FILLER_COUNT + 2);

  // 同じ内容 + 1件だけ金額が変わったものを、別の投稿として再取込み
  const second = await monitor.runMonitor(
    {
      stores: [monitor.STORES[0]],
      before: first.arr,
      today: '2026-07-31',
      state: {},
      writeRecords: first.written, // 前回の実行が控えた「機械が書いた値」
    },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/B/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: asCalendar([{ ...rows[0] }, { ...rows[1], buyin: 5000 }], '2099-09'),
      },
    ])
  );
  const row = monitor.checkRowAccounting(second.summaries[0]);
  assert.equal(row.rows, FILLER_COUNT + 2);
  assert.equal(row.added, 0, '既存と同じidなので追加ではない');
  assert.equal(row.updated, 1, '★内容が変わった1行(大会Bの参加費)だけが「更新」に入ること');
  assert.equal(row.unchanged, FILLER_COUNT + 1, '内容が同じ行は「変更なし」に入ること');
  assert.equal(row.protected, 0, '自分が書いた行なので守る対象ではない');
  assert.equal(row.residual, 0, '数え方がどちらでも、残余は0でなければならない');
  assert.ok(row.ok);
  const changed = second.arr.find((t) => t.name === '大会B');
  assert.equal(changed.buyin, 5000, '★控えがある行はちゃんと新しい値に更新されること(取込みが止まらない)');
});

test('★保存則(行): 控えが無い行(=人の行)と同じ枠に来た行は「守って見送り」に入り、残余は出ない', async () => {
  // 【この案件の本体】dry-run #5 では、人が入力した39件がここで機械の読み取りに置き換わった。
  // いまは書かずに見送る。★見送りは「その場で +1」しており、
  // `Visionが返した行 - 書いた数` のような残差ではないので、この保存則は恒等式にならない。
  const rows = [
    { date: '2099-09-12', start: '19:00', name: '大会A', buyin: 3000, tags: [] },
    { date: '2099-09-13', start: '19:00', name: '大会B', buyin: 3000, tags: [] },
  ];
  const first = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/A/', postedAt: '2026-07-20T10:00:00.000Z', rows: asCalendar(rows, '2099-09') },
    ])
  );
  const before = JSON.parse(JSON.stringify(first.arr));

  // 控えを【渡さない】= 状態ファイルを失った / これらの行を人が入れた、と同じ状況。
  const second = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: first.arr, today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/B/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: asCalendar([{ ...rows[0] }, { ...rows[1], buyin: 5000 }], '2099-09'),
      },
    ])
  );
  const row = monitor.checkRowAccounting(second.summaries[0]);
  assert.equal(row.protected, FILLER_COUNT + 2, '全行が「守って見送り」に入ること');
  assert.equal(row.updated, 0);
  assert.equal(row.added, 0);
  assert.equal(row.residual, 0, '★残余が出ないこと(見送りが保存則の項として数えられている)');
  assert.ok(row.ok);
  assert.deepEqual(second.arr, before, '既存の行は1バイトも変わらないこと');
  assert.equal(
    second.summaries[0].protectedRows.length,
    FILLER_COUNT + 2,
    '明細に「何を書かなかったか」が残ること'
  );
});

// ============================================================
// カレンダー判定で対象外にした投稿(画像は読むが取り込まない経路)
// ============================================================
// 【4本目の経路の置き換え(2026-08-04)】以前ここには「キーワードに当たらない投稿を
// 画像を1度も見ずに捨てる」経路があった。キャプションが空の投稿には構造的に届かず、
// v40は12投稿すべてがこの経路で消えていた(Vision に一度も渡っていなかった)ため廃止した。
// 今は画像を読んだうえで【読めた結果の構造】で対象外にする。
// 「静かに捨てない」という要求は変わらないので、件数とログはこの経路でも必ず出す。

test('カレンダー判定: 対象外にした投稿は件数に数えられ、判定に使った数値がログに出る', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let result;
  try {
    result = await monitor.runMonitor(
      { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
      fakeLibsForBehaviour([
        // 【古い方をカレンダーにする】走査は新しい順で、当月以降のカレンダーを見つけたら
        // 打ち切るので、カレンダーを新しい方に置くと対象外の投稿が「未確認」になり判定されない。
        { permalink: 'https://www.instagram.com/p/CAL/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
        {
          permalink: 'https://www.instagram.com/p/NOTCAL/',
          postedAt: '2026-07-21T10:00:00.000Z',
          rows: [
            { date: '2099-09-12', start: '19:00', name: '単発トナメDay1', buyin: 3000, tags: [] },
            { date: '2099-09-13', start: '19:00', name: '単発トナメDay2', buyin: 3000, tags: [] },
          ],
        },
      ])
    );
  } finally {
    console.log = orig;
  }
  const s = result.summaries[0];
  assert.equal(s.newPostCount, 2);
  assert.equal(s.scheduleLikeCount, 2, 'キャプションで事前に絞らないので、新着はすべて判定の対象になる');
  assert.equal(s.filteredOutCount, 0, '画像を見ずに捨てる経路はもう無い');
  assert.equal(s.notCalendarPostCount, 1, '対象外にした件数が数えられていること');
  assert.equal(s.importedPostCount, 1);

  const verdict = lines.find((l) => l.includes('/NOTCAL/'));
  assert.ok(verdict, '対象外にした投稿が1行としてログに出ること(出ないと閾値を実測で直せない)');
  assert.match(verdict, /異なる日付=2/, '判定に使った値がそのまま読めること');
  assert.match(verdict, /広がり=1日/);
  assert.match(verdict, /カレンダーではない/);
});

test('★キャッシュ: 判定できた投稿だけを記録し、画像DL失敗・Vision抽出失敗は載せない', async () => {
  // 【失敗をキャッシュすると永久に固定される】キャッシュは「二度とVisionに渡さない」ための
  // 記録なので、失敗した投稿を載せると【次回以降やり直す機会が永久に失われる】。
  // 失敗は一時的な原因(タイムアウト・max_tokens・画像URLの期限切れ)であることが多く、
  // やり直せば取れることが多い。ここが落ちたら、キャッシュに何を載せるかが変わったということ。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/VF/', postedAt: '2026-07-20T10:00:00.000Z', visionThrows: '打ち切り' },
      { permalink: 'https://www.instagram.com/p/IF/', postedAt: '2026-07-21T10:00:00.000Z', downloadThrows: 'HTTP 404' },
      {
        permalink: 'https://www.instagram.com/p/NOTCAL/',
        postedAt: '2026-07-22T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }],
      },
    ])
  );
  const cached = result.state.v40.checkedPosts;
  assert.deepEqual(Object.keys(cached), ['https://www.instagram.com/p/NOTCAL/'], '判定できた投稿だけが載ること');
  assert.equal(cached['https://www.instagram.com/p/VF/'], undefined, 'Vision抽出失敗を載せると永久に再試行されない');
  assert.equal(cached['https://www.instagram.com/p/IF/'], undefined, '画像DL失敗を載せると永久に再試行されない');
});

test('★キャッシュ: Vision抽出0件は「判定できた」側に入れている(現状の固定・要判断)', async () => {
  // 【この扱いには緊張がある】Vision が0件を返すのは
  //   (a) 日程を含まない投稿だった(正常) と (b) 日程表なのに読めなかった(消失)
  // のどちらでも起こり、機械には区別できない(emptyCaveat がまさにそう言っている)。
  // それをキャッシュする = (b) のとき【二度と読み直さない】ということ。
  // 一方で、キャッシュしなければ (a) の投稿を毎回 Vision に渡し続けて費用が減らない。
  //
  // 現状は「キャッシュする」を選んでいる。ここではその選択を明示的に固定するだけで、
  // 正しさを主張していない。変えるときは「0件を毎回読み直す費用」と
  // 「読めなかった日程表を取り逃がす確率」を比べて、意図して変えること。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([{ permalink: 'https://www.instagram.com/p/EMPTY/', postedAt: '2026-07-20T10:00:00.000Z', rows: [] }])
  );
  assert.equal(result.state.v40.checkedPosts['https://www.instagram.com/p/EMPTY/'], 'empty');
});

test('★キャッシュ: 判定済みの投稿はVisionに渡さない(費用が新着の数に比例する)', async () => {
  let visionCalls = 0;
  const libs = fakeLibsForBehaviour([
    {
      permalink: 'https://www.instagram.com/p/SEEN/',
      postedAt: '2026-07-20T10:00:00.000Z',
      rows: [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }],
    },
  ]);
  const counting = {
    ...libs,
    visionLib: {
      async extractTournaments(...args) {
        visionCalls += 1;
        return libs.visionLib.extractTournaments(...args);
      },
    },
  };
  const state = {
    v40: {
      handle: 'triple_orio',
      lastPostedAt: '2026-07-19T00:00:00.000Z',
      checkedPosts: { 'https://www.instagram.com/p/SEEN/': 'not-calendar' },
    },
  };
  const result = await monitor.runMonitor({ stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state }, counting);
  assert.equal(visionCalls, 0, '判定済みの投稿を再びVisionに渡してはいけない');
  assert.equal(result.summaries[0].cacheHitCount, 1);
  assert.equal(result.summaries[0].examinedPostCount, 0);
  // 前回の判定結果は次の状態にも引き継がれる(1回で消えない)
  assert.equal(result.state.v40.checkedPosts['https://www.instagram.com/p/SEEN/'], 'not-calendar');
});

test('formatCalendarVerdict: 判定に使った数値と投稿URLが1行に出る(キャプション本文は出さない)', () => {
  const line = monitor.formatCalendarVerdict(
    { venueId: 'v40', label: 'TripleBarrel 折尾店' },
    {
      permalink: 'https://www.instagram.com/p/ABC/',
      postedAt: '2026-07-20T10:00:00.000Z',
      caption: '優勝は山田太郎さんでした!連絡先 090-1234-5678',
    },
    { dominantMonth: '2026-08', distinctDates: 28, spanDays: 30 },
    '★採用(2026-08のカレンダー)'
  );
  assert.match(line, /TripleBarrel 折尾店\(v40\)/);
  assert.match(line, /https:\/\/www\.instagram\.com\/p\/ABC\//);
  assert.match(line, /支配月=2026-08/);
  assert.match(line, /異なる日付=28/);
  assert.match(line, /広がり=30日/);
  // 【公開ログなのでキャプション本文は出さない】この経路は【全投稿】が通るため、
  // 旧経路(キーワード不一致で落ちた投稿だけ)より更に広く本文を集めてしまう。
  // 【断片まで走査する】部分的な漏洩(冒頭N字だけ出す等)を取り逃がさないため、
  // 廃止した formatFilteredOutPost のテストが持っていた2文字断片の走査をここに引き継ぐ。
  const caption = '優勝は山田太郎さんでした!連絡先 090-1234-5678';
  const chars = [...caption];
  let checked = 0;
  for (let i = 0; i + 2 <= chars.length; i++) {
    const gram = chars.slice(i, i + 2).join('');
    if (/^\s*$/.test(gram)) continue;
    checked += 1;
    assert.ok(!line.includes(gram), `キャプションの断片が漏れている: ${JSON.stringify(gram)}`);
  }
  assert.ok(checked >= 20, `走査した断片が少なすぎる(${checked}通り)`);
  assert.doesNotMatch(line, /\n/, '改行を潰してログが崩れないようにすること');
});

test('★キャプションは実装のどこからも参照されない(公開ログへの複製経路を構造的に無くす)', () => {
  // 【関数単位のテストだけでは足りない】formatCalendarVerdict が本文を出さないことを
  // 確かめても、【別の行が出す】変更は素通りする(実際、過去の走査で
  // 「Vision 0件のログ行に本文を出す」変異だけが生き残った)。
  // キーワード判定の廃止でキャプションを読む理由が無くなったので、
  // 【そもそも参照が1つも無い】ことをソースに対して直接固定する。
  // ここが落ちたら、キャプションを読むコードが復活したということ。
  // 本当に必要なら、公開ログに何が出るかを上のような断片走査つきで必ず確認すること。
  const src = fs.readFileSync(path.join(__dirname, 'monitor-instagram-apify.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '') // ブロックコメントを除く(経緯の説明で語そのものは出てくる)
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bcaption\b/, 'キャプションを参照するコードが復活している');
});

test('calendarShape: 支配月・異なる日付・広がりを、閾値の境界で正しく判定する', () => {
  const rows = (dates) => dates.map((d) => ({ date: d, start: '19:00', name: 'x' }));
  // 【境界】異なる日付がちょうど MIN_CALENDAR_DATES、広がりがちょうど MIN_CALENDAR_SPAN_DAYS
  const justEnough = rows(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-11']);
  assert.equal(monitor.calendarShape(justEnough).distinctDates, monitor.MIN_CALENDAR_DATES);
  assert.equal(monitor.calendarShape(justEnough).spanDays, monitor.MIN_CALENDAR_SPAN_DAYS);
  assert.equal(monitor.calendarShape(justEnough).isCalendar, true);
  // 日付が1つ足りない
  assert.equal(monitor.calendarShape(rows(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-11'])).isCalendar, false);
  // 広がりが1日足りない(日付の数は足りている)
  assert.equal(
    monitor.calendarShape(rows(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-10'])).isCalendar,
    false
  );
  // 同じ日が何行あっても「異なる日付」は増えない(1日に大会が並ぶ告知をカレンダーにしない)
  assert.equal(monitor.calendarShape(rows(Array(30).fill('2026-08-01'))).distinctDates, 1);
  assert.equal(monitor.calendarShape(rows(Array(30).fill('2026-08-01'))).isCalendar, false);
  // 書式が正しくない日付は判定の材料にしない
  assert.equal(monitor.calendarShape(rows(['2026-8-1', '2026-8-2', '2026-8-3', '2026-8-4', '2026-8-15'])).isCalendar, false);
  assert.deepEqual(monitor.calendarShape([]), { dominantMonth: null, distinctDates: 0, spanDays: 0, isCalendar: false });
});

test('calendarShape: 月をまたぐカレンダーでも支配月が1つに決まる(実在する形)', () => {
  // dry-run #5 で実在した形: v18 の 2026-05-31〜07-03 / v34 の 2026-03-02〜04-04。
  // 端が数日はみ出すだけなので、支配月(日付が最も多い月)は真ん中の月になる。
  const june = Array.from({ length: 20 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}` }));
  const rows = [{ date: '2026-05-31' }, ...june, { date: '2026-07-01' }, { date: '2026-07-03' }];
  const shape = monitor.calendarShape(rows);
  assert.equal(shape.dominantMonth, '2026-06');
  assert.equal(shape.distinctDates, 20, '支配月の日付だけを数えること(はみ出したぶんを混ぜない)');
  assert.equal(shape.isCalendar, true);
});

// ============================================================
// 保存則の【検知側】が本当に働くか
// ============================================================
// 【なぜ別に要るか】上の保存則テストは「健全な入力に対して ok が true になること」しか
// 見ていない。それだと `ok: actual === expected` を `ok: true` に潰す変異が生き残り、
// 「7本目の経路が生まれたら落ちる」という主張の根拠が fixture 頼みになる。
// 壊れた入力に対して【偽になること】と、その結果【::error:: が実際に出ること】を固定する。

/** 投稿レベルの内訳(全バケツ0)。テストでは動かしたいバケツだけ上書きする。 */
function emptyPostBuckets() {
  return {
    scheduleLikeCount: 0,
    importedPostCount: 0,
    repostedPostCount: 0,
    notATournamentPostCount: 0,
    humanEditedPostCount: 0,
    unusablePostCount: 0,
    visionFailedCount: 0,
    imageFailedCount: 0,
    emptyResultCount: 0,
    notCalendarPostCount: 0,
    pastCalendarPostCount: 0,
    unexaminedPostCount: 0,
    cacheHitCount: 0,
    // 探索モード(--probe)でだけ動くバケツ。本番では常に0だが、保存則の項なのでここにも要る
    // (足し忘れると合計が NaN になり、全店・毎回「集計が合わない」と誤報する)。
    probeCalendarPostCount: 0,
    // 全行が【店ごとの掲載ルール】で除外された投稿。平常は0のまま動かないが、
    // これが無いとその投稿が「全行不採用」= ::error:: に落ちて空振りの赤になる。
    venueRuleOnlyPostCount: 0,
  };
}

// ---------- producer(実装が作る summary)と checker の接続 ----------
// 【なぜこの2本が要るか(2026-08-04)】
// 上の検知テストはどれも【テストが手で組み立てた summary】を checker に渡している。
// そのため「実装が summary に項を入れ忘れた」種類のバグは、検知テストが全部緑のまま通る。
// 実際そうなった: 走査フェーズのカウンタを summary に写し忘れ、合計が NaN になり
// 【全店・毎回「投稿の集計が合わない」と誤報する】状態でPRが渡ってきた。
// しかもそのとき同時に fixture 起因の失敗が53件あったため、
// 【fixtureが古いだけの失敗】と【実装のバグ】が見分けられなかった。
// ここは fixture を1件も使わない。落ちたら原因は実装以外にありえない。

test('★保存則: 実装が作った summary をそのまま checker に通す(fixtureを使わない)', async () => {
  // 新着0件の店 = summary は makeStoreSummary の初期値そのまま。
  // Vision も画像DLも1度も呼ばれないので、抽出結果の fixture という概念が存在しない。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    {
      fetchLib: { async fetchInstagramPosts() { return []; } },
      visionLib: { async extractTournaments() { throw new Error('呼ばれてはいけない'); } },
      mergeLib,
      downloadImage: async () => { throw new Error('呼ばれてはいけない'); },
    }
  );
  const s = result.summaries[0];
  for (const [name, acc] of [
    ['投稿', monitor.checkPostAccounting(s)],
    ['行', monitor.checkRowAccounting(s)],
    ['取込み', monitor.checkIntakeAccounting(s)],
  ]) {
    // 【NaN を名指しで捕まえる】summary に項が1つでも欠けると合計が NaN になる。
    // NaN === 期待値 は常に偽なので「集計が合わない」と毎回誤報するが、
    // ok を見るだけだと「合わないこと自体が正しい検知」と読めてしまい区別が付かない。
    const actual = name === '行' ? acc.rows - acc.residual : acc.actual;
    assert.ok(
      Number.isFinite(actual),
      `${name}レベルの内訳の合計が数値になっていない(summary に項の入れ忘れがある): ${JSON.stringify(acc)}`
    );
    assert.ok(acc.ok, `何も観測していない店では 0 = 0 で成立するはず: ${JSON.stringify(acc)}`);
  }
  assert.equal(monitor.checkPostAccounting(s).actual, 0);
});

/**
 * checker が実際に読む summary の項名を Proxy で観測して集める。
 * 【手で書き写さない理由】書き写した一覧は、実装にバケツが増えたとき黙って古くなる。
 * それが上のバグの起き方そのものなので、一覧は実装に聞く。
 *
 * 【★Proxy は spread / `Object.keys` / `in` を観測できない(2026-08-04・品質管理部の申し送り)】
 * checker がそれらの読み方に変わると、この関数は項名を1つも拾えず観測は空振りする。
 * **その観測漏れを受け止めているのは下の (b) のキー集合一致(`deepEqual`)なので、(b) は冗長ではない。**
 * 実測でも、Proxy不可視な読み方に変える変異(R3/R4)を撃墜していたのは Proxy ではなく (b) だった。
 * 「Proxyで観測しているのだから (b) は要らない」と削ると、この検査は静かに空振りする。
 */
function fieldsReadBy(check) {
  const read = new Set();
  check(
    new Proxy(
      {},
      {
        get(_, k) {
          if (typeof k !== 'string') return undefined;
          read.add(k);
          return 0;
        },
      }
    )
  );
  return read;
}

test('★保存則(投稿): checker が読む項が、実装の summary とテスト側の初期値の両方に揃っている', async () => {
  const buckets = [...fieldsReadBy(monitor.checkPostAccounting)].filter((k) => k !== 'scheduleLikeCount');
  assert.ok(buckets.length >= 10, `バケツが少なすぎる(観測できていない可能性): ${buckets.join(',')}`);

  // (a) 実装が作る summary に全部あり、すべて有限の数値であること
  //     = makeStoreSummary の初期化漏れ(バグ①)をここで名指しできる
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    {
      fetchLib: { async fetchInstagramPosts() { return []; } },
      visionLib: {},
      mergeLib,
      downloadImage: async () => Buffer.from(''),
    }
  );
  const s = result.summaries[0];
  for (const f of buckets) {
    assert.equal(typeof s[f], 'number', `実装の summary に ${f} が無い(makeStoreSummary の初期化漏れ)`);
    assert.ok(Number.isFinite(s[f]), `${f} が数値になっていない`);
  }

  // (b) テスト側の手書き初期値とキー集合が完全に一致すること
  //     = 実装にバケツが増えたのに emptyPostBuckets() を更新し忘れる二重管理のずれを防ぐ
  const literal = Object.keys(emptyPostBuckets()).filter((k) => k !== 'scheduleLikeCount');
  assert.deepEqual(
    literal.slice().sort(),
    buckets.slice().sort(),
    'emptyPostBuckets() と checkPostAccounting が見ているバケツがずれている(どちらかを合わせること)'
  );
});

test('検知(投稿): 内訳の合計が対象数に足りなければ ok=false になり、不足分を報告する', () => {
  const broken = {
    ...emptyPostBuckets(),
    scheduleLikeCount: 6,
    importedPostCount: 1,
    notCalendarPostCount: 1,
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

test('★検知(投稿): バケツを1つ足し忘れたら(undefined のまま)ok=false になる', () => {
  // 【実際に踏んだバグ(2026-08-04)】走査フェーズのカウンタを summary に写し忘れると、
  // 内訳の合計が NaN になる。NaN === expected は常に false なので検査は【偽】を返す =
  // 安全側に倒れる。ここを「undefined は0とみなす」に緩めると、
  // 数え忘れたバケツぶんの投稿が静かに消えても保存則が成立してしまう。
  const missingBucket = { ...emptyPostBuckets(), scheduleLikeCount: 1, importedPostCount: 1 };
  delete missingBucket.notCalendarPostCount;
  assert.equal(monitor.checkPostAccounting(missingBucket).ok, false, 'バケツの数え忘れを見逃してはいけない');
});

test('検知(投稿): 内訳が多すぎる(二重計上)場合も ok=false になる', () => {
  const doubled = {
    ...emptyPostBuckets(),
    scheduleLikeCount: 1,
    importedPostCount: 1,
    notCalendarPostCount: 1, // ← 同じ投稿を2つのバケツに入れてしまった
  };
  const acc = monitor.checkPostAccounting(doubled);
  assert.equal(acc.ok, false, '二重計上も検知すること');
  assert.equal(acc.missing, -1, '多すぎる場合は負の値になる');
});

test('検知(投稿): 健全な入力では ok=true(検知側が常に false を返す実装になっていないこと)', () => {
  const sound = {
    ...emptyPostBuckets(),
    scheduleLikeCount: 5,
    importedPostCount: 1,
    unusablePostCount: 1,
    notCalendarPostCount: 1,
    pastCalendarPostCount: 1,
    unexaminedPostCount: 1,
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
  // A = カレンダー(未来の行 + 過去日の行を1件)/ B = カレンダーではない単発の告知。
  // 【Bを新しい方に置くこと】走査は新しい順で、当月以降のカレンダーを見つけたら打ち切るので、
  // 新しい方をカレンダーにすると A が「未確認」になり、取込みの経路を1本も通らなくなる。
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const CAL = ${JSON.stringify([
      ...fillerRows('2099-09'),
      { date: '2020-01-01', start: '19:00', name: '過去のトナメ', buyin: 3000, tags: [] },
    ])};
     exports.extractTournaments = async (buf) => {
       if (String(buf).includes('A.jpg')) return CAL;
       return [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }];
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
    // 「静かな経路」を注入する: カレンダーとして採用した投稿を、取込み直前で黙ってスキップする。
    // どのバケツにも入らないので、投稿の内訳の合計が対象数に届かなくなる。
    const p = path.join(root, 'tools', 'monitor-instagram-apify.js');
    const src = fs.readFileSync(p, 'utf8');
    const mutated = src.replace('      let keptFromPost = 0;', '      if (rows.length > 0) continue;\n      let keptFromPost = 0;');
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

test('CLI: 対象外にした投稿は、本文を出さずに投稿URLと判定値でログに出る', () => {
  // 【この経路は全投稿が通る】旧経路(キーワード不一致)よりも更に広くキャプションを
  // 集めてしまう場所なので、本文を出さないことをCLIの実出力で確かめる。
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [{ permalink: 'https://www.instagram.com/p/EN/', imageUrl: 'https://example.com/EN.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'AUGUST SCHEDULE 8/1-8/31' }];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.extractTournaments = async () => ([
       { date: '2099-09-12', start: '19:00', name: '単発トナメDay1', buyin: 3000, tags: [] },
       { date: '2099-09-13', start: '19:00', name: '単発トナメDay2', buyin: 3000, tags: [] }
     ]);\n`
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
    assert.match(r.stdout, /投稿判定: /, 'このログが無いと閾値を実測で直せない');
    assert.match(r.stdout, /https:\/\/www\.instagram\.com\/p\/EN\//, 'どの投稿かが分かること(内容はここから辿る)');
    assert.match(r.stdout, /異なる日付=2 \/ 広がり=1日/, '判定に使った値がそのまま読めること');
    assert.match(r.stdout, /カレンダーではない\(対象外\)/);
    assert.doesNotMatch(r.stdout, /AUGUST SCHEDULE/, '公開ログにキャプション本文を出してはいけない');
    assert.match(r.stdout, /カレンダーでない 1件/, '件数もサマリに出ること');
    assert.match(r.stdout, /当月カレンダー: なし/, '0件を静かに返さないこと');
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

test('取込み: Apifyが返した件数から、形式不正・日時不正・既読・判定対象まで数が合う', async () => {
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
  // 【キャプションによる事前の絞り込みは廃止した(2026-08-04)】新着はすべて画像で判定する。
  // filteredOut は「Vision に届く前に捨てた投稿」の枠として残してあるが、現在は常に0。
  // ここが0でなくなったら、また画像を見ずに捨てる経路が増えたということ。
  assert.equal(s.filteredOutCount, 0);
  assert.equal(s.scheduleLikeCount, 2, '英語キャプションの投稿も判定の対象になる');

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
// M-2: カレンダーが1枚も見つからなかった店でも lastExtraction を残す
// ============================================================

test('永続化: 新着はあるがカレンダーが1枚も無かった店でも lastExtraction が書かれる', async () => {
  // 【このカウンタが最も必要な場面】新着12件→取込み0件。ここで書かれないと
  // 「日程を投稿していない」のか「投稿はあるがカレンダーと判定されなかった」のかが
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
      // どれも単発の告知(カレンダーではない)
      visionLib: {
        async extractTournaments() {
          return [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }];
        },
      },
      mergeLib,
      downloadImage: async () => Buffer.from('x'),
    }
  );
  const le = result.state.v40.lastExtraction;
  assert.ok(le, '取込み0件でも lastExtraction が書かれること');
  assert.equal(le.newPosts, 3);
  assert.equal(le.posts, 3, '新着はすべて判定の対象になる');
  assert.equal(le.notCalendar, 3, 'カレンダーでなかった件数がgit履歴に残ること');
  assert.equal(le.kept, 0);
  assert.equal(le.apifyRaw, 3);
  assert.equal(le.notAdoptedRows, 3, '読み取った行が「採用しなかった投稿の行」として説明が付くこと');
  // 当月カレンダーが見つからなかったことも要約から読める
  assert.equal(result.summaries[0].currentMonthCalendar, null);
  assert.equal(result.summaries[0].latestPastCalendar, null);
  // 状態も前進している(=この投稿は二度と処理されない)ことが同時に読める
  assert.equal(result.state.v40.lastPostedAt, '2026-07-22T10:00:00.000Z');
  // 判定結果はキャッシュされ、次回この3件はVisionに渡らない
  assert.deepEqual(Object.values(result.state.v40.checkedPosts), ['not-calendar', 'not-calendar', 'not-calendar']);
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
function runCliWithRealFetchLib({ apifyItems, state = {}, mutate = () => {}, visionSource = null }) {
  const root = makeTempRepoRoot();
  fs.copyFileSync(
    path.join(TOOLS_DIR, 'fetch-venue-posts-apify.js'),
    path.join(root, 'tools', 'fetch-venue-posts-apify.js')
  );
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    visionSource || calendarVisionStubSource('マンデートナメ')
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
  // キャプションによる事前の絞り込みは無いので、新着=判定対象になる
  assert.match(r.stdout, /新着投稿 2件 → 判定対象 2件/);
  assert.doesNotMatch(r.stdout, /画像を見ずに対象外/, '画像を見ずに捨てる経路が復活していないこと');
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

test('R-1: 走査する投稿の一覧に絞り込みを1段足すと残余として表に出る', () => {
  // 【キーワード判定は廃止したが、同じ罠は残っている(2026-08-04)】
  // 以前は「キーワードで絞った後の件数」を残差で持っていたため、その段で消えた投稿が
  // 隣の項に吸い込まれて表に出なかった。今は走査の一覧(newestFirst)がその位置にあたる。
  // ここで1件黙って落とすと、どのバケツにも入らない投稿ができる = 投稿の保存則が破れる。
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-07-20T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('DROPME', '2026-07-21T10:00:00.000Z', '8月のスケジュール'),
    ],
    mutate: (root) =>
      patchFile(
        root,
        'monitor-instagram-apify.js',
        '    const newestFirst = [...newPosts].reverse();',
        "    const newestFirst = [...newPosts].reverse().filter((p) => !p.permalink.includes('DROPME'));"
      ),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /::error title=Instagram監視 - 投稿の集計が合わない::/,
    '走査から黙って外れた投稿が、どのバケツにも入らないまま素通りしている'
  );
  assert.match(r.stdout, /::error title=Instagram監視 - 投稿別の明細が合わない::/);
});

test('R-1: 「カレンダーでない」の件数と、実際にログへ出る判定行の数が一致する', () => {
  // 【残差で持っていると壊れる不変条件】件数を引き算で出すと、
  // 「件数だけ増えてログには出ない」という不一致が起こりうる。同じ場所で数えれば必ず一致する。
  const r = runCliWithRealFetchLib({
    apifyItems: [
      apifyItem('A', '2026-07-20T10:00:00.000Z', '8月のスケジュール'),
      apifyItem('B', '2026-07-21T10:00:00.000Z', 'AUGUST SCHEDULE'),
      apifyItem('C', '2026-07-22T10:00:00.000Z', '8月のトナメ表です'),
      apifyItem('D', '2026-07-23T10:00:00.000Z', '🎰🃏'),
    ],
    // 4件とも単発の告知(カレンダーではない)。打ち切りが起きないので4件すべてが判定される
    visionSource:
      "exports.extractTournaments = async () => ([{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }]);\n",
  });
  assert.equal(r.status, 0, r.stderr);
  const logged = (r.stdout.match(/カレンダーではない\(対象外\)/g) || []).length;
  const reported = Number(r.stdout.match(/カレンダーでない (\d+)件/)[1]);
  assert.equal(logged, 4, '対象外にした4件すべてがログに出ること');
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
// 【なぜ1つの関数の戻り値だけでは足りないか】
// 断片検査を1関数にしか当てていないと、【別のログ行に本文を出す変異】が素通りする。
// 実際、品質管理部の走査で「Vision 0件 のログ行に本文を出す」変異だけが生き残った。
// しかも次の工程はまさに「Vision 0件 の全件目視」なので、
// 「permalink だけだと確認が面倒だからキャプションも出そう」という変更が入りやすい場所。
// そこで【CLIを実際に走らせ、stdout/stderr/状態ファイル/data.js のすべて】を走査する。
// 【2026-08-04】キーワード判定の廃止で【全投稿】が判定ログを通るようになった =
// 本文を出したときに公開される範囲は旧方式より広い。この走査の重要度は上がっている。

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
  // 【1店では全経路を通せなくなった(2026-08-04)】1回の実行で採用するカレンダーは
  // 1店につき1枚なので、「取り込めた」と「全行不採用」は同じ店では両立しない。
  // 2店に分けて、両方の経路を1回のCLI実行の中で通す。
  // 【走査は新しい順・当月以降のカレンダーで打ち切り】なので、
  // 採用させたい投稿(OK)は【いちばん古い】位置に置く。そうしないと他の投稿が未確認になり、
  // 判定ログ・Vision失敗・0件の経路を通らないまま走査が終わってしまう。
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const cap = (kw) => ${JSON.stringify(leakCaption('__KW__'))}.replace('__KW__', kw);
     const p = (slug, day, kw) => ({
       permalink: 'https://www.instagram.com/p/' + slug + '/',
       imageUrl: 'https://example.com/' + slug + '.jpg',
       postedAt: '2026-07-' + day + 'T10:00:00.000Z',
       caption: cap(kw),
     });
     exports.fetchInstagramPosts = async (handle) => {
       if (handle === 'triple_orio') {
         return [
           p('OK', '20', 'スケジュール'),     // 採用あり + 破棄行 + 正規化行 が同時に出る
           p('NOTCAL', '21', 'スケジュール'), // カレンダーでない(判定ログ)
           p('VF', '22', 'スケジュール'),     // Vision抽出失敗(失われた投稿)
           p('EMPTY', '23', 'スケジュール'),  // Vision抽出0件
         ];
       }
       if (handle === 'king2485queen') {
         return [p('BAD', '20', 'スケジュール')]; // 全行不採用(異常)
       }
       return [];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const OK = ${JSON.stringify([
      { date: '2099-09-12', start: '9:00', name: '採用される大会', buyin: 3000, stack: 10000, tags: [] }, // 正規化される(9:00→09:00)
      { date: '2099-9-13', start: '19:00', name: '捨てられる大会', buyin: 3000, tags: [] }, // 破棄される
      ...fillerRows('2099-09'),
    ])};
     const BAD = ${JSON.stringify(unusableCalendarRows('全部捨てられる大会', '2099-09'))};
     exports.extractTournaments = async (buf) => {
       const s = String(buf);
       if (s.includes('VF')) throw new Error('Visionモデルの出力が max_tokens で打ち切られました。');
       if (s.includes('EMPTY')) return [];
       if (s.includes('BAD')) return BAD;
       if (s.includes('NOTCAL')) return [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }];
       return OK;
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
      ['カレンダー判定(全投稿が通る)', /投稿判定: /],
      ['カレンダーでない', /カレンダーではない\(対象外\)/],
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
    // 【★コミットされる出力面は1つ残らず走査すること】走査対象から漏れたファイルは
    // そこだけ素通りする。この案件は public リポジトリなので、書き出し先を1つ増やしたら
    // 必ずここにも足す(「入るのは data.js に載る値だけ」という主張ではなく、検査で担保する)。
    const readIfExists = (f) => {
      try {
        return fs.readFileSync(path.join(root, f), 'utf8');
      } catch (e) {
        return '';
      }
    };
    const writeStateJson = readIfExists('instagram-write-state.json');
    assert.ok(
      writeStateJson.length > 0,
      '機械が書いた値の控えが生成されていること(空だと走査が空振りになる)'
    );
    assertNoCaptionLeak({
      stdout: r.stdout,
      stderr: r.stderr,
      'apify-monitor-state.json': fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'),
      'data.js': fs.readFileSync(path.join(root, 'data.js'), 'utf8'),
      // 2026-08-04 に増えた出力面。人が直した値を守るための「機械が最後に書いた値」の控え。
      'instagram-write-state.json': writeStateJson,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 手順⑤(採用行の全件照合)のための明細
// ============================================================
// dry-run は data.js を書かないので、「実際に何が増えるのか」がどこにも残らない。
// 件数だけでは1行ずつ元の投稿画像と突き合わせる照合作業ができない。

/**
 * 追加行の明細から【指定した大会の行】を取り出す。
 * カレンダー1枚ぶんの行が並ぶので、先頭の行を取ると埋め行を見てしまうことがある。
 */
function findAddedRowLine(lines, name) {
  const line = lines.find((l) => l.includes('追加行: ') && l.includes(name));
  assert.ok(line, `明細に「${name}」の行が出ていない`);
  return line;
}

test('明細: 追加される行が、出所の投稿URL付きで1行1件で出る', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/SRC/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar(
          [
            { date: '2099-09-12', start: '19:00', name: 'マンデートナメ', buyin: 3000, stack: 10000, tags: [] },
            { date: '2020-01-01', start: '19:00', name: '過去の大会', buyin: 3000, tags: [] }, // 過去日 → 増えない
          ],
          '2099-09'
        ),
      },
    ])
  );
  const s = result.summaries[0];
  const added = s.addedRows.filter((r) => !isFiller(r.entry));
  assert.equal(added.length, 1, '実際に増える行だけが明細に載ること(過去日は載らない)');
  assert.equal(added[0].entry.name, 'マンデートナメ');
  assert.equal(added[0].permalink, 'https://www.instagram.com/p/SRC/', '出所の投稿が分かること');
  assert.equal(s.addedRows.length, FILLER_COUNT + 1, '採用した行はすべて明細に出る');

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  const row = findAddedRowLine(lines, 'マンデートナメ');
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
        rows: asCalendar([{ date: '2099-09-12', start: '19:00', name: '金額不明の大会', tags: [] }], '2099-09'),
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
  const row = findAddedRowLine(lines, '金額不明の大会');
  assert.match(row, /参加費不明/);
  assert.match(row, /スタック不明/);
  assert.doesNotMatch(row, /参加費0/, '読めなかった値を0(=無料)として出してはいけない');
});

test('明細: 投稿別の内訳は【対象投稿と同じ件数】並び、どの結末になっても1行出る', async () => {
  const result = await monitor.runMonitor(
    {
      stores: [monitor.STORES[0]],
      before: [],
      today: '2026-07-31',
      state: {
        v40: {
          handle: 'triple_orio',
          lastPostedAt: '2026-07-18T00:00:00.000Z',
          checkedPosts: { 'https://www.instagram.com/p/CACHED/': 'not-calendar' },
        },
      },
    },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/UNEXAMINED/', postedAt: '2026-07-19T10:00:00.000Z', rows: [] },
      { permalink: 'https://www.instagram.com/p/OK/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
      { permalink: 'https://www.instagram.com/p/PAST/', postedAt: '2026-07-21T10:00:00.000Z', rows: fillerRows('2026-05') },
      {
        permalink: 'https://www.instagram.com/p/NOTCAL/',
        postedAt: '2026-07-22T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }],
      },
      { permalink: 'https://www.instagram.com/p/EMPTY/', postedAt: '2026-07-23T10:00:00.000Z', rows: [] },
      { permalink: 'https://www.instagram.com/p/CACHED/', postedAt: '2026-07-24T10:00:00.000Z', rows: fillerRows('2099-09') },
      { permalink: 'https://www.instagram.com/p/VF/', postedAt: '2026-07-25T10:00:00.000Z', visionThrows: '打ち切り' },
      { permalink: 'https://www.instagram.com/p/IF/', postedAt: '2026-07-26T10:00:00.000Z', downloadThrows: 'HTTP 404' },
    ])
  );
  const s = result.summaries[0];
  // 【保存則と同じ考え方】途中の continue で記録が抜けると件数が食い違う。
  assert.equal(s.posts.length, s.scheduleLikeCount, '対象投稿の数と明細の行数が一致すること');
  // 【並び順ではなく「どの投稿がどの結末か」を見る】走査は新しい順なので明細の並びも新しい順だが、
  // それはこのテストの主張ではない。1投稿1行・結末が正しいことだけを固定する。
  const byPermalink = Object.fromEntries(s.posts.map((p) => [p.permalink.replace(/^.*\/p\//, '').replace(/\/$/, ''), p.outcome]));
  assert.deepEqual(byPermalink, {
    OK: '取り込めた',
    PAST: '過去月のカレンダー(2026-05)',
    NOTCAL: 'カレンダーでない',
    EMPTY: 'Vision抽出0件',
    CACHED: '判定済み(not-calendar)',
    VF: 'Vision抽出失敗',
    IF: '画像DL失敗',
    UNEXAMINED: '未確認(採用後に打ち切り)',
  });
});

test('明細: 日付レンジはVisionが返した行から取る(「追加0」の理由を説明できること)', async () => {
  // 久留米・黒崎の「抽出N行・追加0」が、過去の月間表を読んだ結果なのかを検算するための情報。
  // 【新方式では「過去月のカレンダー」として採用しない】ので、追加0の理由はそこで説明が付く。
  // 日付レンジはそれを人が検算するための材料なので、採用しなかった投稿にも必ず出す。
  const rows = Array.from({ length: 11 }, (_, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    start: '19:00',
    name: `3月の大会${i}`,
    buyin: 3000,
    tags: [],
  }));
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([{ permalink: 'https://www.instagram.com/p/MAR/', postedAt: '2026-07-20T10:00:00.000Z', rows }])
  );
  const s = result.summaries[0];
  const p = s.posts[0];
  assert.equal(p.rowCount, 11);
  assert.equal(p.addedCount, 0);
  assert.equal(p.dateMin, '2026-03-01');
  assert.equal(p.dateMax, '2026-03-11', '採用後ではなくVisionが返した行のレンジであること');
  assert.equal(p.outcome, '過去月のカレンダー(2026-03)');
  // 「追加0」の理由が数字でも説明できること(行はすべて不採用の投稿の行に数えられている)
  const row = monitor.checkRowAccounting(s);
  assert.equal(row.rows, 11);
  assert.equal(row.notAdopted, 11);
  assert.equal(row.residual, 0, '説明の付かない残余があってはいけない');
  assert.equal(s.latestPastCalendar.month, '2026-03', '最新のカレンダーが何月だったかが要約から読めること');
});

test('明細: 追加行の出所は採用した投稿を指し、走査しただけの投稿には追加が付かない', async () => {
  // 【複数投稿から同時に取り込むことは無くなった(2026-08-04)】1回の実行で採用するのは
  // 最新のカレンダー1枚だけ。それでも「どの投稿から来た行か」は⑤の照合に要るので、
  // 採用した投稿と紐づいていること・走査しただけの投稿に追加が付かないことを固定する。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/UNEXAMINED/', postedAt: '2026-07-19T10:00:00.000Z', rows: fillerRows('2099-09') },
      {
        permalink: 'https://www.instagram.com/p/SRC/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar([{ date: '2099-09-12', start: '19:00', name: '採用される大会', buyin: 3000, tags: [] }], '2099-09'),
      },
      {
        permalink: 'https://www.instagram.com/p/NOTCAL/',
        postedAt: '2026-07-21T10:00:00.000Z',
        rows: [{ date: '2099-09-13', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }],
      },
    ])
  );
  const s = result.summaries[0];
  for (const r of s.addedRows) {
    assert.equal(r.permalink, 'https://www.instagram.com/p/SRC/', `出所が採用した投稿を指していない: ${r.entry.name}`);
  }
  assert.equal(s.posts.find((p) => p.permalink.endsWith('/SRC/')).addedCount, FILLER_COUNT + 1);
  assert.equal(s.posts.find((p) => p.permalink.endsWith('/NOTCAL/')).addedCount, 0);
  assert.equal(s.posts.find((p) => p.permalink.endsWith('/UNEXAMINED/')).addedCount, 0);
  // 単発告知の行が紛れ込んでいないこと
  assert.equal(result.arr.some((t) => t.name === '単発トナメ'), false);
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
        rows: asCalendar(
          [
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
          '2099-09'
        ),
      },
    ])
  );
  const row = findAddedRowLine(captureAcceptedRowLines(result.summaries), '全項目そろった大会');
  for (const part of ['参加費3000', 'アドオン2000', 'スタック30000', '再入場レイトのみ', 'タグ特別開催']) {
    assert.ok(row.includes(part), `照合に必要な項目が欠けている: ${part}`);
  }
  // GTD と 賞品 も必ず項目として現れること(値そのものは下の回帰テストで固定する)
  assert.match(row, /GTD/, 'GTDが明細に無いと、サイトのGTDバッジが照合対象から外れる');
  assert.match(row, /賞品/);
});

test('★明細: Visionが読み取った GTD/賞品が data.js に入り、明細にもそのまま出る (#5)', async () => {
  // 【2026-08-04に直した不具合の回帰テスト】以前の carryOver は guarantee/prize を
  // 「既存エントリから取る、無ければ null」で上書きし、Visionが読み取った値を毎回捨てていた。
  // Waitinglist経路では guarantee/prize は人手専用なので正しいが、Vision経路では
  // プロンプトが両方を要求している(venue-schedule-vision.js)ため成立しなかった。
  // いまは【人の値 > 今回読み取った値 > null】の優先順になっている。
  //
  // 【明細は「読み取った値」ではなく「data.js に書かれる値」を出す】ので、両者が一致することを
  // ここで固定する。食い違うと⑤が偽の合格を出す(画像に30万GTDとあるのに明細はGTD不明、等)。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/GTD/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar(
          [
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
          '2099-09'
        ),
      },
    ])
  );
  // data.js に入る行そのものを見る(明細の出所)
  const entry = result.arr.find((t) => t.name === 'GTDつき大会');
  assert.equal(entry.guarantee, 300000, '読み取ったGTDが data.js に入ること');
  assert.equal(entry.prize, '1位 賞品あり', '読み取った賞品が data.js に入ること');
  // 明細は data.js の実態をそのまま映す = ⑤が画像と突き合わせられる
  const row = findAddedRowLine(captureAcceptedRowLines(result.summaries), 'GTDつき大会');
  assert.match(row, /GTD300000/, '明細が data.js の実態と食い違うと⑤が偽の合格を出す');
  assert.match(row, /賞品1位 賞品あり/);
});

test('明細: 読み取れた 0 と「読み取れなかった」を混同しない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/FREE/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar(
          [{ date: '2099-09-12', start: '19:00', name: '無料大会', buyin: 0, addon: 0, stack: 0, tags: [] }],
          '2099-09'
        ),
      },
    ])
  );
  const row = findAddedRowLine(captureAcceptedRowLines(result.summaries), '無料大会');
  assert.match(row, /参加費0 /, '0(=無料)は「不明」にしない');
  assert.match(row, /アドオン0 /);
  assert.match(row, /スタック0 /);
});

// ---------- M-1: 人の行を守って書かなかった行を明細に出す ----------
//
// 【★2026-08-04に意味が反転した】以前ここには
// 「人の入力を置き換えた行に `★既存の手入力(id=…)を置き換え` と印を付ける」テストがあった。
// いまは置き換えないので、その印は永久に発火しない = 鳴らない警報になるため削除した。
// 守りたかったこと(⑤が「これは新規ではない」と分かる)は、
// 【書かなかった行と、その理由になった人の行を並べて出す】形で引き継いでいる。

test('★明細: 人の行と同じ枠に来た行は書かれず、人の値と読み取った値が並べて出る', async () => {
  // 監視6店には未来日の手入力が82件ある。dry-run #5 ではこの経路で39件が置き換わった。
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
    lowConfidence: true, // ⚠ 要確認。置き換えると【誰も確認していないのに印が外れる】
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [manual], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/OVER/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar([{ date: '2099-09-12', start: '19:00', name: 'Visionが読んだ大会', buyin: 3000, tags: [] }], '2099-09'),
      },
    ])
  );
  const s = result.summaries[0];
  assert.deepEqual(
    result.arr.find((t) => t.id === 'kq0804'),
    manual,
    '人の行が1バイトも変わらないこと(⚠ 要確認 も残ること)'
  );
  assert.ok(
    !s.addedRows.some((r) => r.entry.name === 'Visionが読んだ大会'),
    '書かないので「追加行」には出ないこと'
  );
  assert.equal(s.protectedRows.length, 1, '見送った行が明細に載ること');
  assert.equal(s.protectedRows[0].existing[0].id, 'kq0804', '理由になった人の行が分かること');
  assert.equal(s.protectedRows[0].permalink, 'https://www.instagram.com/p/OVER/', '出所の投稿が分かること');
  assert.equal(s.stats.added, FILLER_COUNT, '枠が空いている埋め行は普通に追加される(取込みは止まらない)');
  assert.equal(s.stats.updated, 0, '置き換えは起きないので「更新」にも入らない');
  assert.equal(s.stats.protected, 1);

  // ログに【人の値と読み取った値の両方】が出ること(ずれ自体が⑤の確認対象になる)。
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  const skipped = lines.find((l) => l.includes('見送り: ') && l.includes('Visionが読んだ大会'));
  assert.ok(skipped, '読み取った値がログに出ること');
  assert.ok(
    lines.some((l) => l.includes('残した人の行: 人が入力した大会') && l.includes('参加費5000')),
    '人の値も並べて出ること'
  );
  // 【投稿別の「追加0」に理由が付くこと】これが無いと⑤が追加0を説明できない。
  assert.equal(result.summaries[0].posts.find((p) => p.permalink.includes('OVER')).protectedCount, 1);
});

test('明細: 人の行を守っていない通常の追加には★印を出さない', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/NEW/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar([{ date: '2099-09-12', start: '19:00', name: '新規トナメ', buyin: 3000, tags: [] }], '2099-09'),
      },
    ])
  );
  const lines = captureAcceptedRowLines(result.summaries);
  assert.doesNotMatch(findAddedRowLine(lines, '新規トナメ'), /★/, '通常の追加に印を付けるとノイズになる');
  // 埋め行(=同じカレンダーの他の行)にも印は付かない
  for (const l of lines.filter((x) => x.includes('追加行: '))) assert.doesNotMatch(l, /★/);
});

// ---------- M-2: 投稿ごとにまとまって並ぶ ----------

test('明細: 追加行は投稿ごとにまとまり、その中で日付順に並ぶ', async () => {
  // data.js は日付順なので、並べ替えないと同じ投稿の行がばらばらに出る。
  // ⑤は「投稿を1回開いて、その投稿の行をまとめて確認 → 次の投稿」という作業。
  // 【1回の実行で採用するのは1投稿だけになった(2026-08-04)】ので「投稿ごとにまとまる」は
  // 自動的に満たされる。残る主張は【その中が日付順であること】。
  // 並べ替えを外すと、Visionが返した順(= 画像の読み取り順)がそのまま出て⑤の作業が崩れる。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/AAA/',
        postedAt: '2026-07-20T10:00:00.000Z',
        // Visionが返す順はばらばら(実際そうなる)
        rows: [
          { date: '2099-09-15', start: '19:00', name: '4番目トナメ', buyin: 1, tags: [] },
          { date: '2099-09-11', start: '19:00', name: '2番目トナメ', buyin: 1, tags: [] },
          { date: '2099-09-22', start: '19:00', name: '6番目トナメ', buyin: 1, tags: [] },
          { date: '2099-09-17', start: '19:00', name: '5番目トナメ', buyin: 1, tags: [] },
          { date: '2099-09-13', start: '19:00', name: '3番目トナメ', buyin: 1, tags: [] },
          { date: '2099-09-11', start: '09:00', name: '1番目トナメ(同じ日の早い時刻)', buyin: 1, tags: [] },
        ],
      },
    ])
  );
  const s = result.summaries[0];
  assert.deepEqual(
    s.addedRows.map((r) => r.entry.name),
    ['1番目トナメ(同じ日の早い時刻)', '2番目トナメ', '3番目トナメ', '4番目トナメ', '5番目トナメ', '6番目トナメ'],
    '日付順、同じ日なら開始時刻順であること(Visionが返した順のままにしない)'
  );
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

test('★品質: 名前しか読めない行も捨てずに取り込む(⚠は付けない)', () => {
  // 【2026-08-04に⚠の側だけ変えた】以前はこの行に lowConfidence を付けていたが、
  // 実測で44行中42行(95%)に点灯し、印としての意味を失っていた。社長の基準では
  // 「最低限はトナメ名」なので名前だけの行は平常。**捨てない**ことは従来どおり
  // (ここを「証拠を要求するフィルタ」に戻すと v18 の30行がまるごと消える)。
  const nameOnly = monitor.toTournament({ date: '2026-08-05', name: 'FST SATELLITE', tags: [] }, 'v18');
  assert.equal(nameOnly.start, '', '捨てずに取り込む(00:00 で埋めない)');
  assert.equal(nameOnly.name, 'FST SATELLITE');
  assert.equal(nameOnly.lowConfidence, undefined, '名前だけの行は平常(常時点灯する印にしない)');
  // 項目がいくつ読めていても、名前由来の参加費でなければ印は付かない
  for (const t of [
    { date: '2026-08-05', name: 'X', start: '19:00', tags: [] },
    { date: '2026-08-05', name: 'X', buyin: 3000, tags: [] },
    { date: '2026-08-05', name: '感謝祭トナメ', buyin: 0, tags: [] },
    { date: '2026-08-05', name: 'X', stack: 30000, tags: [] },
    { date: '2026-08-05', name: 'X', guarantee: 100000, tags: [] },
  ]) {
    assert.equal(monitor.toTournament(t, 'v18').lowConfidence, undefined, `印は不要: ${JSON.stringify(t)}`);
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
        // 【実際のカレンダー1枚ぶんの形にする】休み・見出し・リングゲームは
        // 月間カレンダーのマスとして混ざって出てくるので、カレンダーの中に置いて確認する。
        rows: [
          { date: '2099-08-01', start: null, name: '休み', buyin: null, stack: null, tags: [] },
          { date: '2099-08-01', start: null, name: '月間TOURNAMENT', buyin: null, stack: null, tags: [] },
          { date: '2099-08-03', start: null, name: 'リングゲーム', buyin: 3000, tags: [] },
          { date: '2099-08-04', start: null, name: 'FST SATELLITE', buyin: null, stack: null, tags: [] },
          { date: '2099-08-05', start: null, name: '時刻不明の大会', buyin: 3000, stack: 10000, tags: ['satellite'] },
          { date: '2099-08-06', start: '19:15', name: 'ちゃんと読めた大会', buyin: 2000, tags: ['mystery・bounty'] },
          { date: '2099-08-20', start: '19:00', name: 'マンデートナメ', buyin: 3000, tags: [] },
        ],
      },
    ])
  );
  const names = realRows(result.arr).filter((t) => t.venueId === 'v40' && t.name !== 'マンデートナメ').map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    ['FST SATELLITE', 'ちゃんと読めた大会', '時刻不明の大会'],
    '休み・見出し・リングゲームは入らないが、名前しか読めない正当な大会は残る'
  );
  const reasons = result.summaries[0].dropped.map((d) => d.reason);
  assert.equal(reasons.filter((r) => /定休日・休業のマス/.test(r)).length, 1);
  assert.equal(reasons.filter((r) => /画像の見出し/.test(r)).length, 1);
  assert.equal(reasons.filter((r) => /トーナメントではない競技形式/.test(r)).length, 1);
  // 【2026-08-04】名前しか読めない行は平常なので⚠は付かない(旧規則ではここが true だった)。
  // どちらの行も「捨てない」ことは変わらない — 変えたのは印だけ。
  assert.equal(result.arr.find((t) => t.name === 'FST SATELLITE').lowConfidence, undefined);
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
        // カレンダー1枚(異なる日付5・広がり12日)のうち、開始時刻が読めているのは1行だけ
        rows: [1, 4, 7, 10, 13].map((d, i) => ({
          date: `2099-08-${String(d).padStart(2, '0')}`,
          start: i === 0 ? '19:00' : null,
          name: `デイリートナメ${d}日`,
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
  assert.match(info, /5行中4行\(80%\)/);
  assert.match(info, new RegExp(`${monitor.EXPECTED_NO_START_PCT}%前後が平常`));
  // 80% は平常95%±25 の範囲内なので警告は出ない
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

// ============================================================
// ⚠ 要確認(lowConfidence)の判定 — 2026-08-04に作り直した
//
// 【新しい規則】⚠ が付く条件は【参加費が大会名から推測された疑い】ただ1つ。
// 「時刻も参加費も無い行」は社長の基準では平常なので付けない(旧判定は44行中42行=95%に点灯し、
// 全部に付く印は何も指していないのと同じだった)。
//
// 【★ここは「鳴らない警報」になりやすい】平常時この判定は0行しか返さない。
// 壊れても本番のログは何も変わらないので、**両方向を必ず固定する**:
//   ・付くべき行で付く(時刻あり/スタックあり/GTDあり/何も無し の4通り全部)
//   ・付くべきでない行で付かない(名前だけ / 時刻だけ)
// この案件は同じ罠を2度踏んでいる(PR #32 の到達不能な上振れ分岐、
// および「上振れで発火しないことだけを検査すると警告が完全に死んでも緑」)。
// ============================================================

test('★品質: 参加費が大会名から推測された疑いがある行には、他の項目に関わらず⚠を付ける', () => {
  // Visionは画像に金額が無くても FREE ROLL→0 / 1K MULTI→1000 と推論して返すことがある。
  // 誤った参加費は【持っていく金額】を間違えさせるうえ、画像に数字はあるので
  // ⑤(人の照合)でも一致して見え、見抜けない。ここだけは印を残す。
  const names = [
    { name: '1K MULTI', buyin: 1000 },
    { name: 'FREE ROLL', buyin: 0 },
    { name: '大還元フリロ', buyin: 0 },
    { name: '2K BOUNTY', buyin: 2000 },
    { name: '3000円トナメ', buyin: 3000 },
  ];
  // 【★4通り全部を確かめる】旧実装は start / stack / guarantee のどれかがあると
  // 先に「証拠あり」を返し、名前由来のガードが素通りしていた(リスク台帳 #11)。
  // 「Visionが時刻を1つ読めた瞬間に⚠が消える」という壊れ方だったので、
  // 他の項目を足した形でも必ず⚠が付くことを固定する。
  const others = [
    ['何も無し', {}],
    ['時刻あり', { start: '19:00' }],
    ['スタックあり', { stack: 20000 }],
    ['GTDあり', { guarantee: 100000 }],
  ];
  for (const base of names) {
    for (const [label, extra] of others) {
      assert.equal(
        monitor.buyinMayComeFromName({ ...base, ...extra }),
        true,
        `⚠を付けること(${label}): ${base.name}`
      );
    }
  }
});

test('★品質: 名前だけの行・時刻だけの行には⚠を付けない(常時点灯する警報を作らない)', () => {
  // 前回の試験実行では 44行中42行(95%)に⚠が点灯していた。社長の基準では
  // 「最低限はトナメ名」なので、名前だけの行は平常。
  for (const t of [
    { name: 'FST SATELLITE' }, // 名前だけ(実測の大多数)
    { name: '華金' },
    { name: 'DEEP STACK', start: '19:00' }, // 時刻だけ
    { name: 'マンデートナメ', stack: 20000 }, // スタックだけ
    { name: 'サンデースペシャル', guarantee: 100000 }, // GTDだけ
    { name: 'デイリートナメ', buyin: 3000 }, // 名前に金額トークンが無い参加費
    { name: '1K MULTI' }, // 名前に金額はあるが、参加費は入っていない = 捏造されていない
    { name: 'FREE ROLL', buyin: null },
  ]) {
    assert.equal(monitor.buyinMayComeFromName(t), false, `⚠を付けてはいけない: ${t.name}`);
  }
});

test('★品質: 参加費の値そのものは消さない(⚠を残すだけ)', () => {
  const e = monitor.toTournament({ date: '2026-08-05', name: '1K MULTI', buyin: 1000, tags: [] }, 'v20');
  assert.equal(e.buyin, 1000, '値を消すと情報が失われる。消すのではなく⚠を残す');
  assert.equal(e.lowConfidence, true);
});

test('★品質: toTournament が新しい規則どおりに ⚠ を付ける(判定と結線の両方を固定する)', () => {
  // 純関数だけを検査していると、`toTournament` の呼び出しを消す変異が素通りする。
  // 実際に data.js へ入るエントリの形で両方向を押さえる。
  const rowsWithWarn = [
    { date: '2026-08-05', name: '1K MULTI', buyin: 1000, start: '19:00', tags: [] }, // 時刻あり
    { date: '2026-08-06', name: '1K MULTI', buyin: 1000, stack: 20000, tags: [] }, // スタックあり
    { date: '2026-08-07', name: '1K MULTI', buyin: 1000, guarantee: 100000, tags: [] }, // GTDあり
    { date: '2026-08-08', name: '1K MULTI', buyin: 1000, tags: [] }, // 何も無し
  ];
  for (const row of rowsWithWarn) {
    const e = monitor.toTournament(row, 'v20');
    assert.equal(e.lowConfidence, true, `⚠が付くこと: ${JSON.stringify(row)}`);
    assert.equal(e.buyin, 1000, '値は残すこと');
  }
  const rowsWithoutWarn = [
    { date: '2026-08-09', name: 'FST SATELLITE', tags: [] }, // 名前だけ = 平常
    { date: '2026-08-10', name: 'DEEP STACK', start: '19:00', tags: [] }, // 時刻だけ
  ];
  for (const row of rowsWithoutWarn) {
    const e = monitor.toTournament(row, 'v20');
    assert.equal(e.lowConfidence, undefined, `⚠を付けないこと(平常): ${row.name}`);
    assert.ok(!('lowConfidence' in e), '平常の行にキー自体を生やさない(差分を汚さない)');
  }
});

test('★品質: 実行経路でも新しい規則どおりに⚠が付く(明細と件数にも出る)', async () => {
  // 【なぜ実行経路でも見るか】判定が正しくても、`toTournament` の結果が data.js へ届くまでに
  // 印が落ちれば意味がない。前回44行の実測(名前だけ42行 + 時刻あり2行)に対応する形を作り、
  // 名前由来の参加費の行だけに⚠が付くことを、追加されたエントリと⑤向けの明細の両方で確かめる。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/WARN/',
        postedAt: '2026-07-20T10:00:00.000Z',
        rows: asCalendar(
          [
            { date: '2099-08-01', name: '名前だけトナメ', tags: [] },
            { date: '2099-08-02', name: '時刻ありトナメ', start: '19:00', tags: [] },
            { date: '2099-08-03', name: '1K MULTI', buyin: 1000, start: '19:00', tags: [] },
          ],
          '2099-08'
        ),
      },
    ])
  );
  const byName = (n) => result.arr.find((t) => t.name === n);
  assert.equal(byName('名前だけトナメ').lowConfidence, undefined, '名前だけの行は平常(⚠を付けない)');
  assert.equal(byName('時刻ありトナメ').lowConfidence, undefined, '時刻だけの行も平常');
  assert.equal(byName('1K MULTI').lowConfidence, true, '時刻が読めても名前由来の参加費には⚠が残ること');
  assert.equal(byName('1K MULTI').buyin, 1000, '値は消さない');

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportAcceptedRows(result.summaries);
  } finally {
    console.log = orig;
  }
  // 件数の行(0行が平常なので、⑤が「今日は何行あるか」を1行で読めるようにしてある)
  const count = lines.find((l) => l.includes('⚠ 要確認(参加費が大会名から推測された疑い)の行'));
  assert.ok(count, '⚠の件数を必ず出すこと');
  assert.match(count, new RegExp(`${result.arr.length}行中1行`), '件数が実際の⚠行数と一致すること');
  // 明細側の印は⚠が付いた行にだけ出る
  const detail = lines.filter((l) => l.includes('追加行: '));
  assert.equal(detail.filter((l) => l.includes('★⚠要確認')).length, 1, '⚠の印は該当行だけに出すこと');
  assert.ok(
    detail.find((l) => l.includes('1K MULTI')).includes('★⚠要確認'),
    '⑤が「どの行の参加費を見ればよいか」を明細から拾えること'
  );
  // 【別チャネルの警報を増やさない】⚠はサイトのバッジと明細で伝える。
  // ::warning:: にすると「0行が平常」の指標に赤い注記を足すことになり、
  // 開始時刻の割合の警告(別物)と紛れる。
  assert.ok(!count.startsWith('::warning'), '⚠の件数は ::warning:: にしない');
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
        rows: asCalendar(
          [
            {
              date: '2099-08-05',
              start: '19:00',
              name: 'タグが混ざる大会',
              buyin: 3000,
              tags: ['satellite', 'freezeout', 'multi', 'ノーリミット'],
            },
          ],
          '2099-08'
        ),
      },
    ])
  );
  assert.deepEqual(result.arr.find((t) => t.name === 'タグが混ざる大会').tags, ['サテライト']);
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
    calendarVisionStubSource('マンデートナメ')
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
    calendarVisionStubSource('マンデートナメ')
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
        // 【カレンダー1枚まるごとリングゲーム】1〜2行の投稿はカレンダーと判定されず
        // 行の検査に到達しない(2026-08-04のスコープ変更)。v34 の実例は19行だった。
        rows: FILLER_DAYS.map((d, i) => ({
          date: `2099-08-${String(d).padStart(2, '0')}`,
          start: '19:00',
          name: i % 2 === 0 ? 'リングゲーム' : 'キャッシュゲーム',
          buyin: 3000,
          tags: [],
        })),
      },
    ])
  );
  assert.equal(result.summaries[0].droppedCount, FILLER_DAYS.length, '全行が捨てられること(テストの前提)');
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
          ...FILLER_DAYS.map((d) => ({
            date: `2099-08-${String(d).padStart(2, '0')}`,
            start: '19:00',
            name: 'リングゲーム',
            buyin: 3000,
            tags: [],
          })),
          // 【日付が不正な行はカレンダー判定の材料にならない】ので、上のリングゲームの行で
          // カレンダーの形を作ったうえで混ぜる。これが「失われた本物の大会」にあたる。
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
        // 定休日のマスだけが並んだ月間カレンダー(長期休業など)
        rows: FILLER_DAYS.map((d) => ({
          date: `2099-08-${String(d).padStart(2, '0')}`,
          start: null,
          name: '休み',
          buyin: null,
          stack: null,
          tags: [],
        })),
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

// ============================================================
// 書き込み直前の最終自己チェックの【配線】(検査そのものは schedule-write-guard.test.js)
//
// 【★CLIで確かめる理由★】この検査は main() の中にあり、以前はインラインで書かれていて
// 【テストから呼べなかった】。だから 2026-08-04 に実データで落ちるまで、147本のテストが
// 全部緑のままだった。共有モジュールに切り出して単体で覆ったうえで、
// 「main() がそれを正しく呼んでいるか」だけをここで見る。
// ============================================================

/** data.js 上で店の行が2ブロックに分かれた配置を作る(実データと同じ形)。 */
function splitBlockTournaments() {
  const t = (id, venueId, date, name) => ({
    id, venueId, name, date, start: '19:00', buyin: 1000, addon: null, stack: null,
    guarantee: null, reentry: false, prize: null, tags: [], source: 'manual', verified: true,
  });
  return [
    t('orio-past-1', 'v40', '2020-01-01', '折尾の古い大会1'), // v40 の1ブロック目
    t('iris-past-1', 'v18', '2020-02-01', 'IRISの古い大会'), //  別の対象店(追い越される側)
    t('orio-past-2', 'v40', '2020-03-01', '折尾の古い大会2'), // v40 の2ブロック目 = 分断されている
  ];
}

test('★CLI: 店の行が2ブロックに分かれていても中止せず、並べ直した行数をログに出す(#17の配線)', () => {
  const root = makeTempRepoRoot(splitBlockTournaments());
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [{ permalink: 'https://www.instagram.com/p/S/', imageUrl: 'https://example.com/S.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '9月のスケジュール' }];
     };\n`
  );
  fs.writeFileSync(path.join(root, 'tools', 'venue-schedule-vision.js'), calendarVisionStubSource('並び替えテスト大会'));
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
    // 修正前はここで「過去日のエントリが変化しています(バグ)」として終了コード1になっていた。
    assert.equal(r.status, 0, `中止してはいけない: ${r.stderr}`);
    assert.match(r.stdout, /過去日の並び: 1行の位置が変わりました/);
    assert.match(r.stdout, /理由: data\.js 内で行が2つ以上に分かれていた店/);
    assert.match(r.stdout, /v40\(2ブロック\)/);
    // 実際に書けていること(=中止していないこと)を data.js 側でも確かめる
    assert.match(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), /並び替えテスト大会/);
    // 過去日の行は3件とも中身そのままで残っている
    const after = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    for (const id of ['orio-past-1', 'orio-past-2', 'iris-past-1']) assert.match(after, new RegExp(id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★CLI: 並びが変わらない実行でも「変化なし(0行)」を必ず出す(鳴らない警報にしない)', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle !== 'triple_orio') return [];
       return [{ permalink: 'https://www.instagram.com/p/S/', imageUrl: 'https://example.com/S.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '9月のスケジュール' }];
     };\n`
  );
  fs.writeFileSync(path.join(root, 'tools', 'venue-schedule-vision.js'), calendarVisionStubSource('マンデートナメ'));
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
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /過去日の並び: 変化なし\(0行\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// リスク台帳 #19: 確認済み投稿日時の記録が壊れても永久に止まらない
// ============================================================
// 【何を変えたか】以前は apify-monitor-state.json を JSON として読めないと throw → fail() →
// exit(1) だった。書き込みが起きないので翌朝も同じファイルを読んで同じ理由で落ちる
// = 人が直すまで毎朝止まる(#17 と同じ「回復しない」形)。
//
// 【なぜ落とさない側が正しいと判断したか(揃えたのではなく性質から決めた)】
//   記録が空 = その店の取得窓の投稿がすべて「新着」になる。つまり空で続けて起きるのは
//   【もう一度読み直す】ことだけで、【取りこぼし】は構造的に起きない
//   (取りこぼすのは lastPostedAt が進みすぎたときで、空はその逆側)。
//   しかも続行すればその実行の最後に正しい内容で書き直され、コミットされる = 自分で直る。
//
// 【ただし黙って続けない】読み直しには費用がかかり、人が消した行が復活しうる(#15)。
// ::error:: で必ず人に見せることを、下の両方向のテストで固定する。

/** 一時リポジトリに、v40 だけが1投稿を返すスタブ一式を書き込む。 */
function writeSingleCalendarStubs(root, { posts = null, visionSource = null } = {}) {
  const defaultPosts = [
    {
      permalink: 'https://www.instagram.com/p/CAL/',
      imageUrl: 'https://example.com/CAL.jpg',
      postedAt: '2026-07-20T10:00:00.000Z',
      caption: 'スケジュール',
    },
  ];
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const POSTS = ${JSON.stringify(posts || defaultPosts)};
     exports.fetchInstagramPosts = async (handle) => (handle === 'triple_orio' ? POSTS : []);\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    visionSource || calendarVisionStubSource('壊れた記録テスト大会')
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
}

function runCliArgs(root, args = []) {
  return spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', ...args], {
    cwd: root,
    env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
    encoding: 'utf8',
  });
}

const BROKEN_STATE = '{\n<<<<<<< HEAD\n  "v40": { "lastPostedAt": "2026-07-01T00:00:00.000Z" }\n=======\n';

test('loadState: 壊れていても例外を投げず、空として返す(broken で呼び出し側に伝える)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-loadstate-'));
  try {
    const p = path.join(dir, 'apify-monitor-state.json');
    // 1. rebase の衝突マーカーが入った(JSONとして壊れている)
    fs.writeFileSync(p, BROKEN_STATE);
    const broken = monitor.loadState(p);
    assert.deepEqual(broken.state, {}, '空として返すこと');
    assert.equal(broken.broken, true);
    assert.equal(broken.missing, false);
    assert.match(broken.reason, /JSON/, '理由が読めること(ログに出すため)');

    // 2. JSONとしては読めるが形が違う(配列・スカラー)。以前は静かに {} に潰していた
    fs.writeFileSync(p, '[]');
    assert.equal(monitor.loadState(p).broken, true, '配列も壊れている扱いにする(静かに続けない)');
    fs.writeFileSync(p, '5');
    assert.equal(monitor.loadState(p).broken, true);
    fs.writeFileSync(p, 'null');
    assert.equal(monitor.loadState(p).broken, true);

    // 3. 正常
    fs.writeFileSync(p, JSON.stringify({ v40: { lastPostedAt: '2026-07-20T10:00:00.000Z' } }));
    const ok = monitor.loadState(p);
    assert.equal(ok.broken, false);
    assert.equal(ok.missing, false);
    assert.equal(ok.state.v40.lastPostedAt, '2026-07-20T10:00:00.000Z');

    // 4. まだ無い(初回)。これは「壊れている」ではない
    fs.unlinkSync(p);
    const missing = monitor.loadState(p);
    assert.deepEqual(missing.state, {});
    assert.equal(missing.missing, true);
    assert.equal(missing.broken, false, '未生成を壊れている扱いにすると、初回実行のたびに赤が出る');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★CLI(実測・2回実行): 壊れた記録でも取り込み、記録を書き直す = 翌日は普通に通る(#19)', () => {
  // 【README の全数監査と同じ方式】同じディレクトリで続けて2回実行し、
  // 「回復しない(2回とも同じ所で落ちる)」が「回復する」に変わったことを実測で示す。
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root);
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), BROKEN_STATE);
  try {
    const r1 = runCliArgs(root);
    assert.equal(r1.status, 0, `実行1: 止まらずに最後まで走ること(stderr: ${r1.stderr})`);
    // 【ジョブを落とさないことが要件】落とすと後続のコミット・pushが走らず、
    // 直った状態ファイルがリポジトリに残らない = 翌朝また同じ壊れたファイルを読む。
    assert.match(r1.stdout, /::error title=Instagram監視 - 確認済み投稿日時の記録が読めません/);
    assert.match(r1.stdout, /git log -p -- apify-monitor-state\.json/, '壊れる前の内容の取り出し方を示すこと');

    const dataJs1 = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.match(dataJs1, /壊れた記録テスト大会/, '実行1で取り込みまで到達していること');

    const state1 = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
    const parsed1 = JSON.parse(state1); // 壊れたままなら例外になる
    assert.equal(parsed1.v40.lastPostedAt, '2026-07-20T10:00:00.000Z', '記録が書き直されていること');

    // 実行2: 同じディレクトリでもう一度。もう壊れていないので赤は出ず、既読なので何も増えない。
    const r2 = runCliArgs(root);
    assert.equal(r2.status, 0, `実行2: ${r2.stderr}`);
    assert.equal(
      /確認済み投稿日時の記録が読めません/.test(r2.stdout),
      false,
      '直った回に赤を出してはいけない(空振りの赤を作らない)'
    );
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), dataJs1, '実行2で data.js は動かない');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★CLI: 新着0件の日でも、壊れた記録は書き直される(差分だけを見ると直らない)', () => {
  // 【この分岐を落とすと自己修復が成立しない】全店で新着0件の日は nextState が
  // (空の)state と一致するので、差分比較だけで保存を決めると壊れたファイルが残る。
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root, { posts: [] }); // どの店も投稿なし
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), BROKEN_STATE);
  try {
    const r = runCliArgs(root);
    assert.equal(r.status, 0, r.stderr);
    const state = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
    assert.deepEqual(JSON.parse(state), {}, '空の記録として書き直されること(JSONとして読めること)');
    assert.match(r.stdout, /読めなかった apify-monitor-state\.json を書き直しました/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★CLI: 記録が健全な回には「読めません」の赤を出さない(両方向を固定する)', () => {
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root);
  try {
    const r = runCliArgs(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      /確認済み投稿日時の記録が読めません/.test(r.stdout),
      false,
      '健全な回に鳴る警報は、鳴っていることに意味が無くなる'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --dry-run では壊れた記録を書き直さない(何も書かないという約束が優先)', () => {
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root);
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), BROKEN_STATE);
  try {
    const r = runCliArgs(root, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), BROKEN_STATE, '1バイトも触らない');
    assert.match(r.stdout, /このモードでは何も書かないので、ファイルは壊れたままです/, '直らないことを明示すること');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// リスク台帳 #13 の測定: 探索専用モード(--probe)
// ============================================================
// 【何のためのモードか】本番の走査は「新しい順に見て、最初の当月以降のカレンダーで打ち切る」。
// そのため打ち切りより古い投稿の中身は【誰も見ていない】(run 30922261347 では71投稿中43投稿)。
// #13 が問うているのはまさにその集合なので、打ち切らずに全部判定して数えるモードを足した。
// 【採用させないこと】が要件。data.js も状態ファイルも書かず、lastPostedAt も前進させない。

test('★探索: 打ち切らずに全投稿を判定する(本番なら未確認だった投稿も Vision に渡る)', async () => {
  let visionCalls = 0;
  const posts = [
    // 古い順。走査は新しい順なので、新しい方(下)から見る
    { permalink: 'https://www.instagram.com/p/OLD/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
    { permalink: 'https://www.instagram.com/p/MID/', postedAt: '2026-07-21T10:00:00.000Z', rows: fillerRows('2026-05') },
    { permalink: 'https://www.instagram.com/p/NEW/', postedAt: '2026-07-22T10:00:00.000Z', rows: fillerRows('2099-09') },
  ];
  const libs = fakeLibsForBehaviour(posts);
  const counting = {
    ...libs,
    visionLib: {
      async extractTournaments(...a) {
        visionCalls += 1;
        return libs.visionLib.extractTournaments(...a);
      },
    },
  };
  const state = { v40: { handle: 'triple_orio', lastPostedAt: '2026-07-01T00:00:00.000Z' } };

  // 本番: 新しい方(NEW)が当月以降のカレンダーなのでそこで打ち切る = Vision は1回だけ
  const prod = await monitor.runMonitor({ stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state }, counting);
  assert.equal(visionCalls, 1, '本番は打ち切るので1件しか見ない(このテストの前提)');
  assert.equal(prod.summaries[0].unexaminedPostCount, 2);

  // 探索: 3件すべて判定する
  visionCalls = 0;
  const probe = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state, probe: true },
    counting
  );
  assert.equal(visionCalls, 3, '探索は打ち切らないので全投稿を判定する');
  const s = probe.summaries[0];
  assert.equal(s.unexaminedPostCount, 0, '未確認は残らない');
  assert.equal(s.probeCalendarPostCount, 2, '当月以降のカレンダー2件を「採用せず」に数えること');
  assert.equal(s.pastCalendarPostCount, 1);
  assert.equal(s.importedPostCount, 0, '★採用は1件もしない');
  assert.ok(monitor.checkPostAccounting(s).ok, `投稿の保存則: ${JSON.stringify(monitor.checkPostAccounting(s))}`);
  assert.ok(monitor.checkRowAccounting(s).ok, `行の保存則: ${JSON.stringify(monitor.checkRowAccounting(s))}`);
  // 投稿別の明細も対象数と一致していること(M-4 の検査が空振りの赤を出さない)
  assert.equal(s.posts.length, s.scheduleLikeCount);
});

test('★探索: 状態を1バイトも動かさない(バックログを消費しない)', async () => {
  const state = {
    v40: {
      handle: 'triple_orio',
      lastPostedAt: '2026-07-01T00:00:00.000Z',
      lastPermalink: 'https://www.instagram.com/p/PREV/',
      checkedPosts: { 'https://www.instagram.com/p/PREV/': 'not-calendar' },
      lastExtraction: { checkedAt: '2026-07-01', posts: 1, kept: 0 },
    },
  };
  const before = [];
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before, today: '2026-07-31', state, probe: true },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/A/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
      { permalink: 'https://www.instagram.com/p/B/', postedAt: '2026-07-21T10:00:00.000Z', rows: fillerRows('2099-09') },
    ])
  );
  // 【ビット単位で同じ】lastPostedAt も checkedPosts も lastExtraction も動かない。
  assert.equal(JSON.stringify(result.state), JSON.stringify(state), '探索が状態を書き換えている');
  assert.equal(result.changed, false, 'data.js を書く合図を立ててはいけない');
  assert.deepEqual(result.arr, before, 'メモリ上の data.js も動かさない(採用しないため)');
  assert.deepEqual(result.written, {}, '機械が書いた値の控えも作らない');
});

test('★探索: 判定キャッシュを使わない(形の数値が測れないため)', async () => {
  let visionCalls = 0;
  const libs = fakeLibsForBehaviour([
    { permalink: 'https://www.instagram.com/p/SEEN/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
  ]);
  const counting = {
    ...libs,
    visionLib: {
      async extractTournaments(...a) {
        visionCalls += 1;
        return libs.visionLib.extractTournaments(...a);
      },
    },
  };
  const state = {
    v40: {
      handle: 'triple_orio',
      lastPostedAt: '2026-07-01T00:00:00.000Z',
      checkedPosts: { 'https://www.instagram.com/p/SEEN/': 'not-calendar' },
    },
  };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state, probe: true },
    counting
  );
  assert.equal(visionCalls, 1, 'キャッシュに当たっても判定し直すこと(支配月/異なる日付/広がりはキャッシュに無い)');
  assert.equal(result.summaries[0].cacheHitCount, 0);
  assert.equal(monitor.probeMetrics(result.summaries[0]).total, 1, '判定一覧に載ること');
});

test('★探索: 既読の投稿も測定対象にする(本番なら飛ばしていた件数を別に数える)', async () => {
  const state = { v40: { handle: 'triple_orio', lastPostedAt: '2026-07-21T00:00:00.000Z' } };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state, probe: true },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/OLD/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
      { permalink: 'https://www.instagram.com/p/NEW/', postedAt: '2026-07-22T10:00:00.000Z', rows: fillerRows('2099-09') },
    ])
  );
  const s = result.summaries[0];
  assert.equal(s.scheduleLikeCount, 2, '既読の投稿も判定の対象に含める');
  assert.equal(s.alreadySeenCount, 0, '既読を理由に落とした投稿は0件(選別そのものを行っていない)');
  assert.equal(s.probeReExaminedCount, 1, '本番なら飛ばしていた件数は別の項で数える');
  assert.ok(monitor.checkIntakeAccounting(s).ok, '取込みの保存則は保たれること');
});

test('★探索(#13の再現): 本物のカレンダーが打ち切りの後ろに隠れていることを数える', () => {
  // レビュー部の再現そのもの: 8月カレンダー(20日付・08-01投稿)の【後に】
  // シリーズ告知(8/3・10・17・24・31 = 異なる日付5・広がり28日)が投稿された状態。
  // 本番は新しい方(シリーズ告知)をカレンダーと判定して打ち切るので、本物は未確認のまま残る。
  //
  // 【★この形では「採用より新しい位置」は0件になる★】採用位置は
  // 「新しい順で最初の当月以降のカレンダー」なので、それより新しい位置に当月以降のカレンダーは
  // 定義上存在しない。つまりレビュー部が指定した数字【だけ】を見ると 0 = 安全に見えるが、
  // 実際には本物が後ろで潰れている。だから【後ろ側】も必ず数える。
  const summary = {
    probeVerdicts: [
      // index 0 = いちばん新しい(シリーズ告知・偽陽性の候補)
      { index: 0, permalink: 'p/SERIES/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 5, spanDays: 28 },
      // index 1 = 本物の月間カレンダー。本番の走査はここに到達しない
      { index: 1, permalink: 'p/REAL/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 20, spanDays: 30 },
      { index: 2, permalink: 'p/PHOTO/', kind: 'not-calendar', dominantMonth: '2026-08', distinctDates: 1, spanDays: 0 },
    ],
  };
  const m = monitor.probeMetrics(summary);
  assert.equal(m.adopted.permalink, 'p/SERIES/', '本番が採用していたのは新しい方');
  assert.equal(m.adoptedIndex, 0);
  assert.equal(m.aheadCalendars, 0, 'レビュー部指定の数字。この形では構造的に0になる');
  assert.equal(m.aheadCurrentMonth, 0, '採用より新しい位置に当月以降のカレンダーは定義上存在しない');
  assert.equal(m.behindCurrentMonth, 1, '★本物が打ち切りの後ろに1件隠れている(本番からは見えない)');
  assert.equal(m.behindNotCalendar, 1);
  assert.ok(monitor.checkProbeAccounting(m).ok, JSON.stringify(monitor.checkProbeAccounting(m)));
});

test('★探索: 採用より新しい位置にカレンダーの形をした投稿がある場合を数える(過去月のカレンダー)', () => {
  // 「採用より新しい位置」に入りうるのは過去月のカレンダーだけ(当月以降なら採用側になるため)。
  // これは【月の判定だけが偽陽性を止めている】状態なので、その件数を見えるようにする。
  const summary = {
    probeVerdicts: [
      { index: 0, permalink: 'p/PAST1/', kind: 'calendar-past', dominantMonth: '2026-06', distinctDates: 18, spanDays: 29 },
      { index: 1, permalink: 'p/EMPTY/', kind: 'empty', dominantMonth: null, distinctDates: 0, spanDays: 0 },
      { index: 2, permalink: 'p/VF/', kind: 'vision-failed', dominantMonth: null, distinctDates: 0, spanDays: 0 },
      { index: 3, permalink: 'p/REAL/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 20, spanDays: 30 },
      { index: 4, permalink: 'p/OLD/', kind: 'calendar-past', dominantMonth: '2026-05', distinctDates: 15, spanDays: 28 },
    ],
  };
  const m = monitor.probeMetrics(summary);
  assert.equal(m.adoptedIndex, 3);
  assert.equal(m.aheadCalendars, 1, '★本物を追い越せる位置にある「カレンダーの形」の投稿');
  assert.equal(m.aheadPastMonth, 1);
  assert.equal(m.aheadEmpty, 1);
  assert.equal(m.aheadUndetermined, 1, '形が確定していない投稿(この数がある限り上の値は「見えた範囲」)');
  assert.equal(m.behindPastMonth, 1);
  assert.equal(m.behindCurrentMonth, 0);
  assert.ok(monitor.checkProbeAccounting(m).ok);
});

test('★探索: 当月以降のカレンダーが1枚も無い店では、前後の件数を数えない(0で埋めない)', () => {
  const m = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, kind: 'not-calendar', permalink: 'a' },
      { index: 1, kind: 'calendar-past', permalink: 'b' },
    ],
  });
  assert.equal(m.adopted, null);
  assert.equal(m.adoptedIndex, -1);
  assert.equal(m.aheadTotal, 0);
  assert.equal(m.behindTotal, 0);
  assert.equal(m.allCalendars, 1, '形の分布そのものは測れること');
  assert.ok(monitor.checkProbeAccounting(m).ok, '採用が無い店で保存則が破れないこと');
});

test('★探索(検知側): 判定一覧に穴/未知の kind があれば ok=false になる(残差で数えていないこと)', () => {
  // 【穴】recordProbe を呼ばない経路が増えると、一覧に undefined が残る
  const hole = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, kind: 'calendar-current', permalink: 'adopted' },
      undefined, // 記録されなかった投稿
      { index: 2, kind: 'not-calendar', permalink: 'c' },
    ],
  });
  const accHole = monitor.checkProbeAccounting(hole);
  assert.equal(accHole.ok, false, '穴が空いているのに ok=true なら、測定は静かに小さく出る');
  assert.equal(accHole.residual, 1);

  // 【未知の kind】分類が1つ増えたのに数える側を直し忘れた場合
  const unknown = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, kind: 'calendar-current', permalink: 'adopted' },
      { index: 1, kind: 'brand-new-kind', permalink: 'x' },
    ],
  });
  assert.equal(monitor.checkProbeAccounting(unknown).ok, false);

  // 健全な一覧では真(常に false を返す実装になっていないこと)
  const healthy = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, kind: 'calendar-current', permalink: 'adopted' },
      { index: 1, kind: 'empty', permalink: 'y' },
    ],
  });
  assert.equal(monitor.checkProbeAccounting(healthy).ok, true);
});

test('forbidWrite: 探索モードでは書き込み関数そのものが使えない(並びに依存しない安全弁)', () => {
  const w = monitor.forbidWrite('data.js');
  assert.throws(() => w('/tmp/whatever', {}, []), /探索モード/);
});

test('★CLI: --probe は data.js も状態ファイルも1バイトも書き換えない', () => {
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root, {
    posts: [
      { permalink: 'https://www.instagram.com/p/OLD/', imageUrl: 'https://example.com/OLD.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: 'x' },
      { permalink: 'https://www.instagram.com/p/NEW/', imageUrl: 'https://example.com/NEW.jpg', postedAt: '2026-07-22T10:00:00.000Z', caption: 'y' },
    ],
  });
  try {
    const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    const beforeState = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
    const r = runCliArgs(root, ['--probe']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData, 'data.js を書き換えている');
    assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), beforeState, '状態を前進させている');
    assert.equal(fs.existsSync(path.join(root, 'instagram-write-state.json')), false, '控えも作らないこと');
    // 探索であることが実行の先頭で分かること(「本番で走ってしまった」を目視で拾えるように)
    assert.match(r.stdout, /PROBE\(探索専用/);
    // 全投稿の判定値がログに出ること(#13 の較正はこのログの実測で行う)
    const verdicts = r.stdout.split('\n').filter((l) => l.includes('投稿判定: '));
    assert.equal(verdicts.length, 2, '打ち切らずに全投稿ぶんの判定行が出ること');
    for (const v of verdicts) {
      assert.match(v, /支配月=/);
      assert.match(v, /異なる日付=\d+/);
      assert.match(v, /広がり=\d+日/);
    }
    assert.match(r.stdout, /本番ならここで採用して打ち切っていた/);
    assert.match(r.stdout, /★採用より【新しい位置】にあり、カレンダー判定を満たす投稿: \d+件/);
    assert.match(r.stdout, /採用より【古い位置】にある当月以降のカレンダー: 1件/);
    assert.match(r.stdout, /この実行では【何も採用していません】/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★CLI: 知らない引数は本番実行にならず、何も書かずに止まる(打ち間違い対策)', () => {
  // 【この経路が無いと打ち間違いがそのまま本番になる】`--dryrun` は --dry-run ではないので、
  // 以前の実装では【書き込みあり・不可逆】の本番実行になっていた。
  for (const bad of ['--dryrun', '--dry_run', '--prob', '--probe=1']) {
    const root = makeTempRepoRoot();
    writeSingleCalendarStubs(root);
    try {
      const beforeData = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
      const beforeState = fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8');
      const r = runCliArgs(root, [bad]);
      assert.equal(r.status, 1, `${bad}: 異常終了すること`);
      assert.match(r.stderr, /知らない引数です/);
      assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), beforeData, `${bad}: data.js を書き換えている`);
      assert.equal(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'), beforeState);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // 正しい綴りは従来どおり通ること(検査が全部を弾く実装になっていないこと)
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root);
  try {
    assert.equal(runCliArgs(root, ['--dry-run']).status, 0);
    assert.equal(runCliArgs(root, ['--probe']).status, 0);
    assert.equal(runCliArgs(root, []).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★漏洩走査(--probe): 全投稿が判定ログを通るモードでも、キャプションが1文字も出ない', () => {
  // 【探索モードは公開ログへの露出がいちばん広い】打ち切らないので取得窓の全投稿が
  // 判定ログを通る。日程告知以外(優勝者名・お礼・連絡先)を含む投稿も必ず1行ずつ出る。
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const cap = (kw) => ${JSON.stringify(leakCaption('__KW__'))}.replace('__KW__', kw);
     const p = (slug, day, kw) => ({
       permalink: 'https://www.instagram.com/p/' + slug + '/',
       imageUrl: 'https://example.com/' + slug + '.jpg',
       postedAt: '2026-07-' + day + 'T10:00:00.000Z',
       caption: cap(kw),
     });
     exports.fetchInstagramPosts = async (handle) => {
       if (handle === 'triple_orio') {
         return [p('OLDCAL', '20', 'スケジュール'), p('NOTCAL', '21', 'お礼'), p('EMPTY', '22', 'お知らせ'), p('NEWCAL', '23', 'スケジュール')];
       }
       return [];
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const CAL = ${JSON.stringify(fillerRows('2099-09'))};
     exports.extractTournaments = async (buf) => {
       const s = String(buf);
       if (s.includes('EMPTY')) return [];
       if (s.includes('NOTCAL')) return [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }];
       return CAL;
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    const r = runCliArgs(root, ['--probe']);
    assert.equal(r.status, 0, r.stderr);
    // 走査が空振りにならないよう、狙った経路を通ったことを先に確かめる
    assert.equal(r.stdout.split('\n').filter((l) => l.includes('投稿判定: ')).length, 4, '全投稿が判定ログを通ること');
    assert.match(r.stdout, /Vision抽出0件/);
    assert.match(r.stdout, /カレンダーではない\(対象外\)/);
    assert.match(r.stdout, /探索\(--probe\)の結果/);
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

// ============================================================
// 探索の【配線】を固定する — 検知器ではなく「記録する側」を試す
// ============================================================
// 【なぜ足したか(2026-08-05・品質管理部の指摘)】
// 上の probeMetrics / checkProbeAccounting のテストは、どれも【テストが手で組み立てた
// probeVerdicts】を渡している。つまり「数える側」しか試していない。
// 実装の recordProbe から特定の kind を記録しなくなる変異は、370本すべて緑のまま通った
// (実測。`not-calendar` / `empty` の2通りで確認)。実行時には ::error:: が出るので
// 保護そのものは生きているが、【テストが落ちない】以上、退行は次のPRまで気づけない。
//
// 【同じ形を3回踏んでいる】PR #35(保護を外すと破壊ではなく重複になり、破壊しか見ない
// 検査が素通り)、PR #36(本番ツール側の報告の固定が抜けており出力を消しても緑)、そして今回。
// **検知器を試すテストと、検知器に値を渡す配線を試すテストは別物**。
//
// 【欠けていたのは fixture だけ】走査は新しい順なので、「採用より新しい位置」に
// 非カレンダー・0件・失敗が並ぶ形を作らないと ahead 側の各カウンタが1件も動かない。
// 上のテストはどれも「いちばん新しい投稿がカレンダー」= ahead が空だった。

/** 採用したカレンダーの【前後】に、すべての判定が1件ずつ並ぶ探索用の投稿列(古い順)。 */
function probeMixedPosts() {
  return [
    // --- 採用より古い位置(本番の走査は打ち切りでここに到達しない) ---
    { permalink: 'https://www.instagram.com/p/B_PAST/', postedAt: '2026-07-14T10:00:00.000Z', rows: fillerRows('2026-05') },
    { permalink: 'https://www.instagram.com/p/B_NOTCAL/', postedAt: '2026-07-15T10:00:00.000Z', rows: [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }] },
    // --- 本番ならここで採用して打ち切る ---
    { permalink: 'https://www.instagram.com/p/CAL/', postedAt: '2026-07-16T10:00:00.000Z', rows: fillerRows('2099-09') },
    // --- 採用より新しい位置(#13 が問題にしている側) ---
    { permalink: 'https://www.instagram.com/p/A_PAST/', postedAt: '2026-07-17T10:00:00.000Z', rows: fillerRows('2026-06') },
    { permalink: 'https://www.instagram.com/p/A_NOTCAL/', postedAt: '2026-07-18T10:00:00.000Z', rows: [{ date: '2099-09-13', start: '19:00', name: '写真だけの投稿', buyin: 3000, tags: [] }] },
    { permalink: 'https://www.instagram.com/p/A_EMPTY/', postedAt: '2026-07-19T10:00:00.000Z', rows: [] },
    { permalink: 'https://www.instagram.com/p/A_VF/', postedAt: '2026-07-20T10:00:00.000Z', visionThrows: 'max_tokensで打ち切られました' },
    { permalink: 'https://www.instagram.com/p/A_IF/', postedAt: '2026-07-21T10:00:00.000Z', downloadThrows: 'HTTP 404' },
  ];
}

test('★探索(配線): 採用の前後に並ぶ全種類の判定が、実装から測定値まで届いている', async () => {
  // 【このテストが守るもの】recordProbe から kind を1つでも記録しなくなったら落ちること。
  // 【★件数を deepEqual で丸ごと固定する】個別の assert を並べると、次に kind が増えたときに
  //   「新しい kind を数え忘れる」変異がまた素通りする。合計(checkProbeAccounting)と
  //   内訳の両方を見る。
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {}, probe: true },
    fakeLibsForBehaviour(probeMixedPosts())
  );
  const s = result.summaries[0];
  const m = monitor.probeMetrics(s);

  // 判定一覧が【全投稿ぶん】埋まっていること(穴が空いていないこと)
  assert.equal(m.total, 8, '取得した8投稿すべてに判定が記録されていること');
  assert.equal(s.probeVerdicts.filter(Boolean).length, 8, '判定一覧に undefined の穴があってはいけない');

  // 本番なら採用していた位置(新しい順で6件目 = index 5)
  assert.equal(m.adopted.permalink, 'https://www.instagram.com/p/CAL/');
  assert.equal(m.adoptedIndex, 5);

  // ★採用より【新しい位置】= #13 の「本物を追い越せる位置」。5件の内訳が全部動くこと
  assert.deepEqual(
    {
      aheadTotal: m.aheadTotal,
      aheadCalendars: m.aheadCalendars,
      aheadCurrentMonth: m.aheadCurrentMonth,
      aheadPastMonth: m.aheadPastMonth,
      aheadNotCalendar: m.aheadNotCalendar,
      aheadEmpty: m.aheadEmpty,
      aheadUndetermined: m.aheadUndetermined,
    },
    {
      aheadTotal: 5,
      aheadCalendars: 1, // A_PAST(形はカレンダー。月の判定だけが止めている)
      aheadCurrentMonth: 0, // 採用位置の決め方から常に0
      aheadPastMonth: 1,
      aheadNotCalendar: 1, // A_NOTCAL
      aheadEmpty: 1, // A_EMPTY
      aheadUndetermined: 2, // A_VF(Vision失敗) + A_IF(画像DL失敗)
    },
    'ahead 側の内訳が実装から届いていない(recordProbe の記録漏れを疑うこと)'
  );

  // 採用より【古い位置】= 本番の走査が到達しない側
  assert.deepEqual(
    {
      behindTotal: m.behindTotal,
      behindCurrentMonth: m.behindCurrentMonth,
      behindPastMonth: m.behindPastMonth,
      behindNotCalendar: m.behindNotCalendar,
      behindEmpty: m.behindEmpty,
      behindUndetermined: m.behindUndetermined,
    },
    { behindTotal: 2, behindCurrentMonth: 0, behindPastMonth: 1, behindNotCalendar: 1, behindEmpty: 0, behindUndetermined: 0 },
    'behind 側の内訳が実装から届いていない'
  );

  // 探索の保存則(前後それぞれで、内訳の合計が実際の件数と一致すること)
  const acc = monitor.checkProbeAccounting(m);
  assert.ok(acc.ok, `探索の保存則が破れている: ${JSON.stringify(acc)}`);
  assert.equal(acc.residual, 0);

  // 投稿・行レベルの保存則も同時に成り立つこと(バケツを1つ足した影響が出ていないこと)
  assert.ok(monitor.checkPostAccounting(s).ok, JSON.stringify(monitor.checkPostAccounting(s)));
  assert.ok(monitor.checkRowAccounting(s).ok, JSON.stringify(monitor.checkRowAccounting(s)));
  assert.equal(s.probeCalendarPostCount, 1, '当月以降のカレンダーは1件(採用はしない)');
  assert.equal(s.importedPostCount, 0, '探索は1件も採用しない');
  // 失敗した投稿は【判定できていない】のでキャッシュにも載せない(本番と同じ規則)
  assert.equal(result.changed, false);
  assert.equal(JSON.stringify(result.state), '{}', '探索は状態を1バイトも動かさない');
});

/** 探索モードで CLI を回す(mutate で実装に変異を当てられる)。 */
function runProbeCliWithMutation(mutate) {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const p = (slug, day) => ({ permalink: 'https://www.instagram.com/p/' + slug + '/', imageUrl: 'https://example.com/' + slug + '.jpg', postedAt: '2026-07-' + day + 'T10:00:00.000Z', caption: '' });
     exports.fetchInstagramPosts = async (handle) => (handle === 'triple_orio' ? [p('CALPOST', '16'), p('SINGLE', '18')] : []);\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const CAL = ${JSON.stringify(fillerRows('2099-09'))};
     exports.extractTournaments = async (buf) => (String(buf).includes('CALPOST')
       ? CAL
       : [{ date: '2099-09-13', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }]);\n`
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  mutate(root);
  const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', '--probe'], {
    cwd: root,
    env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return r;
}

test('★CLI(探索): 判定を記録しない経路が増えたら ::error::(探索の集計が合わない)が stdout に出る', () => {
  const r = runProbeCliWithMutation((root) => {
    // 「カレンダーでない」と判断した投稿を、判定一覧に記録しないようにする
    // (= recordProbe の呼び忘れ。実装に穴が空いたときとまったく同じ形)。
    const p = path.join(root, 'tools', 'monitor-instagram-apify.js');
    const src = fs.readFileSync(p, 'utf8');
    const mutated = src.replace("        recordProbe('not-calendar', shape);\n", '');
    assert.notEqual(mutated, src, '変異の当て先が見つからない(テストの前提が古い)');
    fs.writeFileSync(p, mutated);
  });
  assert.equal(r.status, 0, `ジョブは落とさない(注記で見せる): ${r.stderr}`);
  assert.match(r.stdout, /::error title=Instagram監視 - 探索の集計が合わない::/, '判定一覧に穴があるのに注記が出ていない');
  assert.match(r.stdout, /判定一覧に穴があります/);
});

test('★CLI(探索): 健全な実行では「探索の集計が合わない」注記を出さない(誤検知しないこと)', () => {
  const r = runProbeCliWithMutation(() => {});
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /探索の集計が合わない/, '正常な探索で偽陽性が出てはいけない');
  // 採用より新しい位置に非カレンダーが1件並ぶ形なので、その内訳が実際に出ること
  assert.match(r.stdout, /同じ位置のその他: カレンダーでない 1件/);
});

// ============================================================
// #13 の署名: 採用が「窓内で最もカレンダーらしい投稿」か(形状の比較)
// ============================================================
// 【なぜ ahead/behind の件数では足りないか(2026-08-05・レビュー部の指示)】
// あの2つは【分類】(カレンダーか否か・当月か過去月か)に依存している。
// **採用が偽陽性 かつ 後ろの本物も偽陰性**だと、本物が behindCurrentMonth に数えられず
// 【0のまま実害が起きる】。形(異なる日付)の比較は分類を経由しないので、その場合も効く。

test('★形状比較: 採用が窓内で最大なら印を付けない(常時点灯する警報にしない)', () => {
  const m = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/NOTCAL/', kind: 'not-calendar', distinctDates: 2, spanDays: 1 },
      { index: 1, permalink: 'p/REAL/', kind: 'calendar-current', distinctDates: 20, spanDays: 30 },
      { index: 2, permalink: 'p/OLD/', kind: 'calendar-past', distinctDates: 18, spanDays: 29 },
    ],
  });
  assert.equal(m.adoptedIsStrongest, true);
  assert.equal(m.maxDistinctDates, 20);
  assert.equal(m.strongestPosition, 'adopted');
  assert.match(monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, m), /採用が窓内で最もカレンダーらしい投稿/);
});

test('★形状比較: 採用より強い投稿が後ろに居たら印を付ける(#13 の署名)', () => {
  // レビュー部の再現そのもの: 偽陽性(異なる日付5)が本物(20)を追い越している
  const m = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/SERIES/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 5, spanDays: 28 },
      { index: 1, permalink: 'p/REAL/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 20, spanDays: 30 },
    ],
  });
  assert.equal(m.adoptedIsStrongest, false);
  assert.equal(m.signature, true);
  assert.equal(m.maxDistinctDates, 20);
  assert.equal(m.strongestPosition, 'behind');
  assert.equal(m.strongest.permalink, 'p/REAL/');
  const line = monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, m);
  assert.match(line, /採用=異なる日付5・広がり28日/);
  assert.match(line, /窓内の最大=異なる日付20・広がり30日\(採用より【古い位置】/);
  assert.match(line, /★採用は窓内で最もカレンダーらしい投稿ではない\(#13 の署名: /);

  // 【★この1行だけで2枚の画像に到達できること★】印が付くのは異常時で、そのとき担当が
  // することは「採用した投稿」と「窓内の最大」を見比べることしかない。片方しか無いと
  // 同じ店の別の行を探しに行くことになり、1行に集約した意味が薄れる。
  assert.match(line, /採用=異なる日付5・広がり28日\(p\/SERIES\/\)/, '採用側の permalink がこの行に無い');
  assert.ok(line.includes('p/REAL/'), '窓内の最大の permalink がこの行に無い');
  assert.equal(
    (line.match(/p\/[A-Z]+\//g) || []).length,
    2,
    'この1行に2つの投稿URLが揃っていること(どちらかが欠けると別の行を探すことになる)'
  );
});

test('★形状比較: 後ろの本物が【偽陰性】でも効く(分類を経由しないこと)', () => {
  // 【これが ahead/behind の件数では埋まらない盲点】本物の月間カレンダーの支配月を
  // Vision が読み違える(年や月をまたいで拾う)と `calendar-past` に落ちる。
  // すると behindCurrentMonth は 0 = 「後ろに本物は居ない」に見えるが、実際には居る。
  const m = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/SERIES/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 5, spanDays: 28 },
      { index: 1, permalink: 'p/REAL/', kind: 'calendar-past', dominantMonth: '2026-07', distinctDates: 20, spanDays: 30 },
    ],
  });
  assert.equal(m.behindCurrentMonth, 0, '分類ベースの数字は 0 のまま(=盲点が実在すること)');
  assert.equal(m.adoptedIsStrongest, false, '形の比較は分類を経由しないので効くこと');
  assert.equal(m.strongest.kind, 'calendar-past');
  // 【★2026-08-05: ★印の条件を絞った後もこの盲点で印が付くこと★】
  // 支配月は past なのでレビュー部が提案した条件(1)は満たさない。それでも
  // 「採用5は最大20の半分以下」で条件(2)が立つ。**ここが立たなくなる絞り方は採らない。**
  assert.equal(m.signature, true, '支配月を誤読された本物を追い越している形で印が消えてはいけない');
  assert.deepEqual(m.signatureReasons, ['half']);

  // 「カレンダーでない」と判定された投稿でも、形が強ければ【比較には出る】
  const m2 = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/SERIES/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 5, spanDays: 28 },
      { index: 1, permalink: 'p/REAL/', kind: 'not-calendar', dominantMonth: '2026-07', distinctDates: 9, spanDays: 8 },
    ],
  });
  assert.equal(m2.behindCurrentMonth, 0);
  assert.equal(m2.adoptedIsStrongest, false, '母集団は絞っていない(not-calendar も比較に入る)');
  // 5 は 9 の半分より多く、支配月も過去 → 署名にはしない(参考行として残る)
  assert.equal(m2.signature, false);
  assert.match(
    monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, m2),
    /参考: 窓内の最大は採用より大きい\(5→9\)/,
    '印が付かなくても比較の中身は1行要約に残ること'
  );
});

test('★形状比較: 同点は「最強」に倒す / 形が確定していない投稿は母集団に入れない', () => {
  // 同点(同じカレンダーの再投稿など)で印を付けると、その店で毎回点灯する
  const tie = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/A/', kind: 'calendar-current', distinctDates: 20, spanDays: 30 },
      { index: 1, permalink: 'p/B/', kind: 'calendar-current', distinctDates: 20, spanDays: 30 },
    ],
  });
  assert.equal(tie.adoptedIsStrongest, true, '同点で点灯させない');
  assert.equal(tie.strongestPosition, 'adopted', '同点なら採用を代表にする(読み違えを防ぐ)');

  // 【★同点の相手が「採用より新しい位置」に居る場合★】(品質管理部が見つけた素通りの穴)
  // 上の fixture は同点の2件がどちらも calendar-current なので、先頭が採用位置になり
  // 代表の選び方を外しても結果が変わらない = 変異が見えない。
  // 代表の選び方が効くのは【同点の相手が採用より前に居て、かつ採用ではない】ときだけ。
  // ここが崩れると1行要約が
  //   「窓内の最大=…(採用より【新しい位置】/ 判定=calendar-past …)」
  // となり、【最大が採用より新しい位置にあるのに警告が出ていない】と読める行になる。
  // cron 後は生ログを突き合わせないので、この1行の読み違え防止はテストで留める。
  const tieAhead = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/PAST/', kind: 'calendar-past', distinctDates: 20, spanDays: 30 },
      { index: 1, permalink: 'p/ADOPTED/', kind: 'calendar-current', distinctDates: 20, spanDays: 30 },
    ],
  });
  assert.equal(tieAhead.adoptedIsStrongest, true, '同点なので印は付かない(ここは変異しても同じ)');
  assert.equal(tieAhead.strongestPosition, 'adopted', '同点なら【採用】を代表にすること');
  assert.equal(tieAhead.strongest.permalink, 'p/ADOPTED/');
  assert.equal(tieAhead.strongest.kind, 'calendar-current');
  const tieLine = monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, tieAhead);
  assert.match(tieLine, /窓内の最大=異なる日付20・広がり30日\(採用した投稿そのもの/);
  assert.doesNotMatch(
    tieLine,
    /採用より【新しい位置】/,
    '同点なのに「最大は採用より新しい位置」と出ると、警告が出ていないことを読み違える'
  );

  // 1件差なら同点ではないので、比較としては「採用が最大ではない」になる。
  // ただし★印は付けない(2026-08-05 に絞った条件。過去月が1件多いだけの形は実走で誤警報だった)
  const oneApart = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/PAST/', kind: 'calendar-past', dominantMonth: '2026-07', distinctDates: 21, spanDays: 30 },
      { index: 1, permalink: 'p/ADOPTED/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 20, spanDays: 30 },
    ],
  });
  assert.equal(oneApart.adoptedIsStrongest, false, '1件でも差があれば「採用が最大ではない」と出す');
  assert.equal(oneApart.strongestPosition, 'ahead');
  assert.equal(oneApart.signature, false, '過去月が1件多いだけで★を付けない(実走の誤警報4件と同じ形)');

  // 画像DL失敗・Vision失敗は形が分からないので比較に混ぜない(0件として最大を歪めない)
  const withFailures = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/IF/', kind: 'image-failed', distinctDates: 0, spanDays: 0 },
      { index: 1, permalink: 'p/CAL/', kind: 'calendar-current', distinctDates: 7, spanDays: 20 },
      { index: 2, permalink: 'p/VF/', kind: 'vision-failed', distinctDates: 0, spanDays: 0 },
    ],
  });
  assert.equal(withFailures.shapedCount, 1);
  assert.equal(withFailures.adoptedIsStrongest, true);

  // 採用が無い / 形が1件も確定していない店では false にしない(判定できないので null)
  const noAdopt = monitor.probeMetrics({
    probeVerdicts: [{ index: 0, permalink: 'p/X/', kind: 'not-calendar', distinctDates: 3, spanDays: 2 }],
  });
  assert.equal(noAdopt.adoptedIsStrongest, null);
  assert.match(monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, noAdopt), /採用=なし/);
  const nothing = monitor.probeMetrics({ probeVerdicts: [{ index: 0, kind: 'vision-failed', permalink: 'p/Y/' }] });
  assert.equal(nothing.adoptedIsStrongest, null);
  assert.match(monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, nothing), /形が確定した投稿がありません/);
});

// ============================================================
// ★★★の条件を絞ったこと(2026-08-05)を、実測データと盲点の両方で固定する
// ============================================================
/**
 * 【実走 run 30963380537(2026-08-05・16分・★完走 71/71・書き込み0)の生ログから写した値】
 * 6店のうち採用があった4店で、当時の条件(採用が窓内の最大でない)が★を出した。
 * **4件すべて誤警報**で、いずれも「窓内の最大」は過去月のカレンダーだった(画像で確認済み)。
 *
 * 数字は生ログの `投稿判定:` 行の 支配月 / 異なる日付 / 広がり をそのまま使っている。
 * 例(v18): 支配月=2026-08 異なる日付=26 広がり=30日 ← 採用 /
 *          支配月=2026-06 異なる日付=30 広がり=29日 ← 窓内の最大(過去月のカレンダー)
 */
const MEASURED_2026_08_05 = [
  {
    venueId: 'v40', label: 'TripleBarrel 折尾店',
    adopted: { permalink: 'https://www.instagram.com/p/DbQuwnpSBB7/', dominantMonth: '2026-08', distinctDates: 29, spanDays: 30 },
    strongest: { permalink: 'https://www.instagram.com/p/DZfLifDSvTS/', dominantMonth: '2026-06', distinctDates: 30, spanDays: 29 },
  },
  {
    venueId: 'v20', label: 'KING&QUEEN SUITED 直方店',
    adopted: { permalink: 'https://www.instagram.com/p/DbVXB9xzVfb/', dominantMonth: '2026-08', distinctDates: 17, spanDays: 25 },
    strongest: { permalink: 'https://www.instagram.com/p/DaSi7jlTAQZ/', dominantMonth: '2026-07', distinctDates: 23, spanDays: 30 },
  },
  {
    venueId: 'v18', label: 'Poker Bar IRIS',
    adopted: { permalink: 'https://www.instagram.com/p/DbTQ1e2j7vz/', dominantMonth: '2026-08', distinctDates: 26, spanDays: 30 },
    strongest: { permalink: 'https://www.instagram.com/p/DY3UWBQj7-7/', dominantMonth: '2026-06', distinctDates: 30, spanDays: 29 },
  },
  {
    venueId: 'v35', label: 'A&K',
    adopted: { permalink: 'https://www.instagram.com/p/DbiWr9Vkz64/', dominantMonth: '2026-08', distinctDates: 29, spanDays: 28 },
    strongest: { permalink: 'https://www.instagram.com/p/DY_glZpTgMz/', dominantMonth: '2026-06', distinctDates: 30, spanDays: 29 },
  },
];

/** 実走の1店ぶんを probeVerdicts の形にする(採用が新しい位置・最大が古い位置、という実走と同じ並び)。 */
function measuredVerdicts(c) {
  return [
    { index: 0, permalink: c.adopted.permalink, kind: 'calendar-current', ...c.adopted },
    { index: 1, permalink: c.strongest.permalink, kind: 'calendar-past', ...c.strongest },
  ].map((v, i) => ({ ...v, index: i }));
}

/** レビュー部が構成した盲点の再現(実測ではない): 偽陽性5日付 / 後ろの本物20日付を past と誤読。 */
function blindSpotVerdicts() {
  return [
    { index: 0, permalink: 'p/SERIES/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 5, spanDays: 28 },
    { index: 1, permalink: 'p/REAL/', kind: 'calendar-past', dominantMonth: '2026-07', distinctDates: 20, spanDays: 30 },
  ];
}

test('★形状比較(実測): 2026-08-05 の実走で鳴った4件は、すべて★無しの【参考行】になる', () => {
  for (const c of MEASURED_2026_08_05) {
    const m = monitor.probeMetrics({ probeVerdicts: measuredVerdicts(c) });
    // 比較そのものは今までどおり成立している(母集団も絞っていない)
    assert.equal(m.adoptedIsStrongest, false, `${c.venueId}: 比較では採用が最大ではないままであること`);
    assert.equal(m.maxDistinctDates, c.strongest.distinctDates, `${c.venueId}`);
    // ★印だけを外した
    assert.equal(m.signature, false,
      `${c.venueId}: 実走で誤警報だった形に★が付いている(採用${c.adopted.distinctDates} / 最大${c.strongest.distinctDates})`);
    const line = monitor.formatProbeShapeComparison({ label: c.label, venueId: c.venueId }, m);
    assert.doesNotMatch(line, /★採用は窓内で最もカレンダーらしい投稿ではない/, `${c.venueId}: ${line}`);
    assert.doesNotMatch(line, /#13 の署名: /, `${c.venueId}: ${line}`);
    assert.match(line, /参考: 窓内の最大は採用より大きい/, `${c.venueId}: 比較の中身が行から消えている`);
    // 【参考行でも2枚の画像に到達できること】印を消した代わりに、読む人は行だけで判断する
    assert.ok(line.includes(c.adopted.permalink), `${c.venueId}: 採用のURLが参考行に無い`);
    assert.ok(line.includes(c.strongest.permalink), `${c.venueId}: 窓内の最大のURLが参考行に無い`);
  }
});

test('★形状比較(盲点): 支配月を誤読された本物を追い越している形には★が付く(実測4件と両立)', () => {
  const m = monitor.probeMetrics({ probeVerdicts: blindSpotVerdicts() });
  assert.equal(m.signature, true, '盲点の再現で★が消えてはいけない');
  assert.deepEqual(m.signatureReasons, ['half'], 'レビュー部の条件(1)は満たさず、半分以下の条件だけで立つこと');
  assert.match(
    monitor.formatProbeShapeComparison({ label: 'X', venueId: 'v40' }, m),
    /★採用は窓内で最もカレンダーらしい投稿ではない\(#13 の署名: 採用5は窓内の最大20の半分以下\)/
  );
  // 【★この2つが両立していることが要件★】実測4件は参考行 / 盲点は署名。
  const measuredSignatures = MEASURED_2026_08_05.map(
    (c) => monitor.probeMetrics({ probeVerdicts: measuredVerdicts(c) }).signature
  );
  assert.deepEqual(measuredSignatures, [false, false, false, false], '実測4件のどれかに★が戻っている');
});

test('★形状比較: 当月以降を名乗る投稿が採用より大きければ、半分以下でなくても★(レビュー部の条件)', () => {
  const m = monitor.probeMetrics({
    probeVerdicts: [
      { index: 0, permalink: 'p/ADOPTED/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 20, spanDays: 30 },
      { index: 1, permalink: 'p/BIGGER/', kind: 'calendar-current', dominantMonth: '2026-08', distinctDates: 21, spanDays: 30 },
    ],
  });
  assert.equal(m.signature, true);
  assert.deepEqual(m.signatureReasons, ['month'], '半分以下ではないので month だけで立つこと');
});

/**
 * `tools/monitor-instagram-apify.js` に文字列置換の変異を当てた【別インスタンス】を読み込む。
 *
 * 【なぜ変異まで当てるか】この案件は #35 / #36 / #38 / readme-consistency で
 * 「検知器は作ったが、値を渡す配線が効いていない」を4回出している。
 * ★の条件は**片方向だけ**を確かめても足りない —
 * 「絞りすぎ(盲点で鳴らない)」と「絞れていない(実測4件で鳴る)」は別の壊れ方なので、
 * **両方向それぞれについて、条件を壊すと結果が変わること**を機械で固定する。
 */
function requireMutatedMonitor(from, to) {
  const root = makeTempRepoRoot();
  const p = path.join(root, 'tools', 'monitor-instagram-apify.js');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `変異の当て先が見つからない(テストの前提が古い): ${from}`);
  fs.writeFileSync(p, src.split(from).join(to));
  const mod = require(p);
  fs.rmSync(root, { recursive: true, force: true });
  return mod;
}

test('★形状比較(変異): 「半分以下」の条件を消すと、盲点の再現で★が消える', () => {
  const mutated = requireMutatedMonitor(
    "  if (adopted.distinctDates * 2 <= strongest.distinctDates) reasons.push('half');",
    '  // 変異: 半分以下の条件を消した'
  );
  const m = mutated.probeMetrics({ probeVerdicts: blindSpotVerdicts() });
  assert.equal(m.signature, false, '変異が効いていない(この変異で★が消えないなら、上の盲点テストは何も守っていない)');
  // 変異していない本物では立つ
  assert.equal(monitor.probeMetrics({ probeVerdicts: blindSpotVerdicts() }).signature, true);
});

test('★形状比較(変異): 支配月の条件を「常に真」にすると、実測4件に★が戻る', () => {
  const mutated = requireMutatedMonitor(
    "  if (adopted.dominantMonth && strongest.dominantMonth && strongest.dominantMonth >= adopted.dominantMonth) {",
    '  if (true) {'
  );
  const back = MEASURED_2026_08_05.map(
    (c) => mutated.probeMetrics({ probeVerdicts: measuredVerdicts(c) }).signature
  );
  assert.deepEqual(back, [true, true, true, true],
    '変異が効いていない(絞りを外しても★が戻らないなら、実測4件のテストは何も守っていない)');
});

/** 指定した投稿列で `--probe` を回す(古い順に渡す)。rows は投稿ごとの Vision 応答。 */
function runProbeCliWithPosts(posts) {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const POSTS = ${JSON.stringify(
      posts.map((p, i) => ({
        permalink: `https://www.instagram.com/p/${p.slug}/`,
        imageUrl: `https://example.com/${i}.jpg`,
        postedAt: p.postedAt,
        caption: '',
      }))
    )};
     exports.fetchInstagramPosts = async (handle) => (handle === 'triple_orio' ? POSTS : []);\n`
  );
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const ROWS = ${JSON.stringify(posts.map((p) => p.rows))};
     exports.extractTournaments = async (buf) => ROWS[Number(String(buf).replace('https://example.com/', '').replace('.jpg', ''))];\n`
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  const r = spawnSync('node', ['--require', './stub-fetch.js', 'tools/monitor-instagram-apify.js', '--probe'], {
    cwd: root,
    env: { ...process.env, APIFY_API_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' },
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return r;
}

/** `month`(YYYY-MM)の指定日に1件ずつ大会を置いた行を作る。 */
function calendarRows(month, days) {
  return days.map((d) => ({ date: `${month}-${String(d).padStart(2, '0')}`, start: '19:00', name: `T${d}`, buyin: 3000, tags: [] }));
}

test('★CLI(探索): 採用より強い投稿が後ろに居たら ::warning:: と1行要約が出る(分類では見えない場合も)', () => {
  // 【盲点をそのまま再現する】本物(20日付)の支配月を過去月にしてある =
  // 分類ベースの「採用より古い位置にある当月以降のカレンダー」は 0 になる。
  // それでも形の比較は効くこと、を1回のCLI実行で見る。
  const r = runProbeCliWithPosts([
    { slug: 'REAL', postedAt: '2026-07-10T10:00:00.000Z', rows: calendarRows('2026-06', [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 30, 2, 4, 6, 8]) },
    { slug: 'SERIES', postedAt: '2026-07-12T10:00:00.000Z', rows: calendarRows('2099-09', [3, 10, 17, 24, 30]) },
  ]);
  assert.equal(r.status, 0, r.stderr);
  // 分類ベースの数字は 0(=盲点が実在する)
  assert.match(r.stdout, /採用より【古い位置】にある当月以降のカレンダー: 0件/);
  // 形の比較は効く
  assert.match(r.stdout, /形状比較: .*採用=異なる日付5・広がり27日/);
  assert.match(r.stdout, /★採用は窓内で最もカレンダーらしい投稿ではない\(#13 の署名: /);
  // 【★1行要約だけで2枚の画像に到達できること(実出力で確かめる)★】
  const shapeLine = r.stdout.split('\n').find((l) => l.includes('形状比較: '));
  assert.ok(shapeLine, '形状比較の1行要約が出ていない');
  assert.ok(shapeLine.includes('/p/SERIES/'), `採用側のURLが1行要約に無い: ${shapeLine}`);
  assert.ok(shapeLine.includes('/p/REAL/'), `窓内の最大のURLが1行要約に無い: ${shapeLine}`);
  assert.equal(
    (shapeLine.match(/https:\/\/www\.instagram\.com\/p\/[A-Z]+\//g) || []).length,
    2,
    `1行要約に2つの投稿URLが揃っていない(別の行を探させることになる): ${shapeLine}`
  );
  assert.match(r.stdout, /::warning title=Instagram監視 - 採用が最もカレンダーらしい投稿ではない::/);
  assert.match(r.stdout, /★#13 の署名が出た店 1店\(参考: 採用が窓内の最大でない店 0店\)/);
});

test('★CLI(探索・実測の再現): 過去月のカレンダーが最大でも ::warning:: を出さず、参考行だけ残す', () => {
  // 実走 run 30963380537 の v18 と同じ形(採用=当月26日付 / 窓内の最大=過去月30日付)。
  // 当時はこれで★が点いたが、画像で確認すると誤警報だった。
  const r = runProbeCliWithPosts([
    { slug: 'PAST', postedAt: '2026-05-28T10:00:00.000Z', rows: calendarRows('2026-06', Array.from({ length: 30 }, (_, i) => i + 1)) },
    { slug: 'ADOPTED', postedAt: '2026-07-27T10:00:00.000Z', rows: calendarRows('2099-09', Array.from({ length: 26 }, (_, i) => i + 1)) },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /::warning title=Instagram監視 - 採用が最もカレンダーらしい投稿ではない::/,
    '過去月のカレンダーが最大なだけで警報を出してはいけない(実走で6店中4店が全部これだった)');
  // 【比較そのものは消していない】参考行に、採用と窓内の最大の両方が残ること
  const shapeLine = r.stdout.split('\n').find((l) => l.includes('形状比較: '));
  assert.ok(shapeLine, '形状比較の1行要約が出ていない');
  assert.match(shapeLine, /参考: 窓内の最大は採用より大きい\(26→30\)/, shapeLine);
  assert.ok(shapeLine.includes('/p/ADOPTED/') && shapeLine.includes('/p/PAST/'), `参考行に2枚のURLが揃っていない: ${shapeLine}`);
  assert.match(r.stdout, /★#13 の署名が出た店 0店\(参考: 採用が窓内の最大でない店 1店\)/);
});

test('★CLI(探索): 採用が窓内で最強なら ::warning:: を出さない(両方向を固定する)', () => {
  const r = runProbeCliWithPosts([
    { slug: 'OLDCAL', postedAt: '2026-07-10T10:00:00.000Z', rows: calendarRows('2026-06', [1, 5, 9, 13, 17]) },
    { slug: 'REAL', postedAt: '2026-07-12T10:00:00.000Z', rows: calendarRows('2099-09', [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29]) },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /形状比較: .*採用が窓内で最もカレンダーらしい投稿/);
  assert.doesNotMatch(r.stdout, /採用が最もカレンダーらしい投稿ではない/, '最強なのに印が出てはいけない');
  assert.match(r.stdout, /★#13 の署名が出た店 0店\(参考: 採用が窓内の最大でない店 0店\)/);
});

// ============================================================
// リスク台帳 #22: 確認済み投稿日時が【未来】= 静かな永久停止
// ============================================================
// 【この検知が「両方向を実データで示す」規律の対象外である理由】
// 禁じられているのは【閾値や経験則にもとづく警報で、鳴る側を実データで示せないもの】。
// これは【矛盾】の検出で、投稿日時が現在より未来という状態は物理的に存在しない。
// ありえない状態の検出は仮説の検証ではないので、鳴る側の実データを要さない。
// (それでも下では「鳴る/鳴らない」を両方固定してある。安いので)

test('★#22: 未来の確認済み投稿日時だけを矛盾として検出する(境界を含む)', () => {
  const today = '2026-08-05';
  // JSTの 2026-08-05 は UTC 2026-08-05T15:00Z に終わる。そこから更に24時間が上限。
  assert.equal(monitor.impossibleLastPostedAt({ lastPostedAt: '2026-08-05T10:00:00.000Z' }, today), null, '当日は矛盾ではない');
  assert.equal(monitor.impossibleLastPostedAt({ lastPostedAt: '2026-08-06T14:59:00.000Z' }, today), null, '余裕の内側では鳴らさない');
  assert.equal(monitor.impossibleLastPostedAt({ lastPostedAt: '2020-01-01T00:00:00.000Z' }, today), null, '過去は正常');
  const hit = monitor.impossibleLastPostedAt({ lastPostedAt: '2026-08-06T15:01:00.000Z' }, today);
  assert.ok(hit, '余裕を超えた未来は矛盾として検出すること');
  assert.equal(hit.value, '2026-08-06T15:01:00.000Z');
  assert.ok(hit.boundary, 'ありえる上限を人に見せること');
  assert.ok(monitor.impossibleLastPostedAt({ lastPostedAt: '2099-01-01T00:00:00.000Z' }, today));
  // 記録が無い / 読めない値は対象外(どちらも「全投稿が新着」に倒れるので静かな停止にならない)
  assert.equal(monitor.impossibleLastPostedAt(null, today), null);
  assert.equal(monitor.impossibleLastPostedAt({}, today), null);
  assert.equal(monitor.impossibleLastPostedAt({ lastPostedAt: 'これは日付ではない' }, today), null);
});

test('★#22: 未来の記録がある店は【新着0件】になり、その事実が summary に残る(静かな停止の再現)', async () => {
  const state = { v40: { handle: 'triple_orio', lastPostedAt: '2099-01-01T00:00:00.000Z' } };
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/CAL/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
    ])
  );
  const s = result.summaries[0];
  assert.equal(s.newPostCount, 0, '取得できた投稿がすべて「既読」に落ちること(=停止している)');
  assert.equal(s.alreadySeenCount, 1);
  assert.ok(s.impossibleLastPostedAt, 'その原因が summary に記録されること');
  assert.equal(s.impossibleLastPostedAt.value, '2099-01-01T00:00:00.000Z');
  // 【機械は値を戻さない】戻すと窓を読み直し、人が消した行が復活しうる(#15)
  assert.equal(result.state.v40.lastPostedAt, '2099-01-01T00:00:00.000Z', '自動で書き換えてはいけない');
});

test('★CLI(#22): 未来の記録があると ::error:: を出すが、ジョブは落とさず値も戻さない', () => {
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root);
  const broken = { v40: { handle: 'triple_orio', lastPostedAt: '2099-01-01T00:00:00.000Z' } };
  fs.writeFileSync(path.join(root, 'apify-monitor-state.json'), `${JSON.stringify(broken, null, 2)}\n`);
  try {
    const r = runCliArgs(root);
    assert.equal(r.status, 0, `ジョブは落とさない(#19 と同じ理由): ${r.stderr}`);
    assert.match(r.stdout, /::error title=Instagram監視 - 確認済み投稿日時が未来になっています::/);
    assert.match(r.stdout, /未来の確認済み投稿日時: 店=TripleBarrel 折尾店\(v40\)/);
    assert.match(r.stdout, /人が消した行が復活/, '自動で戻さない理由(#15)を人に伝えること');
    assert.match(r.stdout, /直し方:/);
    // 機械が値を戻していないこと(戻すと窓を読み直して #15 が発動する)
    const after = JSON.parse(fs.readFileSync(path.join(root, 'apify-monitor-state.json'), 'utf8'));
    assert.equal(after.v40.lastPostedAt, '2099-01-01T00:00:00.000Z', '機械が勝手に直してはいけない');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('★CLI(#22): 記録が正常な回には「未来になっています」を出さない(両方向を固定する)', () => {
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root);
  // 【★実在する過去の記録を、境界のすぐ内側に置くこと★】
  // 空の `{}` だと `lastPostedAt` が無く、判定が値の有無で先に return するので
  // 【境界の判定を一度も通らない】。それだと「常に矛盾とみなす」変異も
  // 「境界をずらす」変異もこのテストを素通りする(実測でそうなった)。
  // 昨日の投稿 = 毎朝の実行でいちばんよくある正常値。ここで鳴ったら誤検知。
  const yesterday = addDaysJst(monitor.todayJst(), -1);
  fs.writeFileSync(
    path.join(root, 'apify-monitor-state.json'),
    `${JSON.stringify({ v40: { handle: 'triple_orio', lastPostedAt: `${yesterday}T10:00:00.000Z` } }, null, 2)}\n`
  );
  try {
    const r = runCliArgs(root);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /確認済み投稿日時が未来になっています/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 静かな停止の測定(警報ではない) ----------

test('★測定: 取込みが成立した日を記録し、そこからの日数を毎回出す', async () => {
  const run1 = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/CAL/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
    ])
  );
  assert.equal(run1.summaries[0].lastImportedAt, '2026-07-31', '行が増えた日が「成立した日」');
  assert.equal(run1.state.v40.lastImportedAt, '2026-07-31', '状態ファイルにも残ること(runログは90日で消える)');

  // 翌月: 新着はあるがカレンダーではない = 取込みは成立しない → 前回値を持ち越す
  const run2 = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: run1.arr, today: '2026-08-20', state: run1.state },
    fakeLibsForBehaviour([
      {
        permalink: 'https://www.instagram.com/p/PHOTO/',
        postedAt: '2026-08-19T10:00:00.000Z',
        rows: [{ date: '2099-09-12', start: '19:00', name: '単発トナメ', buyin: 3000, tags: [] }],
      },
    ])
  );
  assert.equal(run2.summaries[0].lastImportedAt, '2026-07-31', '成立していない日は前回値のまま');
  assert.equal(run2.state.v40.lastImportedAt, '2026-07-31');
  assert.equal(monitor.daysBetween('2026-08-20', run2.summaries[0].lastImportedAt), 20);

  const line = monitor.formatImportAges(run2.summaries, '2026-08-20');
  assert.match(line, /v40=20日/);
  assert.match(line, /警報ではなく測定/, '閾値を置かないことを文面で明示する(常時点灯を作らない)');

  // 【★「変更なし」を成立に数えないこと】同じカレンダーを読み直しただけの回を成立にすると、
  // その投稿が取得窓に残っている限り毎日「成立」になり、【止まっていることが見えなくなる】。
  const run3 = await monitor.runMonitor(
    {
      stores: [monitor.STORES[0]],
      before: run1.arr,
      today: '2026-09-01',
      state: { v40: { handle: 'triple_orio', lastPostedAt: '2026-07-19T00:00:00.000Z', lastImportedAt: '2026-07-31' } },
      // 【控えを渡す】渡さないと既存行が全部「人のもの」扱いになり、`unchanged` ではなく
      // 「人の行を守って見送り」に入る(PR #35 の規則)。ここで見たいのは前者。
      writeRecords: run1.written,
    },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/CAL/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
    ])
  );
  assert.equal(run3.summaries[0].stats.unchanged, FILLER_COUNT, '同じ内容を読み直した回であること(テストの前提)');
  assert.equal(run3.summaries[0].stats.added + run3.summaries[0].stats.updated, 0);
  assert.equal(run3.summaries[0].lastImportedAt, '2026-07-31', '「変更なし」だけの回を成立にしてはいけない');
});

test('★測定: 一度も取り込めていない店は「未成立」と出す(0日と混同しない)', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {} },
    { fetchLib: { async fetchInstagramPosts() { return []; } }, visionLib: {}, mergeLib, downloadImage: async () => Buffer.from('') }
  );
  assert.equal(result.summaries[0].lastImportedAt, null);
  assert.match(monitor.formatImportAges(result.summaries, '2026-07-31'), /v40=未成立/);
});

test('★CLI: 取込みの日数は【毎回必ず】出る(静かな停止に気づく唯一の常設チャネル)', () => {
  const root = makeTempRepoRoot();
  writeSingleCalendarStubs(root, { posts: [] }); // どの店も新着なし = いちばん「何も起きない」回
  try {
    const r = runCliArgs(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /取込みが成立してからの日数: /, '何も起きない回でも出ること');
    for (const s of monitor.STORES) assert.match(r.stdout, new RegExp(`${s.venueId}=未成立`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 探索が【最後まで走ったか】— 部分的な分布を「全部見た」と読ませない
// ============================================================
// 【なぜ要るか】探索は打ち切らないので取得窓の全投稿が Vision に渡る。途中でジョブが
// 打ち切られると【一部だけ見た分布】がログに残り、それを「全投稿を見た」と読むと
// #13 を誤った根拠で閉じることになる。ワークフローはこの行の有無と内容を検査している。

test('★完走: 全店・全投稿を判定できた実行は「★完走」と出る', async () => {
  const result = await monitor.runMonitor(
    { stores: [monitor.STORES[0]], before: [], today: '2026-07-31', state: {}, probe: true },
    fakeLibsForBehaviour([
      { permalink: 'https://www.instagram.com/p/A/', postedAt: '2026-07-20T10:00:00.000Z', rows: fillerRows('2099-09') },
      { permalink: 'https://www.instagram.com/p/B/', postedAt: '2026-07-21T10:00:00.000Z', rows: [] },
    ])
  );
  const c = monitor.probeCompletion(result.summaries, 1);
  assert.equal(c.complete, true);
  assert.equal(c.targeted, 2);
  assert.equal(c.judged, 2, '判定対象と判定できた数が一致すること');
  assert.equal(c.failed, 0);
  const line = monitor.formatProbeCompletion(c);
  assert.match(line, /探索の完了状態: /, 'ワークフローが探す機械可読の目印');
  assert.match(line, /判定した投稿 2件\(判定対象 2件\)/);
  assert.match(line, /★完走/);
  assert.doesNotMatch(line, /★不完全/);
});

test('★完走: 取得に失敗した店があれば「★不完全」になる(その店は1投稿も見ていない)', async () => {
  const result = await monitor.runMonitor(
    { stores: monitor.STORES.slice(0, 2), before: [], today: '2026-07-31', state: {}, probe: true },
    {
      fetchLib: {
        async fetchInstagramPosts(handle) {
          if (handle === monitor.STORES[1].handle) throw new Error('timeout');
          return [{ permalink: 'https://www.instagram.com/p/A/', imageUrl: 'https://example.com/0.jpg', postedAt: '2026-07-20T10:00:00.000Z' }];
        },
      },
      visionLib: { async extractTournaments() { return fillerRows('2099-09'); } },
      mergeLib,
      downloadImage: async (u) => Buffer.from(u),
    }
  );
  const c = monitor.probeCompletion(result.summaries, 2);
  assert.equal(c.complete, false);
  assert.equal(c.failed, 1);
  const line = monitor.formatProbeCompletion(c);
  assert.match(line, /★不完全/);
  assert.match(line, /取得に失敗した店 1店/);
  assert.match(line, /#13 の判断に使わないでください/);
});

test('★完走: 判定が記録されていない投稿があれば「★不完全」になる(打ち切られた形)', () => {
  // 走査の途中で終わると、判定対象より判定済みが少なくなる。実行が殺されるとこの行自体が
  // 出ないが、ここでは「行は出たが数が合わない」側(記録漏れ)を固定する。
  const summaries = [
    { store: monitor.STORES[0], fetchFailed: false, scheduleLikeCount: 10, probeVerdicts: [{ kind: 'not-calendar' }, { kind: 'empty' }] },
  ];
  const c = monitor.probeCompletion(summaries, 1);
  assert.equal(c.complete, false);
  assert.equal(c.targeted, 10);
  assert.equal(c.judged, 2);
  const line = monitor.formatProbeCompletion(c);
  assert.match(line, /★不完全/);
  assert.match(line, /判定できていない投稿 8件/);
});

test('★完走: 店の記録そのものが欠けていても「★不完全」になる(残差で数えていないこと)', () => {
  // 対象6店なのに summaries が1店ぶんしか無い = どこかで push を忘れた形。
  const summaries = [
    { store: monitor.STORES[0], fetchFailed: false, scheduleLikeCount: 1, probeVerdicts: [{ kind: 'empty' }] },
  ];
  const c = monitor.probeCompletion(summaries, monitor.STORES.length);
  assert.equal(c.complete, false);
  assert.equal(c.missingStores, monitor.STORES.length - 1);
  assert.match(monitor.formatProbeCompletion(c), /記録が無い店/);
});

test('★CLI(探索): 完走マーカーがログの最後に1行だけ出る(ワークフローが検査する行)', () => {
  const r = runProbeCliWithPosts([
    { slug: 'OLDCAL', postedAt: '2026-07-10T10:00:00.000Z', rows: calendarRows('2026-06', [1, 5, 9, 13, 17]) },
    { slug: 'REAL', postedAt: '2026-07-12T10:00:00.000Z', rows: calendarRows('2099-09', [1, 5, 9, 13, 17, 21, 25, 29]) },
  ]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.includes('探索の完了状態:'));
  assert.equal(lines.length, 1, '完走マーカーは1行だけ出すこと(複数あると grep の判定が揺れる)');
  assert.match(lines[0], /対象6店 = 観測できた6店 \+ 取得失敗0店/);
  assert.match(lines[0], /★完走/);
});

test('★CLI(探索): 取得に失敗した店があると完走マーカーが「★不完全」になり、終了コードも2', () => {
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `exports.fetchInstagramPosts = async (handle) => {
       if (handle === 'triple_orio') throw new Error('模擬的なApify障害(テスト用)');
       return [];
     };\n`
  );
  fs.writeFileSync(path.join(root, 'tools', 'venue-schedule-vision.js'), calendarVisionStubSource('x'));
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    const r = runCliArgs(root, ['--probe']);
    assert.equal(r.status, 2, '一部の店を観測できていないので終了コードは2');
    const line = r.stdout.split('\n').find((l) => l.includes('探索の完了状態:'));
    assert.ok(line, '完走マーカーが出ていない');
    assert.match(line, /★不完全/);
    assert.match(line, /取得に失敗した店 1店/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 店ごとの掲載ルール(社長指示・2026-08-05) — 取込み経路での【配線】
// ============================================================
// 【なぜ純関数のテスト(tools/venue-listing-rules.test.js)だけでは足りないか】
// 判定が正しくても、その結果が `data.js` に届くまでのどこかで落ちれば意味がない。
// この案件は同じ形で一度やられている(⚠ 要確認 の判定は正しかったのに、
// `toTournament` の呼び出しが印を落としていれば誰も気づけなかった)。
// ここでは **runMonitor を通した結果の行そのもの** と **保存則の数字** を見る。
//
// 【★平常時ほとんど動かない規則なので、両方向を必ず固定する★】
//   ・除外すべき行が除外される / 参加費が消える
//   ・**除外すべきでない行が残る**(とくに他店の `大還元`)/ 対象外の店の参加費は消えない

const listingRulesLib = require('./venue-listing-rules');

const STORE_V40 = monitor.STORES.find((s) => s.venueId === 'v40');
const STORE_V20 = monitor.STORES.find((s) => s.venueId === 'v20');
const STORE_V18 = monitor.STORES.find((s) => s.venueId === 'v18');
const STORE_V35 = monitor.STORES.find((s) => s.venueId === 'v35');

test('★掲載ルール(v35): 参加費は0も金額も記録しない。⚠も付かない', async () => {
  // 試験実行 run `30973996821` の v35 の形(FREE ROLL系=0 / 金額あり / 参加費なし)を再現する。
  const result = await monitor.runMonitor(
    { stores: [STORE_V35], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(
      asCalendar(
        [
          { date: '2099-09-02', name: '1周年記念 FREE ROLL', buyin: 0, tags: ['フリーロール'] },
          { date: '2099-09-05', name: 'Super ハイローラーTOURNAMENT', buyin: 1000, tags: [] },
          { date: '2099-09-06', name: 'ランキングPT付バウンティTOURNAMENT', buyin: 400, tags: [] },
          { date: '2099-09-08', name: 'WIN THE BUTTON', buyin: null, tags: [] },
        ],
        '2099-09'
      )
    )
  );
  const rows = realRows(result.arr).filter((t) => t.venueId === 'v35');
  assert.equal(rows.length, 4, '行そのものは1件も捨てない(消すのは参加費だけ)');
  for (const t of rows) {
    assert.equal(t.buyin, null, `参加費を記録してはいけない: ${t.name}`);
    // 参加費が無い行に「参加費が名前由来かもしれない」印を付けると、存在しない値の確認を
    // ⑤に依頼することになる(FREE ROLL 系だけで毎月7件前後の常時点灯になる)。
    assert.equal(t.lowConfidence, undefined, `⚠を付けてはいけない: ${t.name}`);
    assert.ok(!('lowConfidence' in t), '平常の行にキー自体を生やさない(差分を汚さない)');
  }
  // 参加費以外は触らない
  assert.deepEqual(rows.find((t) => t.name === '1周年記念 FREE ROLL').tags, ['フリーロール']);

  const s = result.summaries[0];
  // 【保存則】その店の採用行 = 参加費を捨てた行 + 元から参加費が無かった行
  const acc = monitor.checkVenueRuleAccounting(s);
  assert.equal(acc.applies, true);
  // 主張したい3行(0 / 1000 / 400)に加え、カレンダー判定用の埋め行(buyin:3000 が FILLER_COUNT 行)も
  // この店では参加費を捨てられる。埋め行の性質は「★ヘルパ自体の健全性」テストが固定している。
  assert.equal(acc.suppressed, 3 + FILLER_COUNT, '読み取れていた参加費を捨てた行(0 も含む)');
  assert.equal(acc.absent, 1, '元から参加費が無かった行');
  assert.equal(acc.accepted, 4 + FILLER_COUNT, '採用行の総数と突き合わせていること');
  assert.equal(acc.residual, 0, '★残余が出ないこと(数え漏らしがない)');
  assert.ok(acc.ok);
  // 他の保存則も同時に成り立つ(項を1つ足した影響が出ていないこと)
  assert.ok(monitor.checkRowAccounting(s).ok, JSON.stringify(monitor.checkRowAccounting(s)));
  assert.ok(monitor.checkPostAccounting(s).ok);
});

test('★掲載ルール(v35・逆方向): 同じ行でも他店なら参加費はそのまま残る', async () => {
  // 【これが本命】規則が「全店で参加費を消す」に化けると、他店の参加費が静かに消える。
  // 表示は「詳細は店舗SNSを確認」に変わるだけなので、サイトを見ても壊れたと分からない。
  const result = await monitor.runMonitor(
    { stores: [STORE_V40], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(
      asCalendar(
        [
          { date: '2099-09-02', name: 'FST SATELLITE', buyin: 3000, tags: [] },
          { date: '2099-09-05', name: 'TAGマッチ', buyin: 0, tags: ['フリーロール'] },
        ],
        '2099-09'
      )
    )
  );
  const rows = realRows(result.arr).filter((t) => t.venueId === 'v40');
  assert.equal(rows.find((t) => t.name === 'FST SATELLITE').buyin, 3000);
  assert.equal(rows.find((t) => t.name === 'TAGマッチ').buyin, 0, '0(無料)も他店では読み取れた値として残す');
  const acc = monitor.checkVenueRuleAccounting(result.summaries[0]);
  assert.equal(acc.applies, false, 'v40 は参加費の非記録の対象ではない');
  assert.equal(acc.suppressed, 0);
  assert.equal(acc.absent, 0);
});

test('★掲載ルール(v40): 「大還元」を含む行を除外し、件数と明細を残す', async () => {
  const result = await monitor.runMonitor(
    { stores: [STORE_V40], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(
      asCalendar(
        [
          { date: '2099-09-06', name: 'チップ大還元', buyin: null, tags: [] },
          { date: '2099-09-16', name: 'スーパー大還元', buyin: null, tags: [] },
          { date: '2099-09-07', name: 'FST SATELLITE', buyin: null, tags: [] },
          { date: '2099-09-08', name: 'TAGマッチ', buyin: 3000, tags: [] },
        ],
        '2099-09'
      )
    )
  );
  const names = realRows(result.arr)
    .filter((t) => t.venueId === 'v40')
    .map((t) => t.name)
    .sort();
  assert.deepEqual(names, ['FST SATELLITE', 'TAGマッチ'], '除外した2行だけが消え、正当な大会は残ること');

  const s = result.summaries[0];
  assert.equal(s.venueRuleDroppedCount, 2, '除外した行数を数えること(黙って消さない)');
  assert.deepEqual(s.venueRuleDropped.map((r) => r.name).sort(), ['スーパー大還元', 'チップ大還元']);
  // 破棄ログの理由に、語・根拠・指示日が読める形で入っていること
  const dropped = s.dropped.filter((d) => d.kind === 'venue-rule');
  assert.equal(dropped.length, 2);
  for (const d of dropped) {
    assert.match(d.reason, /店ごとの掲載ルールで除外/);
    assert.match(d.reason, /「大還元」/);
    assert.match(d.reason, /推定/, '根拠が推定であることが破棄ログにも残ること');
  }
  // 【保存則】除外した行は「破棄」に数えられているので残余は出ない
  const row = monitor.checkRowAccounting(s);
  assert.ok(row.ok, JSON.stringify(row));
  assert.equal(row.residual, 0);
  assert.ok(monitor.checkPostAccounting(s).ok);
});

test('★掲載ルール(v20): 「華金」を含む行を除外する', async () => {
  const result = await monitor.runMonitor(
    { stores: [STORE_V20], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(
      asCalendar(
        [
          { date: '2099-09-07', name: '華金', buyin: null, tags: [] },
          { date: '2099-09-21', name: '華金', buyin: null, tags: [] },
          { date: '2099-09-08', name: 'Cエントリートナメ', buyin: null, tags: [] },
          { date: '2099-09-09', name: 'DEEP STACK', buyin: null, tags: [] },
        ],
        '2099-09'
      )
    )
  );
  const names = realRows(result.arr)
    .filter((t) => t.venueId === 'v20')
    .map((t) => t.name)
    .sort();
  assert.deepEqual(names, ['Cエントリートナメ', 'DEEP STACK']);
  const s = result.summaries[0];
  assert.equal(s.venueRuleDroppedCount, 2);
  assert.match(s.dropped.find((d) => d.kind === 'venue-rule').reason, /不明/, '「分からないから除外」が残ること');
  assert.ok(monitor.checkRowAccounting(s).ok);
});

test('★掲載ルール(逆方向・これが本命): 他店の「大還元」は取込み経路でも落ちない', async () => {
  // v18(Poker Bar IRIS)は【監視対象6店の1つ】で、実データに `大還元フリロ` `月末大還元` がある。
  // 除外を全店に効かせると、この店の正当な大会が毎月静かに消える。
  const result = await monitor.runMonitor(
    { stores: [STORE_V18], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(
      asCalendar(
        [
          { date: '2099-09-01', name: '大還元フリロ', buyin: null, tags: [] },
          { date: '2099-09-25', name: '月末大還元', buyin: null, tags: [] },
          { date: '2099-09-07', name: '華金', buyin: null, tags: [] },
        ],
        '2099-09'
      )
    )
  );
  const names = realRows(result.arr)
    .filter((t) => t.venueId === 'v18')
    .map((t) => t.name)
    .sort();
  assert.deepEqual(names, ['大還元フリロ', '月末大還元', '華金'].sort(), '他店の同名大会は1件も落とさないこと');
  assert.equal(result.summaries[0].venueRuleDroppedCount, 0);
  assert.equal(result.summaries[0].dropped.filter((d) => d.kind === 'venue-rule').length, 0);
});

test('★掲載ルール: 全行が除外対象の投稿は【異常にしない】(空振りの赤を作らない)', async () => {
  // 抽出行はあるのに1件も採用できない投稿は通常 ::error::(全行不採用)になる。
  // 掲載ルールで全行落ちた場合は【指示どおりの正常動作】なので、専用のバケツに入れる。
  const result = await monitor.runMonitor(
    { stores: [STORE_V40], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor([
      { date: '2099-09-01', name: 'チップ大還元', buyin: null, tags: [] },
      { date: '2099-09-06', name: 'チップ大還元', buyin: null, tags: [] },
      { date: '2099-09-10', name: 'スーパー大還元', buyin: null, tags: [] },
      { date: '2099-09-14', name: 'チップ大還元', buyin: null, tags: [] },
      { date: '2099-09-17', name: 'チップ大還元', buyin: null, tags: [] },
      { date: '2099-09-23', name: 'チップ大還元', buyin: null, tags: [] },
    ])
  );
  const s = result.summaries[0];
  assert.equal(s.venueRuleOnlyPostCount, 1, '専用のバケツに入ること');
  assert.equal(s.unusablePostCount, 0, '「全行不採用」の異常にしないこと');
  assert.equal(result.anomalies.length, 0, '::error:: を出さないこと');
  assert.equal(s.venueRuleDroppedCount, 6);
  // 保存則は全部成り立つ(バケツを1つ足した影響が出ていないこと)
  assert.ok(monitor.checkPostAccounting(s).ok, JSON.stringify(monitor.checkPostAccounting(s)));
  assert.ok(monitor.checkRowAccounting(s).ok, JSON.stringify(monitor.checkRowAccounting(s)));
  assert.equal(s.posts.find((p) => p.rowCount === 6).outcome, '全行が掲載ルールで除外');
});

test('★掲載ルール: 除外0件・参加費0件の実行でも必ずログに出る(鳴らない警報にしない)', async () => {
  // 【この規則は平常ほとんど動かない】件数が出るときだけ出力する形にすると、
  // 「今日は対象が無かった」と「判定が死んだ」が同じ無出力になって区別が付かない。
  const result = await monitor.runMonitor(
    { stores: [STORE_V18], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(asCalendar([{ date: '2099-09-01', name: 'FST SATELLITE', buyin: null, tags: [] }], '2099-09'))
  );
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportVenueListingRules(result.summaries);
  } finally {
    console.log = orig;
  }
  const text = lines.join('\n');
  assert.match(text, /店ごとの掲載ルール/);
  // 3つの規則すべてが、0件でも名前と件数つきで出ること
  assert.match(text, /参加費を記録しない: A&K\(v35\)/);
  assert.match(text, /除外: TripleBarrel 折尾店\(v40\) — 大会名に「大還元」を含む行 0件/);
  assert.match(text, /除外: KING&QUEEN SUITED 直方店\(v20\) — 大会名に「華金」を含む行 0件/);
  // 理由(なぜそうするのか)もログに出る
  assert.match(text, /店内通過価格/);
  assert.match(text, /おそらく/);
  assert.match(text, /なにかわからない/);
  // 【::warning:: にはしない】正常動作なので、警告チャネルを常時点灯させない
  assert.ok(!lines.some((l) => l.startsWith('::warning')), '正常動作を警告チャネルに載せないこと');
  assert.ok(!lines.some((l) => l.startsWith('::error')), '正常動作を赤にしないこと');
});

test('★掲載ルール: 除外した行の明細が、件数と一緒にログへ出る', async () => {
  const result = await monitor.runMonitor(
    { stores: [STORE_V40], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(
      asCalendar([{ date: '2099-09-06', name: 'チップ大還元', buyin: null, tags: [] }], '2099-09')
    )
  );
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    monitor.reportVenueListingRules(result.summaries);
  } finally {
    console.log = orig;
  }
  const text = lines.join('\n');
  assert.match(text, /大会名に「大還元」を含む行 1件/);
  assert.match(text, /除外行: v40 \/ 2099-09-06 \/ チップ大還元 \/ https:\/\/www\.instagram\.com\/p\/FAKE\//);
});

// ---------- 検知器そのものと、そこへ値を渡す【配線】の両方に変異を当てる ----------
// 【定型(README「検知器を試したら配線にも変異を当てる」)】
// 事後条件 `assertListingRulesApplied` は良性の入力では絶対に鳴らないので、
// 「本当に呼ばれているのか」を確かめないと、呼び出しを消す変異が静かに生き残る。
//
// 【この2本が変異になる仕組み】
//   `tools/monitor-instagram-apify.js` は `listingRules.buyinNotRecorded(...)` のように
//   **モジュールオブジェクト経由**で規則を引く。一方 `listingRuleViolations` は
//   同じファイル内の**ローカル束縛**を呼ぶ。したがって export を差し替えると
//   【規則の適用だけが止まり、検知器は生きたまま】になる = 事後条件が鳴るはず。
// ★もし将来 monitor 側が `const { buyinNotRecorded } = require(...)` に変わると、
//   差し替えが効かなくなってこのテストは【落ちる】(緑のまま無意味化はしない)。
async function withPatchedRule(name, fn) {
  const original = listingRulesLib[name];
  listingRulesLib[name] = () => null;
  try {
    return await fn();
  } finally {
    listingRulesLib[name] = original;
  }
}

test('★配線(変異): 参加費の非記録が止まったら、書き込み前の事後条件が鳴って止まる', async () => {
  await withPatchedRule('buyinNotRecorded', async () => {
    await assert.rejects(
      () =>
        monitor.runMonitor(
          { stores: [STORE_V35], before: [], today: '2026-07-31', state: {} },
          fakeLibsFor(asCalendar([{ date: '2099-09-02', name: 'FREE ROLL', buyin: 0, tags: [] }], '2099-09'))
        ),
      (e) => /掲載ルールが適用されていない行/.test(e.message) && /buyin-not-suppressed/.test(e.message)
    );
  });
  // 差し戻した後は正常に通る(パッチの後始末ができていること)
  const result = await monitor.runMonitor(
    { stores: [STORE_V35], before: [], today: '2026-07-31', state: {} },
    fakeLibsFor(asCalendar([{ date: '2099-09-02', name: 'FREE ROLL', buyin: 0, tags: [] }], '2099-09'))
  );
  assert.equal(realRows(result.arr).find((t) => t.venueId === 'v35').buyin, null);
});

test('★配線(変異): 名前による除外が止まったら、書き込み前の事後条件が鳴って止まる', async () => {
  await withPatchedRule('excludedByListingRule', async () => {
    await assert.rejects(
      () =>
        monitor.runMonitor(
          { stores: [STORE_V40], before: [], today: '2026-07-31', state: {} },
          fakeLibsFor(asCalendar([{ date: '2099-09-06', name: 'チップ大還元', buyin: null, tags: [] }], '2099-09'))
        ),
      (e) => /掲載ルールが適用されていない行/.test(e.message) && /excluded-row-present/.test(e.message)
    );
  });
});

test('★掲載ルール(検知側): 保存則の残余を作ると checkVenueRuleAccounting が偽になる', () => {
  // 【健全な入力で ok=true になることだけを見ない】この案件が2度踏んだ罠。
  const base = { store: { venueId: 'v35' }, extractedCount: 5, buyinSuppressedCount: 2, buyinAbsentCount: 3 };
  assert.equal(monitor.checkVenueRuleAccounting(base).ok, true);
  assert.equal(monitor.checkVenueRuleAccounting({ ...base, buyinAbsentCount: 2 }).ok, false, '数え漏らしを見逃さない');
  assert.equal(monitor.checkVenueRuleAccounting({ ...base, buyinAbsentCount: 2 }).residual, 1);
  assert.equal(monitor.checkVenueRuleAccounting({ ...base, buyinSuppressedCount: 4 }).ok, false, '二重計上も検知');
  // 対象外の店では 0 = 0 で成立する(規則の無い店を毎回赤くしない)
  assert.equal(monitor.checkVenueRuleAccounting({ store: { venueId: 'v18' }, extractedCount: 9 }).ok, true);
  assert.equal(monitor.checkVenueRuleAccounting({ store: { venueId: 'v18' }, extractedCount: 9 }).applies, false);
});

// ---------- CLI(子プロセス)まで通した掲載ルールの配線 ----------
// 【なぜ CLI でも見るか】上のテストは `monitor.reportVenueListingRules(...)` を直接呼んでいるので、
// **main() からの呼び出しを消す変異が素通りする**(実測: 消してもテストは全部緑だった)。
// 報告の有無は実行ログにしか現れないため、実際の stdout で確かめる。

test('★CLI: 掲載ルールの節は【毎回】実行ログに出る(0件の回でも)', () => {
  const r = runCliWithMutation(() => {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== 店ごとの掲載ルール\(社長指示/);
  assert.match(r.stdout, /参加費を記録しない: A&K\(v35\)/);
  assert.match(r.stdout, /大会名に「大還元」を含む行 0件/);
  assert.match(r.stdout, /大会名に「華金」を含む行 0件/);
  // 合計にも0のまま出る(この行が消えると規則が死んでも気づけない)
  assert.match(r.stdout, /うち店ごとの掲載ルールで除外 0行/);
  assert.doesNotMatch(r.stdout, /::error/, '正常な実行で赤を出さない');
});

test('★CLI(実データの形): v40の「大還元」が落ち、v35の参加費が消えて、他店は無傷', () => {
  // 試験実行 run `30973996821` で社長が指摘した3件を、1回のCLI実行で同時に再現する。
  const root = makeTempRepoRoot();
  fs.writeFileSync(
    path.join(root, 'tools', 'fetch-venue-posts-apify.js'),
    `const P = (h) => [{ permalink: 'https://www.instagram.com/p/' + h + '/', imageUrl: 'https://example.com/' + h + '.jpg', postedAt: '2026-07-20T10:00:00.000Z', caption: '8月のスケジュール' }];
     exports.fetchInstagramPosts = async (handle) => {
       if (handle === 'triple_orio' || handle === 'ace_and_king259' || handle === 'pokerbar_iris') return P(handle);
       return [];
     };\n`
  );
  const filler = fillerRows('2099-09');
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `const F = ${JSON.stringify(filler)};
     const ORIO = [...F,
       { date: '2099-09-06', start: null, name: 'チップ大還元', buyin: null, tags: [] },
       { date: '2099-09-16', start: null, name: 'スーパー大還元', buyin: null, tags: [] },
       { date: '2099-09-07', start: null, name: 'FST SATELLITE', buyin: null, tags: [] }];
     const AK = [...F,
       { date: '2099-09-02', start: null, name: '1周年記念 FREE ROLL', buyin: 0, tags: ['フリーロール'] },
       { date: '2099-09-05', start: null, name: 'Super ハイローラーTOURNAMENT', buyin: 1000, tags: [] }];
     const IRIS = [...F,
       { date: '2099-09-01', start: null, name: '大還元フリロ', buyin: 0, tags: ['フリーロール'] },
       { date: '2099-09-25', start: null, name: '月末大還元', buyin: 500, tags: [] }];
     exports.extractTournaments = async (buf) => {
       const s = String(buf);
       if (s.includes('triple_orio')) return ORIO;
       if (s.includes('ace_and_king259')) return AK;
       return IRIS;
     };\n`
  );
  fs.writeFileSync(
    path.join(root, 'stub-fetch.js'),
    'globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });\n'
  );
  try {
    const r = runCliArgs(root, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    // (1) v40 … 「大還元」2件が除外され、理由と明細が出る
    assert.match(r.stdout, /大会名に「大還元」を含む行 2件/);
    assert.match(r.stdout, /除外行: v40 \/ 2099-09-06 \/ チップ大還元/);
    assert.match(r.stdout, /除外行: v40 \/ 2099-09-16 \/ スーパー大還元/);
    assert.doesNotMatch(r.stdout, /追加行: v40 .*大還元/, '除外した行が追加行に出てはいけない');
    assert.match(r.stdout, /追加行: v40 .*FST SATELLITE/, '正当な大会は残ること');
    // (2) v35 … 参加費が1件も載らない(0 も 1000 も)
    assert.match(r.stdout, /読み取れた参加費を捨てた 7行/, '埋め行5 + FREE ROLL(0) + 1000 = 7行');
    for (const line of r.stdout.split('\n').filter((l) => /追加行: v35/.test(l))) {
      assert.match(line, /参加費不明/, `v35 に参加費が載っている: ${line}`);
      assert.doesNotMatch(line, /⚠要確認/, 'v35 に⚠が付いてはいけない');
    }
    // (3) v18 … 同じ語を含む大会が【残る】。参加費もそのまま
    assert.match(r.stdout, /追加行: v18 .*大還元フリロ.*参加費0/);
    assert.match(r.stdout, /追加行: v18 .*月末大還元.*参加費500/);
    // (4) 保存則は全部成立し、赤は出ない
    assert.doesNotMatch(r.stdout, /集計が合わない/);
    assert.doesNotMatch(r.stdout, /::error/);
    assert.match(r.stdout, /うち店ごとの掲載ルールで除外 2行/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
