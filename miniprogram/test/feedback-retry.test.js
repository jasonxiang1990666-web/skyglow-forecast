const test = require('node:test')
const assert = require('node:assert/strict')
const {
  STORAGE_KEY,
  savePendingFeedback,
  readPendingFeedback,
  claimPendingFeedback,
  clearPendingFeedback
} = require('../utils/feedback-retry')

function memoryStorage() {
  const values = new Map()
  return {
    values,
    getStorageSync(key) { return values.get(key) },
    setStorageSync(key, value) { values.set(key, value) },
    removeStorageSync(key) { values.delete(key) }
  }
}

const payload = {
  forecastId: 'forecast-shanghai-sunset',
  cityCode: '101020100',
  sceneType: 'sunset',
  windowStart: 1000,
  windowEnd: 2000,
  seenLevel: 2,
  colorIntensity: 3,
  cloudCondition: 'layered',
  visibilityLevel: 'good',
  tags: ['视野开阔'],
  note: '晚霞清楚',
  latitude: 31.2304,
  longitude: 121.4737
}

const storedPayload = {
  forecastId: payload.forecastId,
  cityCode: payload.cityCode,
  sceneType: payload.sceneType,
  windowStart: payload.windowStart,
  windowEnd: payload.windowEnd,
  seenLevel: payload.seenLevel,
  colorIntensity: payload.colorIntensity,
  cloudCondition: payload.cloudCondition,
  visibilityLevel: payload.visibilityLevel,
  tags: payload.tags,
  note: payload.note
}

test('keeps only the latest structured failure locally without coordinates', () => {
  const storage = memoryStorage()
  savePendingFeedback(storage, payload)
  savePendingFeedback(storage, { ...payload, forecastId: 'forecast-beijing-sunset', cityCode: '101010100', note: '第二次失败' })

  assert.equal(STORAGE_KEY, 'pendingSkyFeedback')
  assert.deepEqual(readPendingFeedback(storage), {
    forecastId: 'forecast-beijing-sunset',
    cityCode: '101010100',
    sceneType: 'sunset',
    windowStart: 1000,
    windowEnd: 2000,
    seenLevel: 2,
    colorIntensity: 3,
    cloudCondition: 'layered',
    visibilityLevel: 'good',
    tags: ['视野开阔'],
    note: '第二次失败'
  })
  assert.equal(storage.values.get(STORAGE_KEY).latitude, undefined)
  assert.equal(storage.values.get(STORAGE_KEY).longitude, undefined)
})

test('claims a matching in-window failure once and removes it before retrying', () => {
  const storage = memoryStorage()
  savePendingFeedback(storage, payload)

  assert.equal(claimPendingFeedback(storage, { now: 1500, forecastId: 'another-forecast' }), null)
  assert.deepEqual(readPendingFeedback(storage), storedPayload)

  assert.deepEqual(claimPendingFeedback(storage, { now: 1500, forecastId: payload.forecastId }), storedPayload)
  assert.equal(readPendingFeedback(storage), null)
  assert.equal(claimPendingFeedback(storage, { now: 1500, forecastId: payload.forecastId }), null)
})

test('drops expired failures and clears a matching failure after success', () => {
  const storage = memoryStorage()
  savePendingFeedback(storage, payload)
  assert.equal(claimPendingFeedback(storage, { now: 2001, forecastId: payload.forecastId }), null)
  assert.equal(readPendingFeedback(storage), null)

  savePendingFeedback(storage, payload)
  assert.equal(clearPendingFeedback(storage, 'another-forecast'), false)
  assert.notEqual(readPendingFeedback(storage), null)
  assert.equal(clearPendingFeedback(storage, payload.forecastId), true)
  assert.equal(readPendingFeedback(storage), null)
})

test('reads a legacy observedScore failure for compatibility without inventing new fields', () => {
  const storage = memoryStorage()
  storage.setStorageSync(STORAGE_KEY, {
    forecastId: payload.forecastId,
    cityCode: payload.cityCode,
    sceneType: payload.sceneType,
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    observedScore: 4,
    tags: ['视野开阔'],
    note: '旧版反馈',
    latitude: 31.2304,
    longitude: 121.4737
  })

  assert.deepEqual(readPendingFeedback(storage), {
    forecastId: payload.forecastId,
    cityCode: payload.cityCode,
    sceneType: payload.sceneType,
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    observedScore: 4,
    tags: ['视野开阔'],
    note: '旧版反馈'
  })
})
