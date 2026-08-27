const MIN_CALIBRATION_SAMPLES = 30
const WINDOW_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const MAX_STATS_AGE = DAY + 5 * 60 * 1000
const COVERAGE_SKEW = 5 * 60 * 1000
const SCENE_TYPES = ['sunrise', 'sunset', 'fireCloud']

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function sceneType(value) {
  const type = String(value || '').trim()
  return ({ '朝霞': 'sunrise', '晚霞': 'sunset', '火烧云': 'fireCloud' })[type] || type
}

function collectingStat() {
  return { sampleCount: 0, accuracyRate: null, status: 'collecting' }
}

function emptyProfile(cityCode, reason = '城市准确率统计暂不可用，当前仅显示模型估算出现概率') {
  return {
    cityCode: String(cityCode || '').trim(),
    source: 'accuracyStats',
    status: 'pending',
    sampleCount: 0,
    minimumSamples: MIN_CALIBRATION_SAMPLES,
    windowDays: WINDOW_DAYS,
    stats: { sunrise: collectingStat(), sunset: collectingStat(), fireCloud: collectingStat() },
    reason
  }
}

function isFreshThirtyDayStat(stat, now) {
  const coverageStart = finite(stat && stat.coverageStart)
  const coverageEnd = finite(stat && stat.coverageEnd)
  if (coverageStart === null || coverageEnd === null || coverageEnd > now + COVERAGE_SKEW || now - coverageEnd > MAX_STATS_AGE) return false
  return Math.abs((coverageEnd - coverageStart) - WINDOW_DAYS * DAY) <= COVERAGE_SKEW
}

function normalizeStat(stat, cityCode, now) {
  const sampleCount = finite(stat && stat.sampleCount)
  const accuracyRate = finite(stat && stat.accuracyRate)
  const hitCount = finite(stat && stat.hitCount)
  const valid = stat && stat.cityCode === cityCode && SCENE_TYPES.includes(stat.sceneType) &&
    stat.windowDays === WINDOW_DAYS && stat.status === 'ready' &&
    Number.isInteger(sampleCount) && sampleCount >= MIN_CALIBRATION_SAMPLES &&
    Number.isInteger(hitCount) && hitCount >= 0 && hitCount <= sampleCount &&
    accuracyRate !== null && accuracyRate >= 0 && accuracyRate <= 1 && isFreshThirtyDayStat(stat, now)
  if (!valid) return null
  return { sampleCount, hitCount, accuracyRate, status: 'ready' }
}

function buildProfile(cityCode, rows, now = Date.now()) {
  const profile = emptyProfile(cityCode)
  for (const row of Array.isArray(rows) ? rows : []) {
    const stat = normalizeStat(row, profile.cityCode, now)
    if (stat) profile.stats[row.sceneType] = stat
  }
  const readyStats = Object.values(profile.stats).filter((stat) => stat.status === 'ready')
  if (!readyStats.length) return profile
  return {
    ...profile,
    status: 'calibrated',
    sampleCount: Math.max(...readyStats.map((stat) => stat.sampleCount)),
    reason: '仅依据近30天城市准确率对模型估算出现概率作有界微调；准确率不等同于出现概率。'
  }
}

function pendingResult(probability, profile, stat) {
  return {
    probability,
    status: 'pending',
    label: '模型估算出现概率（城市准确率积累中）',
    sampleCount: stat && Number.isInteger(stat.sampleCount) ? stat.sampleCount : Number(profile && profile.sampleCount) || 0,
    source: profile && profile.source ? profile.source : 'accuracyStats',
    adjustment: 0
  }
}

function applyBoundedCalibration(probability, type, profile) {
  const stat = profile && profile.stats && profile.stats[sceneType(type)]
  const accuracyRate = finite(stat && stat.accuracyRate)
  const ready = profile && profile.status === 'calibrated' && stat && stat.status === 'ready' &&
    Number.isInteger(stat.sampleCount) && stat.sampleCount >= MIN_CALIBRATION_SAMPLES &&
    accuracyRate !== null && accuracyRate >= 0 && accuracyRate <= 1
  if (!ready) return pendingResult(probability, profile, stat)

  const adjustment = Math.round(Math.max(-5, Math.min(5, (accuracyRate - 0.5) * 10)))
  return {
    probability: Math.max(0, Math.min(100, probability + adjustment)),
    status: 'calibrated',
    label: '模型估算出现概率（按近30天城市准确率微调）',
    sampleCount: stat.sampleCount,
    source: profile.source,
    adjustment
  }
}

async function getCalibrationProfile(db, cityCode) {
  const code = String(cityCode || '').trim()
  if (!code || !db || typeof db.collection !== 'function') return emptyProfile(code)
  try {
    const result = await db.collection('accuracyStats')
      .where({ cityCode: code, windowDays: WINDOW_DAYS })
      .limit(SCENE_TYPES.length)
      .get()
    return buildProfile(code, result && result.data, Date.now())
  } catch (error) {
    console.warn('city accuracy calibration lookup failed', error)
    return emptyProfile(code)
  }
}

module.exports = { getCalibrationProfile, applyBoundedCalibration, buildProfile }
