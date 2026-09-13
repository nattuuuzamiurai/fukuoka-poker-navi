#!/usr/bin/env node
/**
 * venue-jsonld.test.js — 店舗ページ LocalBusiness(JSON-LD)のテスト
 *
 * 実行: node --test tools/venue-jsonld.test.js
 *
 * 【何を守っているか】
 *   1. 住所の分解(streetAddress / addressLocality)と、addressUnverified / telUnverified による
 *      streetAddress / telephone の抑止(2026-07-31是正の回帰防止)
 *   2. geo(緯度経度)を出す条件・出さない条件(addressUnverified・address空の店には出さない)
 *   3. validateGeoFlags が「lat/lng と住所の確度が食い違っているデータ」を検知すること
 *      (付け忘れ・付けすぎの両方向)
 *   4. hoursSpec → openingHoursSpecification の変換(曜日名 → schema.org URI・opens/closes)
 *   5. validateHoursSpec が壊れた hoursSpec(空hours・曜日重複・不正な曜日名・不正な時刻書式)を
 *      検知すること
 *   6. hoursSpec を持たない店(hours だけの店)は openingHoursSpecification を出さないこと
 *      (PR #88 の判断を維持する回帰防止)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jsonld = require('./venue-jsonld.js');
const { addressParts, venueJsonLd, validateUnverifiedFlags, validateGeoFlags, validateHoursSpec, openingHoursFromSpec, DAY_URI } = jsonld;

function baseVenue(overrides) {
  return Object.assign({
    id: 'v1', name: 'テスト店', address: '福岡市中央区天神1-1-1 テストビル3F',
    access: '天神駅 徒歩1分', tel: '', hours: '', x: '', instagram: '', line: '', website: ''
  }, overrides);
}

// ============================================================
// 1. addressParts
// ============================================================
test('addressParts: 市区郡で street/locality に分ける・県は先に剥がす', () => {
  assert.deepStrictEqual(addressParts('福岡県福岡市中央区天神1-1-1'), { street: '中央区天神1-1-1', locality: '福岡市' });
  assert.deepStrictEqual(addressParts('北九州市小倉北区堺町1-9-20'), { street: '小倉北区堺町1-9-20', locality: '北九州市' });
});

test('addressParts: 市区郡が読み取れなければ locality は null', () => {
  assert.deepStrictEqual(addressParts('どこか'), { street: 'どこか', locality: null });
});

// ============================================================
// 2. venueJsonLd 基本形・未確認フラグ
// ============================================================
test('venueJsonLd: 住所ありは streetAddress まで出す', () => {
  const j = venueJsonLd(baseVenue());
  assert.equal(j.address.streetAddress, '中央区天神1-1-1 テストビル3F');
  assert.equal(j.address.addressLocality, '福岡市');
  assert.equal(j.address.addressRegion, '福岡県');
});

test('venueJsonLd: addressUnverified は streetAddress を落とすが addressLocality は残す', () => {
  const j = venueJsonLd(baseVenue({ addressUnverified: true }));
  assert.equal(j.address.streetAddress, undefined);
  assert.equal(j.address.addressLocality, '福岡市');
});

test('venueJsonLd: telUnverified は telephone を出さない', () => {
  const j = venueJsonLd(baseVenue({ tel: '092-000-0000', telUnverified: true }));
  assert.equal(j.telephone, undefined);
});

// ============================================================
// 3. geo(緯度経度)
// ============================================================
test('venueJsonLd: lat/lng があれば geo(GeoCoordinates)を出す', () => {
  const j = venueJsonLd(baseVenue({ lat: 33.5, lng: 130.4 }));
  assert.deepStrictEqual(j.geo, { '@type': 'GeoCoordinates', latitude: 33.5, longitude: 130.4 });
});

test('venueJsonLd: lat/lng が無ければ geo を出さない', () => {
  const j = venueJsonLd(baseVenue());
  assert.equal(j.geo, undefined);
});

test('venueJsonLd: addressUnverified な店は lat/lng があっても geo を出さない(二重ガード)', () => {
  const j = venueJsonLd(baseVenue({ addressUnverified: true, lat: 33.5, lng: 130.4 }));
  assert.equal(j.geo, undefined);
});

test('venueJsonLd: address が空の店は lat/lng があっても geo を出さない(二重ガード)', () => {
  const j = venueJsonLd(baseVenue({ address: '', lat: 33.5, lng: 130.4 }));
  assert.equal(j.geo, undefined);
});

test('validateGeoFlags: addressUnverified なのに lat/lng があれば異常終了', () => {
  assert.throws(() => validateGeoFlags([baseVenue({ addressUnverified: true, lat: 33.5, lng: 130.4 })]),
    /addressUnverified.*なのに lat\/lng/);
});

test('validateGeoFlags: address が空なのに lat/lng があれば異常終了', () => {
  assert.throws(() => validateGeoFlags([baseVenue({ address: '', lat: 33.5, lng: 130.4 })]),
    /address が空なのに lat\/lng/);
});

test('validateGeoFlags: lat/lng の片方だけは異常終了', () => {
  assert.throws(() => validateGeoFlags([baseVenue({ lat: 33.5 })]), /片方しかありません/);
  assert.throws(() => validateGeoFlags([baseVenue({ lng: 130.4 })]), /片方しかありません/);
});

test('validateGeoFlags: lat/lng が数値でなければ異常終了', () => {
  assert.throws(() => validateGeoFlags([baseVenue({ lat: '33.5', lng: 130.4 })]), /数値で指定/);
});

test('validateGeoFlags: 正常なデータ(geoあり・geoなし混在)は通る', () => {
  assert.doesNotThrow(() => validateGeoFlags([
    baseVenue({ id: 'v1', lat: 33.5, lng: 130.4 }),
    baseVenue({ id: 'v2' }),
    baseVenue({ id: 'v3', addressUnverified: true }),
    baseVenue({ id: 'v4', address: '' })
  ]));
});

// ============================================================
// 4. hoursSpec → openingHoursSpecification
// ============================================================
test('openingHoursFromSpec: 曜日名を schema.org の完全なURIに変換する', () => {
  const out = openingHoursFromSpec([{ days: ['Monday', 'Saturday', 'PublicHolidays'], opens: '18:00', closes: '01:00' }]);
  assert.deepStrictEqual(out, [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: [DAY_URI.Monday, DAY_URI.Saturday, DAY_URI.PublicHolidays],
    opens: '18:00',
    closes: '01:00'
  }]);
});

test('venueJsonLd: hoursSpec があれば openingHoursSpecification を出す(区分ごとに1件)', () => {
  const j = venueJsonLd(baseVenue({
    hours: '平日18:00〜24:00／土日祝15:00〜24:00',
    hoursSpec: [
      { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '18:00', closes: '00:00' },
      { days: ['Saturday', 'Sunday', 'PublicHolidays'], opens: '15:00', closes: '00:00' }
    ]
  }));
  assert.equal(j.openingHoursSpecification.length, 2);
  assert.deepStrictEqual(j.openingHoursSpecification[0].dayOfWeek, [
    DAY_URI.Monday, DAY_URI.Tuesday, DAY_URI.Wednesday, DAY_URI.Thursday, DAY_URI.Friday
  ]);
  assert.equal(j.openingHoursSpecification[0].opens, '18:00');
  assert.equal(j.openingHoursSpecification[0].closes, '00:00');
});

test('venueJsonLd: hoursSpec が無い店(hours の自由文だけの店)は openingHoursSpecification を出さない'
  + '(PR #88 の判断の回帰防止)', () => {
  const j = venueJsonLd(baseVenue({ hours: '12:00〜24:00' }));
  assert.equal(j.openingHoursSpecification, undefined);
});

test('validateHoursSpec: hoursSpec があるのに hours が空なら異常終了', () => {
  assert.throws(() => validateHoursSpec([baseVenue({
    hours: '', hoursSpec: [{ days: ['Monday'], opens: '10:00', closes: '20:00' }]
  })]), /hours が空なのに hoursSpec/);
});

test('validateHoursSpec: 同じ曜日が2つの区分に重複していれば異常終了', () => {
  assert.throws(() => validateHoursSpec([baseVenue({
    hours: 'h',
    hoursSpec: [
      { days: ['Monday'], opens: '10:00', closes: '20:00' },
      { days: ['Monday'], opens: '11:00', closes: '21:00' }
    ]
  })]), /重複/);
});

test('validateHoursSpec: 未知の曜日名は異常終了', () => {
  assert.throws(() => validateHoursSpec([baseVenue({
    hours: 'h', hoursSpec: [{ days: ['Someday'], opens: '10:00', closes: '20:00' }]
  })]), /未知の曜日/);
});

test('validateHoursSpec: opens/closes が "HH:MM" 形式でなければ異常終了(24:00は不可)', () => {
  assert.throws(() => validateHoursSpec([baseVenue({
    hours: 'h', hoursSpec: [{ days: ['Monday'], opens: '10:00', closes: '24:00' }]
  })]), /HH:MM/);
  assert.throws(() => validateHoursSpec([baseVenue({
    hours: 'h', hoursSpec: [{ days: ['Monday'], opens: '25:00', closes: '20:00' }]
  })]), /HH:MM/);
});

test('validateHoursSpec: 正常なデータは通る(closes < opens = 日をまたぐ表現もOK)', () => {
  assert.doesNotThrow(() => validateHoursSpec([baseVenue({
    hours: '18:00〜翌1:00',
    hoursSpec: [{ days: ['Monday'], opens: '18:00', closes: '01:00' }]
  })]));
});

test('validateHoursSpec: hoursSpec を持たない店は対象外(素通り)', () => {
  assert.doesNotThrow(() => validateHoursSpec([baseVenue(), baseVenue({ id: 'v2', hours: '' })]));
});

// ============================================================
// 5. validateUnverifiedFlags(既存ロジックの移設・回帰防止)
// ============================================================
test('validateUnverifiedFlags: note が住所未確認に言及しているのにフラグが無ければ異常終了', () => {
  assert.throws(() => validateUnverifiedFlags([baseVenue({ note: '住所は未確認。' })]), /住所の未確認/);
});

test('validateUnverifiedFlags: フラグがあれば通る', () => {
  assert.doesNotThrow(() => validateUnverifiedFlags([baseVenue({ note: '住所は未確認。', addressUnverified: true })]));
});
