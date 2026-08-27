const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateForecastConfidence } = require('../confidence')

test('fresh complete consistent data is high confidence', () => {
  const now = Date.parse('2026-08-07T12:00:00+08:00')
  const result = evaluateForecastConfidence({
    now,
    weatherUpdatedAt: now - 60 * 60 * 1000,
    requiredWeatherFields: [20, 40, 60],
    ec: { status: 'ready', validAt: now, totalCloud: 52, precipitation: 0 },
    gfs: { status: 'ready', validAt: now, totalCloud: 63, precipitation: 0 }
  })
  assert.equal(result.level, 'high')
  assert.equal(result.modelAgreement, 'consistent')
})

test('cloud difference over 30 or rain conflict is low confidence', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 10, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 70, precipitation: 1 }
  })
  assert.equal(result.level, 'low')
  assert.equal(result.modelAgreement, 'conflict')
})

test('weather data exactly three hours old remains fresh', () => {
  const result = evaluateForecastConfidence({
    now: 3 * 60 * 60 * 1000,
    weatherUpdatedAt: 0,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 40, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 40, precipitation: 0 }
  })
  assert.equal(result.freshness, 'fresh')
  assert.equal(result.level, 'high')
})

test('weather data exactly six hours old is normal confidence input', () => {
  const result = evaluateForecastConfidence({
    now: 6 * 60 * 60 * 1000,
    weatherUpdatedAt: 0,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 40, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 40, precipitation: 0 }
  })
  assert.equal(result.freshness, 'normal')
  assert.equal(result.level, 'medium')
})

test('cloud difference of fifteen percent remains consistent', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 40, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 55, precipitation: 0 }
  })
  assert.equal(result.modelAgreement, 'consistent')
})

test('cloud difference of thirty percent is different but not conflict', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 40, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 70, precipitation: 0 }
  })
  assert.equal(result.modelAgreement, 'different')
  assert.equal(result.level, 'medium')
})

test('a missing model degrades confidence without throwing', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 40, precipitation: 0 }
  })
  assert.equal(result.modelAgreement, 'unavailable')
  assert.equal(result.level, 'low')
  assert.equal(result.gfsStatus, 'missing')
})

test('missing weather fields lower confidence without throwing', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1, null, undefined],
    ec: { status: 'ready', totalCloud: 40, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 40, precipitation: 0 }
  })
  assert.equal(result.completeness, 'partial')
  assert.equal(result.level, 'low')
})

test('missing both models has deterministic low-confidence fallback', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1]
  })
  assert.equal(result.modelAgreement, 'unavailable')
  assert.equal(result.level, 'low')
  assert.equal(result.ecStatus, 'missing')
  assert.equal(result.gfsStatus, 'missing')
})
