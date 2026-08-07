const SCENE_TYPES = new Set(['sunrise', 'sunset', 'fireCloud'])
const CLOUD_CONDITIONS = new Set(['few', 'thin', 'layered', 'overcast'])
const VISIBILITY_LEVELS = new Set(['poor', 'fair', 'good'])
const ALLOWED_TAGS = new Set([
  '正在下雨',
  '云层较厚',
  '光照被遮挡',
  '视野开阔',
  '建筑遮挡',
  '视野受建筑遮挡'
])

function text(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength)
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function integerLevel(value, name) {
  const result = finite(value)
  if (!Number.isInteger(result) || result < 0 || result > 3) throw new Error(`${name}反馈值无效`)
  return result
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map((item) => text(item, 20)).filter((item) => ALLOWED_TAGS.has(item)))].slice(0, 5)
}

function buildLocationGrid(latitude, longitude) {
  const lat = finite(latitude)
  const lon = finite(longitude)
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return ''
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}

function legacySeenLevel(observedScore) {
  const score = finite(observedScore)
  if (!Number.isInteger(score) || score < 0 || score > 4) throw new Error('实际霞况反馈值无效')
  if (score === 0) return 0
  if (score <= 2) return 1
  if (score === 3) return 2
  return 3
}

function legacyCloudCondition(tags) {
  if (tags.includes('云层较厚')) return 'overcast'
  return 'few'
}

function legacyVisibilityLevel(tags) {
  if (tags.includes('建筑遮挡') || tags.includes('视野受建筑遮挡') || tags.includes('光照被遮挡')) return 'poor'
  if (tags.includes('视野开阔')) return 'good'
  return 'fair'
}

function validateFeedback(event = {}) {
  const forecastId = text(event.forecastId, 180)
  const cityCode = text(event.cityCode, 30)
  const sceneType = text(event.sceneType, 20)
  const windowStart = finite(event.windowStart)
  const windowEnd = finite(event.windowEnd)
  if (!forecastId) throw new Error('缺少预报标识')
  if (!cityCode) throw new Error('缺少城市代码')
  if (!SCENE_TYPES.has(sceneType)) throw new Error('霞况类型无效')
  if (windowStart === null || windowEnd === null || windowEnd <= windowStart) throw new Error('预报时段无效')

  const tags = normalizeTags(event.tags)
  const isLegacy = event.seenLevel === null || event.seenLevel === undefined || event.seenLevel === ''
  const seenLevel = isLegacy ? legacySeenLevel(event.observedScore) : integerLevel(event.seenLevel, '实际霞况')
  const colorIntensity = isLegacy ? seenLevel : integerLevel(event.colorIntensity, '霞色强度')
  const cloudCondition = isLegacy ? legacyCloudCondition(tags) : text(event.cloudCondition, 20)
  const visibilityLevel = isLegacy ? legacyVisibilityLevel(tags) : text(event.visibilityLevel, 20)
  if (!CLOUD_CONDITIONS.has(cloudCondition)) throw new Error('云层情况反馈值无效')
  if (!VISIBILITY_LEVELS.has(visibilityLevel)) throw new Error('能见度反馈值无效')
  if (seenLevel === 0 && colorIntensity !== 0) throw new Error('实际霞况与霞色强度反馈矛盾')

  const locationGrid = buildLocationGrid(event.latitude, event.longitude)
  return {
    forecastId,
    cityCode,
    sceneType,
    windowStart: Math.round(windowStart),
    windowEnd: Math.round(windowEnd),
    seenLevel,
    colorIntensity,
    cloudCondition,
    visibilityLevel,
    tags,
    note: text(event.note, 60),
    locationGrid,
    locationScore: locationGrid ? 1 : 0.55,
    legacyNormalized: isLegacy
  }
}

function validateForecastBinding({ feedback, forecastRecord, now = Date.now() } = {}) {
  if (!forecastRecord || !forecastRecord.forecastId) throw new Error('未找到对应的权威预报记录')
  const matches = feedback &&
    feedback.forecastId === forecastRecord.forecastId &&
    feedback.cityCode === String(forecastRecord.cityCode || '') &&
    feedback.sceneType === forecastRecord.sceneType &&
    feedback.windowStart === Number(forecastRecord.windowStart) &&
    feedback.windowEnd === Number(forecastRecord.windowEnd)
  if (!matches) throw new Error('反馈与权威预报记录不匹配')
  const start = Number(forecastRecord.windowStart)
  const end = Number(forecastRecord.windowEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('权威预报时段无效')
  if (!Number.isFinite(Number(now)) || Number(now) < start || Number(now) > end) {
    throw new Error('当前不在本次霞况反馈时段内')
  }
  return forecastRecord
}

function boundedScore(value, fallback) {
  const result = finite(value)
  if (result === null) return fallback
  return Math.max(0, Math.min(1, result))
}

function evaluateSubmission({
  inWindow,
  locationScore,
  frequencyScore,
  completenessScore,
  consensusDelta,
  consensusCount
} = {}) {
  const reasons = []
  const schemaVersion = 2
  if (!inWindow) {
    return { status: 'rejected', reviewStatus: 'rejected', reviewScore: 0, reviewReasons: ['outside_window'], schemaVersion }
  }
  reasons.push('inside_window')
  const location = boundedScore(locationScore, 0.55)
  const frequency = boundedScore(frequencyScore, 1)
  const completeness = boundedScore(completenessScore, 0.75)
  const count = Math.max(0, Math.floor(finite(consensusCount) || 0))
  const delta = finite(consensusDelta)
  const consensus = delta === null ? 0.5 : delta <= 1 ? 1 : delta <= 2 ? 0.6 : 0.2
  reasons.push(location >= 1 ? 'location_grid_present' : 'location_unavailable')
  reasons.push(frequency >= 0.75 ? 'frequency_normal' : 'frequency_anomaly')
  reasons.push(completeness >= 1 ? 'feedback_complete' : 'feedback_incomplete')
  reasons.push(count ? (delta !== null && delta <= 1 ? 'consensus_aligned' : 'consensus_differs') : 'consensus_pending')

  const reviewScore = Math.round((0.25 + location * 0.2 + frequency * 0.15 + completeness * 0.15 + consensus * 0.25) * 100)
  let reviewStatus = 'provisional'
  if (reviewScore < 45) reviewStatus = 'rejected'
  else if (count >= 2 && delta !== null && delta <= 1 && reviewScore >= 75) reviewStatus = 'auto_approved'
  return { status: reviewStatus, reviewStatus, reviewScore, reviewReasons: reasons, schemaVersion }
}

function normalizeObservations({ feedback = {}, forecastRecord = {} } = {}) {
  const seenLevel = feedback.seenLevel === null || feedback.seenLevel === undefined
    ? legacySeenLevel(feedback.observedScore)
    : integerLevel(feedback.seenLevel, '实际霞况')
  const colorIntensity = feedback.colorIntensity === null || feedback.colorIntensity === undefined
    ? seenLevel
    : integerLevel(feedback.colorIntensity, '霞色强度')
  return {
    feedbackId: feedback._id || feedback.feedbackId || '',
    forecastId: forecastRecord.forecastId || '',
    cityCode: String(forecastRecord.cityCode || ''),
    cityName: String(forecastRecord.cityName || ''),
    districtName: String(forecastRecord.districtName || ''),
    locationGrid: String(feedback.locationGrid || ''),
    sceneType: forecastRecord.sceneType || '',
    windowStart: Number(forecastRecord.windowStart),
    windowEnd: Number(forecastRecord.windowEnd),
    observedLevel: forecastRecord.sceneType === 'fireCloud' ? colorIntensity : seenLevel,
    seenLevel,
    colorIntensity,
    cloudCondition: feedback.cloudCondition || null,
    visibilityLevel: feedback.visibilityLevel || null,
    tags: normalizeTags(feedback.tags),
    note: text(feedback.note, 60),
    forecastScore: finite(forecastRecord.score),
    forecastProbability: finite(forecastRecord.probability),
    algorithmVersion: String(forecastRecord.algorithmVersion || ''),
    reviewScore: finite(feedback.reviewScore),
    schemaVersion: 2
  }
}

module.exports = {
  validateFeedback,
  validateForecastBinding,
  buildLocationGrid,
  evaluateSubmission,
  normalizeObservations
}
