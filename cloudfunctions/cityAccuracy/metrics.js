const SCENE_TYPES = ['sunrise', 'sunset', 'fireCloud']
const WINDOW_DAYS = 30
const MINIMUM_SAMPLES = 30
const DAY = 24 * 60 * 60 * 1000

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function scoreBin(score) {
  const value = finite(score)
  if (value === null || value < 0 || value > 100) return null
  if (value < 40) return 0
  if (value < 60) return 1
  if (value < 80) return 2
  return 3
}

function observationBin(level) {
  const value = finite(level)
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null
}

function legacyObservationBin(observedScore) {
  const value = finite(observedScore)
  if (!Number.isInteger(value) || value < 0 || value > 4) return null
  if (value === 0) return 0
  if (value <= 2) return 1
  if (value === 3) return 2
  return 3
}

function isHit(predictedBin, observedBin) {
  return Number.isInteger(predictedBin) && Number.isInteger(observedBin) && Math.abs(predictedBin - observedBin) <= 1
}

function collecting() {
  return {
    sampleCount: 0,
    hitCount: 0,
    accuracyRate: null,
    windowDays: WINDOW_DAYS,
    status: 'collecting'
  }
}

function identity(row) {
  const cityCode = String(row && row.cityCode || '').trim()
  const sceneType = String(row && row.sceneType || '').trim()
  const observationDate = String(row && row.observationDate || '').trim()
  const windowStart = finite(row && row.windowStart)
  if (!cityCode || !SCENE_TYPES.includes(sceneType) || !observationDate || windowStart === null) return ''
  return `${cityCode}|${sceneType}|${observationDate}|${windowStart}`
}

function observedTime(row) {
  const observedAt = finite(row && row.observedAt)
  return observedAt === null ? finite(row && row.windowStart) : observedAt
}

function normalizedObservation(row, cutoff, now) {
  const key = identity(row)
  const time = observedTime(row)
  const forecastBin = scoreBin(row && row.forecastScore)
  const observedBin = observationBin(row && row.observedLevel) ?? legacyObservationBin(row && row.observedScore)
  if (!key || time === null || time < cutoff || time > now || forecastBin === null || observedBin === null) return null
  return { key, sceneType: row.sceneType, hit: isHit(forecastBin, observedBin) }
}

function aggregateAccuracy(observations = [], now = Date.now()) {
  const referenceNow = finite(now)
  const normalizedNow = referenceNow === null ? Date.now() : referenceNow
  const cutoff = normalizedNow - WINDOW_DAYS * DAY
  const metrics = SCENE_TYPES.reduce((result, sceneType) => {
    result[sceneType] = collecting()
    return result
  }, {})
  const unique = new Map()

  for (const row of Array.isArray(observations) ? observations : []) {
    const item = normalizedObservation(row, cutoff, normalizedNow)
    if (!item || unique.has(item.key)) continue
    unique.set(item.key, item)
  }
  for (const item of unique.values()) {
    const metric = metrics[item.sceneType]
    metric.sampleCount += 1
    if (item.hit) metric.hitCount += 1
  }
  for (const metric of Object.values(metrics)) {
    if (metric.sampleCount >= MINIMUM_SAMPLES) {
      metric.accuracyRate = metric.hitCount / metric.sampleCount
      metric.status = 'ready'
    }
  }
  return metrics
}

module.exports = { SCENE_TYPES, WINDOW_DAYS, scoreBin, observationBin, isHit, aggregateAccuracy, collecting }
