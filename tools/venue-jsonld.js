'use strict';

/**
 * venue-jsonld.js — 店舗ページの LocalBusiness(JSON-LD)の【唯一の所有者】
 *
 * gen-venue-pages.js から呼ばれる。data.js の VENUES(住所・電話・緯度経度・営業時間)を
 * 検索エンジン向けの構造化データ(schema.org LocalBusiness)に変換する。
 *
 * 【なぜ独立ファイルに切り出したか】
 *   gen-venue-pages.js は require するだけで副作用(ファイル書き込み)を持つトップレベル
 *   スクリプトなので、そのままでは node --test から個別ロジックを検証できない。
 *   判定ロジック(住所の分解・「未確認」の印との整合性検査・営業時間のdayOfWeek変換)は
 *   このファイルに寄せ、gen-venue-pages.js は venueJsonLd(v) 等を呼ぶだけにする
 *   (venue-schedule.js / area-schedule.js と同じ構成)。
 *
 * 【geo(緯度経度)を追加した理由・2026-09-12】
 *   マーケティング部のSEO調査で LocalBusiness の geo が無いという指摘。
 *   data.js の VENUES に "lat" / "lng"(国土地理院 住所ジオコーダーで address から取得。
 *   出典は fukuoka-venues.json 側の note に記録)を追加し、ここで GeoCoordinates に変換する。
 *   ★ "addressUnverified": true の店・address が空の店は対象外(誤った緯度経度を確定情報として
 *     渡すと、読者を無関係な場所に案内するリスクがある。streetAddress を落とす条件と同じ考え方)。
 *     data.js 側で最初から lat/lng を付けない運用にしているが、ここでも
 *     二重にガードする(venueJsonLd)。加えて validateGeoFlags で、この対応関係が
 *     data.js 上で崩れていないか(付け忘れ・付けすぎ)を生成のたびに検査する。
 *
 * 【openingHoursSpecification(営業時間)を追加した理由・2026-09-12】
 *   PR #88(2026-09-09)は、data.js の "hours"(フリーテキスト)を openingHoursSpecification へ
 *   変換しないと判断した。理由は「曜日ごとの休業日が未確認のフリーテキストを構造化して
 *   断定として渡せない」こと。この判断自体はいまも妥当。今回はそれを単純に覆すのではなく、
 *   "hours" のうち【曜日区分が完全に明確、かつ確度ヘッジが無い店だけ】を対象に、
 *   人が data.js に "hoursSpec"(days/opens/closes の3項目だけを持つ構造化済みデータ、
 *   詳しい条件は data.js のヘッダーコメントを参照)を追加し、このファイルは
 *   それを機械的に OpeningHoursSpecification へ変換するだけにする。
 *   ★ "hours" の自由文はコード側でパースしない。「不定休」「LAST」「祝前日」のような
 *     曜日に還元できない表現を誤って構造化データに落とす事故を、パーサの精度に頼らず
 *     【そもそも作らない】ことで防ぐ(README 法務・信頼性メモと同じ考え方)。
 */

// schema.org の DayOfWeek 列挙値(常に完全なURLで出す。Google のサンプルに合わせた表記)。
const DAY_URI = {
  Monday: 'https://schema.org/Monday',
  Tuesday: 'https://schema.org/Tuesday',
  Wednesday: 'https://schema.org/Wednesday',
  Thursday: 'https://schema.org/Thursday',
  Friday: 'https://schema.org/Friday',
  Saturday: 'https://schema.org/Saturday',
  Sunday: 'https://schema.org/Sunday',
  PublicHolidays: 'https://schema.org/PublicHolidays'
};
const DAY_NAMES = Object.keys(DAY_URI);
// 00:00〜23:59 の "HH:MM" のみを許す。"24:00" は使わない(data.js ヘッダーコメントの通り、
// 日をまたぐ閉店は closes < opens で表現する。24:00 と 00:00 を両方許すと
// 同じ意味を2通りの表記で持つことになり、比較・検査がぶれる)。
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 住所を PostalAddress に分解する。data.js の address 文字列を機械的に切るだけで、
// 無い情報は足さない(市区町村が読み取れなければ addressLocality を出さない)。
// addressRegion は当サイトが福岡県内の店舗だけを扱うため常に福岡県。
function addressParts(address) {
  const a = String(address).replace(/^福岡県/, '');
  const m = a.match(/^(.+?[市郡])/);
  if (!m) return { street: a, locality: null };
  return { street: a.slice(m[1].length), locality: m[1] };
}

// ---- 「未確認」の印(addressUnverified / telUnverified)と note の食い違いを止める ----
// 【なぜ必要か】
//   確度の低い住所・電話を JSON-LD から落とす判定は data.js のフラグが持つ(下の venueJsonLd)。
//   一方、読者向けのヘッジは note の文章が持つ。この2つは別々に書かれるので、店を追加した人が
//   note にだけ「住所は要確認」と書いてフラグを付け忘れると、【表示は留保・構造化データは断定】
//   という、今回まさに直した状態にそのまま戻る。しかもその壊れ方は画面を見ても分からない。
//   そこで「note が住所/電話の未確認に言及しているのにフラグが無い」場合は生成せずに落とす。
//   ★ 判定そのものを note の文字列マッチで行っているわけではない(それは脆い)。
//     出力を決めるのはあくまでフラグで、ここは【書き忘れを人間に知らせるための検査】。
// 【address が空の店を対象外にする理由】
//   RAISE BLUE 天神は住所データ自体を持たず note に「住所は未確認。」と書いてある。
//   出すべき streetAddress がそもそも無いのでフラグは不要(付けても意味がない)。
const UNVERIFIED_CHECKS = [
  { flag: 'addressUnverified', field: 'address', re: /住所[^。]*(要確認|未確認)/ },
  { flag: 'telUnverified',     field: 'tel',     re: /電話[^。]*(要確認|未確認)/ }
];
function validateUnverifiedFlags(venues) {
  const problems = [];
  venues.forEach(v => {
    UNVERIFIED_CHECKS.forEach(c => {
      if (!v[c.field] || v[c.flag]) return;
      if (c.re.test(v.note || '')) {
        problems.push(`${v.id} ${v.name}: note が${c.field === 'tel' ? '電話' : '住所'}の未確認に言及していますが `
          + `"${c.flag}": true がありません（data.js に足すか、裏が取れたなら note のヘッジを外してください）`);
      }
    });
  });
  if (problems.length) {
    throw new Error('店舗データの「未確認」の印が note と食い違っています:\n  - ' + problems.join('\n  - '));
  }
}

// ---- geo(lat/lng)の付け忘れ・付けすぎを止める ----
// 【なぜ必要か】
//   addressUnverified な店・address が空の店に lat/lng が付くと、誤った/存在しない住所を
//   確定情報として地図に示すことになる(streetAddress を落とす理由と同じ)。
//   data.js を書く人がこの対応関係を毎回覚えている前提にはできないので、生成のたびに検査する。
function validateGeoFlags(venues) {
  const problems = [];
  venues.forEach(v => {
    const hasLat = v.lat !== undefined && v.lat !== null;
    const hasLng = v.lng !== undefined && v.lng !== null;
    if (hasLat !== hasLng) {
      problems.push(`${v.id} ${v.name}: lat/lng の片方しかありません(両方揃えるか、両方外してください)`);
      return;
    }
    if (!hasLat) return;
    if (typeof v.lat !== 'number' || typeof v.lng !== 'number') {
      problems.push(`${v.id} ${v.name}: lat/lng は数値で指定してください`);
      return;
    }
    if (v.addressUnverified) {
      problems.push(`${v.id} ${v.name}: addressUnverified: true なのに lat/lng が付いています`
        + '(住所が未確認の店に緯度経度を確定情報として出せません。裏が取れるまで外してください)');
    }
    if (!v.address) {
      problems.push(`${v.id} ${v.name}: address が空なのに lat/lng が付いています`);
    }
  });
  if (problems.length) {
    throw new Error('店舗データの緯度経度(lat/lng)が住所の確度と食い違っています:\n  - ' + problems.join('\n  - '));
  }
}

// ---- hoursSpec の形を止める ----
// 【なぜ必要か】
//   hoursSpec は人が手で書く構造化データなので、typo や曜日の重複(2つの区分に同じ曜日を
//   入れてしまう等)が起きうる。誤った形のまま openingHoursSpecification に出すと、
//   壊れた/矛盾した営業時間を確定情報として検索エンジンに渡すことになる。
function validateHoursSpec(venues) {
  const problems = [];
  venues.forEach(v => {
    if (v.hoursSpec === undefined) return;
    if (!v.hours) {
      problems.push(`${v.id} ${v.name}: hours が空なのに hoursSpec があります`);
    }
    if (!Array.isArray(v.hoursSpec) || !v.hoursSpec.length) {
      problems.push(`${v.id} ${v.name}: hoursSpec は空でない配列にしてください`);
      return;
    }
    const seenDays = new Set();
    v.hoursSpec.forEach((seg, i) => {
      const where = `${v.id} ${v.name} の hoursSpec[${i}]`;
      if (!Array.isArray(seg.days) || !seg.days.length) {
        problems.push(`${where}: days は空でない配列にしてください`);
        return;
      }
      seg.days.forEach(d => {
        if (!DAY_NAMES.includes(d)) {
          problems.push(`${where}: days に未知の曜日 "${d}" があります(使えるのは ${DAY_NAMES.join(', ')})`);
          return;
        }
        if (seenDays.has(d)) {
          problems.push(`${where}: "${d}" が他の区分と重複しています(同じ店で同じ曜日を2回指定できません)`);
        }
        seenDays.add(d);
      });
      if (!TIME_RE.test(seg.opens || '')) {
        problems.push(`${where}: opens "${seg.opens}" は "HH:MM"(00:00〜23:59)形式で指定してください`);
      }
      if (!TIME_RE.test(seg.closes || '')) {
        problems.push(`${where}: closes "${seg.closes}" は "HH:MM"(00:00〜23:59)形式で指定してください`);
      }
    });
  });
  if (problems.length) {
    throw new Error('店舗データの hoursSpec(営業時間の構造化データ)が壊れています:\n  - ' + problems.join('\n  - '));
  }
}

// hoursSpec(data.js) → openingHoursSpecification(JSON-LD)の配列に変換するだけ。
// 曜日名 → schema.org の URI に対応づける以外の判断は持たない(自由文のパースはしない)。
function openingHoursFromSpec(hoursSpec) {
  return hoursSpec.map(seg => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: seg.days.map(d => DAY_URI[d]),
    opens: seg.opens,
    closes: seg.closes
  }));
}

function venueJsonLd(v) {
  // ★ data.js に無い項目は出さない。空文字を "" のまま出すと、
  //   検索エンジンに「値が無い」ではなく「空という値」を渡すことになる。
  // ★ 裏が取れていない項目も出さない(addressUnverified / telUnverified)。
  //   ページの表示テキストでは note のヘッジ付きで出しているのに、構造化データでは
  //   同じ値を断定として渡していた。読者には「要確認」と伝えながら Google には
  //   確定情報として渡すのは、READMEの編集方針(根拠の弱い情報は確度の差が伝わる形で出す)に反する。
  const j = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: v.name
  };
  if (v.address) {
    const p = addressParts(v.address);
    const addr = { '@type': 'PostalAddress' };
    if (p.locality) addr.addressLocality = p.locality;
    // 落とすのは streetAddress(丁目・番地・ビル名・部屋番号)だけで、address ブロックごとは落とさない。
    //   - 実害があるのは番地レベルの誤り(無関係な建物・部屋を訪ねさせる)。市区町村までの粒度なら
    //     当サイトが独立に持っている area / access(最寄駅)と突き合わせて裏が取れている
    //     (例: 中洲エリア・中洲川端駅徒歩1分 ⇔ 福岡市博多区)。
    //   - LocalBusiness にとって address は Google が必須とする項目で、ブロックごと落とすと
    //     「不正確な住所」ではなく「住所の無い事業所」になり、エラー扱いになる。
    //     市区町村＋県だけを残すのが「嘘をつかず、かつ壊さない」最小の落とし方。
    if (p.street && !v.addressUnverified) addr.streetAddress = p.street;
    addr.addressRegion = '福岡県';
    addr.addressCountry = 'JP';
    j.address = addr;
  }
  if (v.tel && !v.telUnverified) j.telephone = v.tel;
  // url は店舗自身のサイト。持っていない店では出さない。
  if (v.website) j.url = v.website;
  const sameAs = [v.x, v.instagram, v.threads, v.line].filter(Boolean);
  if (sameAs.length) j.sameAs = sameAs;
  // geo(緯度経度)。data.js 側で addressUnverified / address空の店には最初から付けていないが、
  // ここでも同じ条件を二重に確認する(streetAddress の落とし方と同じ、belt-and-suspenders)。
  if (typeof v.lat === 'number' && typeof v.lng === 'number' && v.address && !v.addressUnverified) {
    j.geo = { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng };
  }
  // ★ v.hours（営業時間の自由文）そのものは openingHoursSpecification へ変換しない(2026-09-09)。
  //   曜日区分が明確でない・確度が低い hours を「毎日この時間」等と構造化すると、
  //   店舗からの申告を超える断定を当サイトが作り出すことになる。
  //   v.hoursSpec(曜日区分が明確、かつ確度ヘッジの無い店だけ人が追加する構造化データ。
  //   条件は data.js のヘッダーコメントを参照)がある店だけ、それをそのまま変換して出す。
  if (Array.isArray(v.hoursSpec) && v.hoursSpec.length) {
    j.openingHoursSpecification = openingHoursFromSpec(v.hoursSpec);
  }
  return j;
}

module.exports = {
  DAY_URI, DAY_NAMES,
  addressParts,
  validateUnverifiedFlags,
  validateGeoFlags,
  validateHoursSpec,
  openingHoursFromSpec,
  venueJsonLd
};
