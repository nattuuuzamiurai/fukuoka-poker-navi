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

test('mergeStore: 対象店舗の同じ(date,start)にAPI側が来たら手入力を置き換え、GTDを引き継ぐ', () => {
  const file = writeFixture();
  try {
    const parsed = merge.readDataJs(file);
    const scraped = [
      {
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
        source: 'auto',
        verified: false,
      },
    ];
    const { next, stats } = merge.mergeStore(parsed.arr, 'v40', scraped, TODAY);
    merge.assertOnlyTargetChanged(parsed.arr, next, 'v40', TODAY);

    const replaced = next.find((t) => t.id === 'ig-v40-2026-08-05-1900-slot');
    assert.ok(replaced, '新しいエントリが入っていること');
    assert.equal(replaced.guarantee, 500000, '既存手入力のGTDを引き継ぐこと');
    assert.ok(replaced.tags.includes('バウンティ'), '既存手入力のタグ(バウンティ)を引き継ぐこと');
    assert.equal(stats.updated, 1);
    assert.equal(stats.replacedManual.length, 1);

    // 過去日・他店は一切変化していない
    const past = next.find((t) => t.id === 'past-1');
    assert.equal(past.name, '過去の大会(触ってはいけない)');
    const other = next.find((t) => t.id === 'other-1');
    assert.equal(other.name, '他店(触ってはいけない)');
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
