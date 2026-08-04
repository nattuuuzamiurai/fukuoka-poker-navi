'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const merge = require('./tournament-merge');

const TODAY = '2026-08-01';

function fixtureSource() {
  const tournaments = [
    {
      id: 'manual-1',
      venueId: 'v40',
      name: '既存手入力(GTD付き)',
      date: '2026-08-05',
      start: '19:00',
      buyin: 1000,
      addon: null,
      stack: 10000,
      guarantee: 500000,
      reentry: false,
      prize: null,
      tags: ['バウンティ'],
      source: 'manual',
      verified: true,
    },
    {
      id: 'past-1',
      venueId: 'v40',
      name: '過去の大会(触ってはいけない)',
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
      name: '他店(触ってはいけない)',
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

test('readDataJs / writeDataJs: ラウンドトリップでTOURNAMENTS以外を変えない', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    assert.equal(parsed.arr.length, 3);
    merge.writeDataJs(file, parsed, parsed.arr); // 中身は変えず書き戻す
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('const VENUES = [];'));
    assert.ok(after.includes('const AREAS = [];'));
  } finally {
    fs.unlinkSync(file);
  }
});

/** Vision/APIが読み取った1行(v40・2026-08-05 19:00 の枠)。 */
const scrapedRow = (over = {}) => ({
  id: 'ig-v40-2026-08-05-1900-slot',
  venueId: 'v40',
  name: 'Vision抽出のトーナメント',
  date: '2026-08-05',
  start: '19:00',
  buyin: 2000,
  addon: null,
  stack: 20000,
  guarantee: null,
  reentry: false,
  prize: null,
  tags: [],
  source: 'semi',
  verified: false,
  ...over,
});

// ============================================================
// 人が入力した値を機械が壊さないこと
// ============================================================
// 【両方向を固定する】守る側だけを置くと「何もかも守る実装(= 取込みが完全に死ぬ)」が
// テストを全部通ってしまう。守らない側(控えがある行はちゃんと更新される)も必ず置くこと。

test('★守る: 同じ(date,start)に取得結果が来ても、控えの無い行(=人の行)は置き換えない', () => {
  // 【2026-08-04まではここで置き換えていた】dry-run #5 では人の39件がこれで消えるところだった。
  // 置き換えは値の交換ではなく情報量の低下で、しかも手入力の ⚠ 要確認 が黙って外れる。
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const before = JSON.parse(JSON.stringify(parsed.arr));
    const { next, stats, written } = merge.mergeStore(parsed.arr, 'v40', [scrapedRow()], TODAY);
    merge.assertOnlyTargetChanged(before, next, 'v40', TODAY);
    merge.assertHumanEditsPreserved(before, next, {});

    const kept = next.find((t) => t.id === 'manual-1');
    assert.deepEqual(kept, before.find((t) => t.id === 'manual-1'), '人の行が1バイトも変わらないこと');
    assert.ok(!next.some((t) => t.id === 'ig-v40-2026-08-05-1900-slot'), '取得結果の行は書かれないこと');
    assert.equal(stats.protected, 1);
    assert.equal(stats.protectedRows[0].existing[0].id, 'manual-1', '理由になった人の行が分かること');
    assert.deepEqual(written, {}, '書いていないので控えにも入らないこと');
    assert.equal(stats.updated, 0, '置き換えは「更新」に数えない');

    // 過去日・他店は一切変化していない
    assert.equal(next.find((t) => t.id === 'past-1').name, '過去の大会(触ってはいけない)');
    assert.equal(next.find((t) => t.id === 'other-1').name, '他店(触ってはいけない)');
  } finally {
    fs.unlinkSync(file);
  }
});

test('★守らない: 控えがある行は取得結果で更新される(取込みが止まらない)', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    // 前回このツールが書いた行(控えと data.js が一致 = 誰も触っていない)
    const prevMachine = scrapedRow({ name: '前回の読み取り', buyin: 1500 });
    const arr = [...parsed.arr, prevMachine];
    const { next, stats } = merge.mergeStore(arr, 'v40', [scrapedRow({ date: '2026-08-06' })], TODAY, {
      records: { [prevMachine.id]: prevMachine },
    });
    // 枠が違うので置き換えではなく、同じidの行が作り直される
    const updated = next.find((t) => t.id === 'ig-v40-2026-08-05-1900-slot');
    assert.equal(updated.name, 'Vision抽出のトーナメント', '★控えがある行は機械の新しい値で更新されること');
    assert.equal(updated.buyin, 2000);
    assert.equal(updated.date, '2026-08-06');
    assert.equal(stats.protected, 0, '守る対象ではないこと');
  } finally {
    fs.unlinkSync(file);
  }
});

test('★守る(項目単位): 控えと食い違う項目だけ人の値を残し、他は更新する', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    // ★人の行(manual-1)が居る 08-05 19:00 とは別の枠に置く。同じ枠だと枠の保護が先に効いて
    //   「項目単位の保護」を観測できない(=テストが別の性質を見てしまう)。
    const at = { id: 'ig-v40-2026-08-07-1900-slot', date: '2026-08-07' };
    const record = scrapedRow({ ...at, name: '前回の読み取り', buyin: 1500 });
    const current = scrapedRow({ ...at, name: '人が直した名前', buyin: 1500 }); // 名前だけ人が直した
    const arr = [...parsed.arr, current];
    const { next, stats, written } = merge.mergeStore(arr, 'v40', [scrapedRow({ ...at })], TODAY, {
      records: { [record.id]: record },
    });

    const out = next.find((t) => t.id === record.id);
    assert.equal(out.name, '人が直した名前', '人が直した大会名は守られること');
    assert.equal(out.buyin, 2000, '★触っていない参加費は更新されること');
    assert.equal(stats.fieldsProtected, 1);
    assert.deepEqual(stats.protectedFields[0].fields, ['name']);
    assert.equal(
      written[record.id].name,
      'Vision抽出のトーナメント',
      '★控えるのは人の値を戻す【前】の機械の値。戻した後を控えると保護が1日で切れる'
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('★守る: 同じidの既存に控えが無ければ、枠が空いていても上書きしない', () => {
  // 【枠の保護とは別の経路】取得結果の (date,start) に人の行が無くても、
  // 同じidの既存に控えが無ければその行は【人のもの】。
  // これが無いと、状態ファイルを失った直後の実行が
  // 「この経路が前回書いた行」と「人が入れた行」を区別できないまま全部上書きする。
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const at = { id: 'ig-v40-2026-08-07-1900-slot', date: '2026-08-07' };
    const human = scrapedRow({ ...at, name: '人が入れた行', buyin: 1500 });
    const arr = [...parsed.arr, human];
    const before = JSON.parse(JSON.stringify(arr));

    // 取得結果は【同じid・別の枠】。枠 08-09 19:00 には誰も居ないので blockers は空になる。
    const { next, stats } = merge.mergeStore(arr, 'v40', [scrapedRow({ ...at, date: '2026-08-09' })], TODAY);
    merge.assertHumanEditsPreserved(before, next, {});

    assert.deepEqual(next.find((t) => t.id === at.id), human, '人の行が1バイトも変わらないこと');
    assert.equal(stats.protected, 1, '見送りとして数えられること');
    assert.equal(stats.protectedRows[0].existing[0].id, at.id);
  } finally {
    fs.unlinkSync(file);
  }
});

test('★守る: 突き合わせは stats を一切見ないので、集計が正しく見えても壊れていれば止まる', () => {
  // 【この案件の要】保存則(カウンタ)は「マージが自分で数えた値」なので、
  // マージが壊れているときは【集計も一緒に壊れて辻褄が合ってしまう】ことがある。
  // 突き合わせはマージ前のディープコピーとマージ後の配列だけを見るので、その共倒れが起きない。
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const before = JSON.parse(JSON.stringify(parsed.arr));
    // 「集計上は完璧」だが人の行を書き換えた結果を、そのまま突き合わせに渡す。
    const corrupted = parsed.arr.map((t) => (t.id === 'manual-1' ? { ...t, buyin: 9999 } : t));
    const perfectLookingStats = { added: 0, updated: 0, unchanged: 0, protected: 1, residual: 0, ok: true };
    assert.ok(perfectLookingStats.ok, '集計は正常に見えている');
    assert.throws(
      () => merge.assertHumanEditsPreserved(before, corrupted, {}),
      /書き換えられています/,
      'カウンタが何を言おうと、実際の値が変わっていれば止まること'
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('★守る: 人の行の GTD・タグは、その行がそのまま残ることで守られる', () => {
  // 旧実装は「人の行を置き換えたうえで GTD を引き継ぐ」形だった。いまは置き換えないので
  // 引き継ぐ必要がない。GTD 500000 と 'バウンティ' は人の行そのものに残る。
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const { next } = merge.mergeStore(parsed.arr, 'v40', [scrapedRow()], TODAY);
    const kept = next.find((t) => t.id === 'manual-1');
    assert.equal(kept.guarantee, 500000);
    assert.ok(kept.tags.includes('バウンティ'));
    assert.equal(kept.verified, true, 'verified も含めて手つかずであること');
  } finally {
    fs.unlinkSync(file);
  }
});

test('assertHumanEditsPreserved: 人の行が書き換わっていたら例外を投げる', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const corrupted = parsed.arr.map((t) => (t.id === 'manual-1' ? { ...t, name: '機械が上書きした' } : t));
    assert.throws(() => merge.assertHumanEditsPreserved(parsed.arr, corrupted, {}), /書き換えられています/);
    const dropped = parsed.arr.filter((t) => t.id !== 'manual-1');
    assert.throws(() => merge.assertHumanEditsPreserved(parsed.arr, dropped, {}), /消えています/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('assertHumanEditsPreserved: 人が直した項目が戻されていたら例外を投げる', () => {
  const record = scrapedRow({ name: '機械の値' });
  const current = scrapedRow({ name: '人が直した名前' });
  const records = { [record.id]: record };
  // 人の値のまま → 問題なし
  merge.assertHumanEditsPreserved([current], [scrapedRow({ name: '人が直した名前', buyin: 9 })], { records });
  // 機械の値に戻された → 例外
  assert.throws(
    () => merge.assertHumanEditsPreserved([current], [scrapedRow({ name: '機械の値' })], { records }),
    /人が直した項目が書き換えられています/
  );
});

test("mergeStore: seed に source:'semi' を渡したら例外(手入力が機械のものに化けるため)", () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    assert.throws(
      () => merge.mergeStore(parsed.arr, 'v40', [], TODAY, { seed: { source: 'semi', idPrefix: 'ig-' } }),
      /source は 'auto'/
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('mergeStore: APIに対応が無い手入力は残す(keptManual)', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const { next, stats } = merge.mergeStore(parsed.arr, 'v40', [], TODAY);
    const kept = next.find((t) => t.id === 'manual-1');
    assert.ok(kept, 'API側に対応が無い手入力は消えない');
    assert.equal(stats.keptManual.length, 1);
  } finally {
    fs.unlinkSync(file);
  }
});

test('assertOnlyTargetChanged: 対象外店舗が変化していたら例外を投げる(バグ検出)', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const corrupted = parsed.arr.map((t) => (t.venueId === 'v99' ? { ...t, name: '壊れた' } : t));
    assert.throws(() => merge.assertOnlyTargetChanged(parsed.arr, corrupted, 'v40', TODAY), /対象外の店舗/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('assertOnlyTargetChanged: 過去日が変化していたら例外を投げる(バグ検出)', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const corrupted = parsed.arr.map((t) => (t.id === 'past-1' ? { ...t, name: '壊れた過去日' } : t));
    assert.throws(() => merge.assertOnlyTargetChanged(parsed.arr, corrupted, 'v40', TODAY), /過去日/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('mergeStore: 過去日が日付順ではなく大会名グループ順で並んでいても、内容・順序ともに一切変化しない(回帰テスト)', () => {
  // 実データ(v40等)は過去日を含む既存エントリが日付順ではなく大会名グループ順で並んでいることがある。
  // mergeStore が past を含めて丸ごとソートしてしまうと、内容が1件も変わっていなくても
  // 「過去日の順序が変わった」ことを assertOnlyTargetChanged が「過去日が変化した」と誤検知し、
  // 書き込みを永続的に拒否してしまう(2026-07-30 品質管理部レビューで検出)。
  const tournaments = [
    {
      id: 'past-b-2',
      venueId: 'v40',
      name: 'B大会(2回目・古い方が後ろに来る非ソート順)',
      date: '2020-01-05',
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
      id: 'past-a-1',
      venueId: 'v40',
      name: 'A大会(1回目)',
      date: '2020-01-10',
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
      id: 'past-b-1',
      venueId: 'v40',
      name: 'B大会(1回目)',
      date: '2020-01-03',
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
      id: 'past-a-2',
      venueId: 'v40',
      name: 'A大会(2回目・日付順ではない)',
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
      id: 'future-1',
      venueId: 'v40',
      name: '未来の大会',
      date: '2026-08-05',
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
  const before = tournaments; // past-b-2, past-a-1, past-b-1, past-a-2 の順(日付順でも大会名順でもない)

  const { next } = merge.mergeStore(before, 'v40', [], TODAY);

  // assertOnlyTargetChanged が例外を投げないこと(=誤検知しないこと)を確認するのが本題
  assert.doesNotThrow(() => merge.assertOnlyTargetChanged(before, next, 'v40', TODAY));

  // 過去日4件が、内容だけでなく並び順も完全にそのまま残っていること
  const pastBefore = before.filter((t) => t.date < TODAY);
  const pastAfter = next.filter((t) => t.date < TODAY);
  assert.deepEqual(
    pastAfter.map((t) => t.id),
    pastBefore.map((t) => t.id),
    '過去日の並び順が変化してはいけない'
  );
  assert.deepEqual(pastAfter, pastBefore, '過去日の内容も一切変化してはいけない');
});

test('carryOver: API_OWNED_TAGSでないタグ(人手タグ)とpinnedTagsを引き継ぐ', () => {
  const prev = { guarantee: 100, prize: '賞品あり', tags: ['ターボ', '大型'], pinnedTags: ['ディープ'] };
  const next = { tags: ['ターボ'] };
  const merged = merge.carryOver(next, [prev]);
  assert.equal(merged.guarantee, 100);
  assert.equal(merged.prize, '賞品あり');
  assert.ok(merged.tags.includes('大型'));
  assert.ok(merged.tags.includes('ディープ'));
  assert.deepEqual(merged.pinnedTags, ['ディープ']);
});

// ============================================================
// carryOver: 取得結果が読み取った GTD / 賞品を捨てない (#5)
// ============================================================
// 【何が壊れていたか】carryOver は両項目を「既存から取る、無ければ null」で上書きしており、
// 【今回読み取った値を毎回捨てていた】。「guarantee/prize は人手専用」という前提は
// Waitinglist では正しい(APIに該当フィールドが無い)が、Vision経路では成立しない —
// プロンプトが "guarantee":number|null と "prize":string|null の両方を要求しているため。
// 3つの保存則は「行」の会計なので、この「項目」の欠落は原理的に検知できない。だからここで固定する。

test('carryOver: 既存に値が無ければ、今回読み取った GTD / 賞品を採用する', () => {
  const read = scrapedRow({ guarantee: 100000, prize: 'Tシャツ' });
  const entry = merge.carryOver(read, [null]);
  assert.equal(entry.guarantee, 100000, '読み取ったGTDを捨てないこと');
  assert.equal(entry.prize, 'Tシャツ', '読み取った賞品を捨てないこと');
});

test('carryOver: 人の値が優先される(読み取った値で上書きしない)', () => {
  const read = scrapedRow({ guarantee: 100000, prize: '読み取った賞品' });
  const prev = scrapedRow({ guarantee: 500000, prize: '人が入れた賞品' });
  const entry = merge.carryOver(read, [prev]);
  assert.equal(entry.guarantee, 500000, '人の値が勝つこと');
  assert.equal(entry.prize, '人が入れた賞品');
});

test('carryOver: どちらにも無ければ null(0 を null に潰したりしない)', () => {
  const entry = merge.carryOver(scrapedRow(), [null]);
  assert.equal(entry.guarantee, null);
  assert.equal(entry.prize, null);
  // 0 は「読み取れた値」なので残す(参加費で 0 を既定値にしないのと同じ規律)
  assert.equal(merge.carryOver(scrapedRow({ guarantee: 0 }), [null]).guarantee, 0);
});

test('carryOver: 人手タグ・pinnedTags の引き継ぎは変わっていない(回帰)', () => {
  const read = scrapedRow({ tags: ['ターボ'] });
  const prev = scrapedRow({ tags: ['バウンティ', 'ディープ'], pinnedTags: ['ディープ'] });
  const entry = merge.carryOver(read, [prev]);
  assert.ok(entry.tags.includes('ターボ'), '取得結果のタグは残る');
  assert.ok(entry.tags.includes('バウンティ'), '人が付けたタグは引き継ぐ');
  assert.ok(entry.tags.includes('ディープ'), 'pinnedTags は tags に合流する');
  assert.deepEqual(entry.pinnedTags, ['ディープ']);
});
