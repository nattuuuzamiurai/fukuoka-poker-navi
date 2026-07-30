'use strict';
/**
 * sns-schedule.js
 *
 * Instagram監視(tools/sns-monitor-instagram.js)の「今日この店をチェックする日か」
 * 「今日のこの店の実行はこの時間帯か」を決めるロジック。**I/Oを一切持たない純粋関数**のみで
 * 構成する(だからこそネットワーク・ブラウザ・シークレットなしで単体テストできる)。
 *
 * ---- 設計の要点(検知されにくくする核心部分) ----
 *
 * 1. 【チェック日の抽選】`nextCheckWindow.start`〜`end` の期間中、日を追うごとに実行確率を
 *    MIN_PROB(初日)→100%(終端)へ線形に引き上げる。終端(`end`)は必ず実行する。
 *    毎日「実行するかどうか」を店舗ID+日付から決まる疑似乱数で決める(=同じ日に複数回
 *    ワークフローが動いても結果は変わらない。多重実行を防ぐのは `lastAttemptDate` の役目)。
 *
 * 2. 【実行時間帯の抽選】チェックする日が決まっても、毎時トリガーされる全部の実行で
 *    アクセスするわけではない。店舗ID+日付から 9〜22時(JST)の中の1時間を決め、
 *    その時刻に達した最初の実行だけが処理する。
 *
 * 3. 【学習によるウィンドウ調整】投稿を見つけたら、月末(基準日)からのズレ(日数、
 *    早ければ負・遅ければ正)を `observedIntervals` に積み、次回以降の
 *    `nextCheckWindow` / `missThresholdDate` をその実測値に合わせて算出し直す
 *    (安全マージンを加えつつ、狭すぎ・広すぎを防ぐ下限も設ける)。
 *    学習データがまだ無いサイクルは、直前のウィンドウの「基準日からの相対位置」を
 *    そのまま次の基準日にスライドさせる(＝当初の店舗プロファイルの形を引き継ぐ)。
 *
 * 4. 【見送り(未検出)の扱い】`missThresholdDate` を過ぎても見つからない場合は
 *    経営管理オフィスへの報告対象。ただし即座にチェックを打ち切らず、
 *    `GRACE_DAYS` ぶんは様子見を続ける(でないと「毎回ちょっと遅い店」の実績を
 *    永遠に学習できない)。猶予も過ぎたら今サイクルは諦めて次サイクルへ回し、
 *    `consecutiveMisses` を1増やす(店舗が投稿をやめた・掲載頻度が変わった等の
 *    兆候なので、増え続けるようなら人間の確認が要る)。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================
// 日付ユーティリティ(すべてJSTの 'YYYY-MM-DD' 文字列を UTC ms とみなして扱う。
// タイムゾーン変換はしない — 呼び出し側が渡す日付文字列は常にJST基準の暦日という前提)
// ============================================================

function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function toIso(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function addDaysIso(iso, days) {
  return toIso(parseIso(iso) + days * MS_PER_DAY);
}
function daysBetweenIso(fromIso, toIsoStr) {
  return Math.round((parseIso(toIsoStr) - parseIso(fromIso)) / MS_PER_DAY);
}
function lastDayOfMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}
function monthEndIso(year, month1to12) {
  return `${year}-${String(month1to12).padStart(2, '0')}-${String(lastDayOfMonth(year, month1to12)).padStart(2, '0')}`;
}
/** anchorIso(ある月の月末日)から見て「翌月の月末日」を返す。年またぎ・うるう年も正しく扱う。 */
function nextMonthEndFrom(anchorIso) {
  const [y, m] = anchorIso.split('-').map(Number);
  const firstOfNext = new Date(Date.UTC(y, m, 1)); // Date.UTCのmonthは0始まりなので、1-12のmを渡すと「翌月」になる
  return monthEndIso(firstOfNext.getUTCFullYear(), firstOfNext.getUTCMonth() + 1);
}

// ============================================================
// 疑似乱数(依存ライブラリなしで「文字列シード → 決定論的な[0,1)の値」を作る)
// mulberry32。暗号強度は不要(推測されて困るのはInstagram側からの見え方だけで、
// このシードは公開されない内部状態のため)。
// ============================================================

function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function seededRandom(seedStr) {
  let a = hashSeed(seedStr);
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ============================================================
// 定数
// ============================================================

const GRACE_DAYS = 7; // missThresholdDate(=window.end)を過ぎてもチェックを続ける猶予日数
const MIN_PROB = 0.15; // ウィンドウ初日の実行確率
const MAX_HISTORY = 6; // observedIntervals で保持する直近サイクル数
const SAFETY_MARGIN_DAYS = 2; // 実測値から作るウィンドウに足す安全マージン(前後)
const MIN_WINDOW_DAYS = 4; // 学習後もウィンドウが1〜2日に潰れないための下限の幅
const HOUR_MIN = 9; // 巡回する時間帯(JST)の下限。深夜早朝のアクセスは避ける
const HOUR_MAX = 22; // 同・上限

// ============================================================
// ウィンドウ内かどうか・実行確率
// ============================================================

/**
 * そのサイクルの「基準日」(投稿を待っている月の前月末日)。`cycleAnchor` フィールドとして
 * 状態に明示的に持たせる(以前は `window.start` の月から逆算していたが、学習が進んで
 * ウィンドウが翌月に食い込む店 — 「月末になっても翌月分が未発表」なタイプ — が出ると、
 * `window.start` の月がもう「基準日の月」と一致しなくなり誤ったオフセットを計算してしまうため、
 * 状態側で明示的に持つ設計に変更した)。
 * `cycleAnchor` が無い(古い状態ファイル等)ときのみ、`window.start` の月末日から推定する。
 */
function resolveCycleAnchor(storeState) {
  if (storeState.cycleAnchor) return storeState.cycleAnchor;
  const [y, m] = storeState.nextCheckWindow.start.split('-').map(Number);
  return monthEndIso(y, m);
}

/** missThresholdDate(通常はwindow.endと同じ)を過ぎても様子見を続けられる最終日。 */
function graceUntil(storeState) {
  return addDaysIso(storeState.nextCheckWindow.end, GRACE_DAYS);
}

/** その日の実行確率(0〜1)。終端(および終端超過)は必ず1。 */
function checkProbabilityForDay(storeState, todayIso) {
  const { start, end } = storeState.nextCheckWindow;
  if (todayIso >= end) return 1;
  if (todayIso < start) return 0;
  const total = daysBetweenIso(start, end);
  if (total <= 0) return 1;
  const progress = daysBetweenIso(start, todayIso) / total;
  return MIN_PROB + (1 - MIN_PROB) * Math.min(1, Math.max(0, progress));
}

/**
 * 今日この店をチェックするか。
 * - ウィンドウ開始前 / 猶予も含めた期限を過ぎている場合は false
 * - 今日すでに実行済み(lastAttemptDate === todayIso)なら false(1日1回まで)
 * - それ以外は checkProbabilityForDay の確率で抽選(店舗ID+日付で決定論的)
 */
function shouldCheckToday(storeState, todayIso, venueId) {
  if (storeState.lastAttemptDate === todayIso) return false;
  if (todayIso < storeState.nextCheckWindow.start) return false;
  if (todayIso > graceUntil(storeState)) return false;
  const prob = checkProbabilityForDay(storeState, todayIso);
  const roll = seededRandom(`${venueId}:${todayIso}:day`);
  return roll < prob;
}

/** その店・その日にチェックする「時間帯」(JST 9〜22時の中の1時間)。店舗ID+日付で決定論的。 */
function pickTargetHour(venueId, todayIso) {
  const roll = seededRandom(`${venueId}:${todayIso}:hour`);
  return HOUR_MIN + Math.floor(roll * (HOUR_MAX - HOUR_MIN + 1));
}

/** 現在時刻(JSTの時、0-23)が、その店の今日の目標時間に達しているか。 */
function isTargetHourReached(venueId, todayIso, currentHourJst) {
  return currentHourJst >= pickTargetHour(venueId, todayIso);
}

// ============================================================
// ウィンドウの学習(発見時 / 見送り時)
// ============================================================

/** 直前のウィンドウの「基準日からの相対位置」を、次の基準日にそのままスライドする(学習データが無いときのフォールバック)。 */
function shiftWindowToAnchor(storeState, nextAnchorIso) {
  const anchor = resolveCycleAnchor(storeState);
  const startOffset = daysBetweenIso(anchor, storeState.nextCheckWindow.start);
  const endOffset = daysBetweenIso(anchor, storeState.nextCheckWindow.end);
  return { start: addDaysIso(nextAnchorIso, startOffset), end: addDaysIso(nextAnchorIso, endOffset) };
}

/** 実測オフセット(基準日からの日数、早ければ負・遅ければ正)の履歴から次回ウィンドウを作る。 */
function deriveWindowFromOffsets(offsets, nextAnchorIso) {
  const min = Math.min(...offsets) - SAFETY_MARGIN_DAYS;
  const max = Math.max(...offsets) + SAFETY_MARGIN_DAYS;
  let lo = min;
  let hi = max;
  if (hi - lo < MIN_WINDOW_DAYS) {
    const add = MIN_WINDOW_DAYS - (hi - lo);
    lo -= Math.ceil(add / 2);
    hi += Math.floor(add / 2);
  }
  return { start: addDaysIso(nextAnchorIso, lo), end: addDaysIso(nextAnchorIso, hi) };
}

function computeNextWindow(storeState, nextAnchorIso) {
  const offsets = storeState.observedIntervals || [];
  if (offsets.length > 0) return deriveWindowFromOffsets(offsets, nextAnchorIso);
  return shiftWindowToAnchor(storeState, nextAnchorIso);
}

/**
 * 新しい投稿を見つけたときの状態遷移。
 * 実測オフセット(今回の基準日からの日数)を履歴に積み、次サイクルのウィンドウを算出し直す。
 * 呼び出し側で lastAttemptDate は別途更新すること(この関数は「発見できた」ことだけを扱う)。
 */
function recordFound(storeState, foundDateIso, foundUrl) {
  const anchor = resolveCycleAnchor(storeState);
  const offset = daysBetweenIso(anchor, foundDateIso);
  const observedIntervals = [...(storeState.observedIntervals || []), offset].slice(-MAX_HISTORY);
  const nextAnchor = nextMonthEndFrom(anchor);
  const nextWindow = deriveWindowFromOffsets(observedIntervals, nextAnchor);
  return {
    ...storeState,
    observedIntervals,
    lastFoundPostDate: foundDateIso,
    lastFoundPostUrl: foundUrl,
    cycleAnchor: nextAnchor,
    nextCheckWindow: nextWindow,
    missThresholdDate: nextWindow.end,
    consecutiveMisses: 0,
    missReportedForCycle: false,
  };
}

/**
 * 「今日チェックしたが見つからなかった」ときの状態遷移。
 * 戻り値の `shouldReportMiss` は「今日 missThresholdDate 超過を検知し、まだ今サイクルで
 * 報告していない」場合にのみ true になる(=1サイクル1回だけ報告する)。
 * `shouldReportCycleGiveUp` は猶予も含めた最終期限を過ぎ、今サイクルを諦めて
 * 次サイクルへ回した(consecutiveMisses を1増やした)ことを示す。
 */
function recordMissAttempt(storeState, todayIso) {
  const next = { ...storeState, lastAttemptDate: todayIso };

  const shouldReportMiss = todayIso >= storeState.missThresholdDate && !storeState.missReportedForCycle;
  if (shouldReportMiss) next.missReportedForCycle = true;

  const shouldReportCycleGiveUp = todayIso >= graceUntil(storeState);
  if (shouldReportCycleGiveUp) {
    const anchor = resolveCycleAnchor(storeState);
    const nextAnchor = nextMonthEndFrom(anchor);
    const nextWindow = computeNextWindow(storeState, nextAnchor);
    next.cycleAnchor = nextAnchor;
    next.nextCheckWindow = nextWindow;
    next.missThresholdDate = nextWindow.end;
    next.consecutiveMisses = (storeState.consecutiveMisses || 0) + 1;
    next.missReportedForCycle = false;
  }

  return { state: next, shouldReportMiss, shouldReportCycleGiveUp };
}

module.exports = {
  MS_PER_DAY,
  GRACE_DAYS,
  MIN_PROB,
  MAX_HISTORY,
  SAFETY_MARGIN_DAYS,
  MIN_WINDOW_DAYS,
  HOUR_MIN,
  HOUR_MAX,
  parseIso,
  toIso,
  addDaysIso,
  daysBetweenIso,
  monthEndIso,
  nextMonthEndFrom,
  seededRandom,
  resolveCycleAnchor,
  graceUntil,
  checkProbabilityForDay,
  shouldCheckToday,
  pickTargetHour,
  isTargetHourReached,
  shiftWindowToAnchor,
  deriveWindowFromOffsets,
  computeNextWindow,
  recordFound,
  recordMissAttempt,
};
