const STORAGE_KEY = 'pendingSkyFeedback'

function string(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength)
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function sanitizePendingFeedback(payload = {}) {
  const forecastId = string(payload.forecastId, 180)
  const cityCode = string(payload.cityCode, 30)
  const sceneType = string(payload.sceneType, 20)
  const windowStart = finite(payload.windowStart)
  const windowEnd = finite(payload.windowEnd)
  if (!forecastId || !cityCode || !sceneType || windowStart === null || windowEnd === null || windowEnd <= windowStart) return null

  const pending = {
    forecastId,
    cityCode,
    sceneType,
    windowStart: Math.round(windowStart),
    windowEnd: Math.round(windowEnd)
  }
  const structured = payload.seenLevel !== null && payload.seenLevel !== undefined && payload.seenLevel !== ''
  if (structured) {
    pending.seenLevel = Number(payload.seenLevel)
    pending.colorIntensity = Number(payload.colorIntensity)
    pending.cloudCondition = string(payload.cloudCondition, 20)
    pending.visibilityLevel = string(payload.visibilityLevel, 20)
  } else if (payload.observedScore !== null && payload.observedScore !== undefined && payload.observedScore !== '') {
    pending.observedScore = Number(payload.observedScore)
  }
  pending.tags = Array.isArray(payload.tags) ? payload.tags.map((item) => string(item, 20)).filter(Boolean).slice(0, 5) : []
  pending.note = string(payload.note, 60)
  return pending
}

function readPendingFeedback(storage) {
  if (!storage || typeof storage.getStorageSync !== 'function') return null
  return sanitizePendingFeedback(storage.getStorageSync(STORAGE_KEY))
}

function savePendingFeedback(storage, payload) {
  const pending = sanitizePendingFeedback(payload)
  if (!pending || !storage || typeof storage.setStorageSync !== 'function') return false
  storage.setStorageSync(STORAGE_KEY, pending)
  return true
}

function claimPendingFeedback(storage, { now = Date.now(), forecastId } = {}) {
  const pending = readPendingFeedback(storage)
  if (!pending) return null
  const current = finite(now)
  if (current === null || current < pending.windowStart || current > pending.windowEnd) {
    storage.removeStorageSync(STORAGE_KEY)
    return null
  }
  if (pending.forecastId !== String(forecastId || '')) return null
  storage.removeStorageSync(STORAGE_KEY)
  return pending
}

function clearPendingFeedback(storage, forecastId) {
  const pending = readPendingFeedback(storage)
  if (!pending || pending.forecastId !== String(forecastId || '')) return false
  storage.removeStorageSync(STORAGE_KEY)
  return true
}

module.exports = {
  STORAGE_KEY,
  savePendingFeedback,
  readPendingFeedback,
  claimPendingFeedback,
  clearPendingFeedback
}
