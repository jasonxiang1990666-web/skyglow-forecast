const assert = require('node:assert/strict')
const test = require('node:test')

const { scoreBin, observationBin, isHit, aggregateAccuracy } = require('../metrics')

const NOW = Date.parse('2026-08-27T02:20:00+08:00')
const DAY = 24 * 60 * 60 * 1000

function observation({
  id,
  cityCode = '101020100',
  sceneType = 'sunset',
  forecastScore = 70,
  observedLevel = 2,
  observedScore,
  observedAt = NOW - DAY,
  observationDate = '2026-08-26',
  windowStart = NOW - DAY
} = {}) {
  return { _id: id, cityCode, sceneType, forecastScore, observedLevel, observedScore, observedAt, observationDate, windowStart }
}

test('maps forecast and observation levels into the four fixed hit bins', () => {
  assert.equal(scoreBin(39), 0)
  assert.equal(scoreBin(40), 1)
  assert.equal(scoreBin(70), 2)
  assert.equal(scoreBin(80), 3)
  assert.equal(observationBin(0), 0)
  assert.equal(observationBin(3), 3)
  assert.equal(isHit(1, 2), true)
  assert.equal(isHit(0, 2), false)
})

test('keeps accuracyRate null at 29 samples and makes it ready at 30 samples', () => {
  const rows = Array.from({ length: 30 }, (_, index) => observation({
    id: `sunset-${index}`,
    observedAt: NOW - (index + 1) * 1000,
    windowStart: NOW - (index + 1) * 1000
  }))

  const atTwentyNine = aggregateAccuracy(rows.slice(0, 29), NOW).sunset
  const atThirty = aggregateAccuracy(rows, NOW).sunset

  assert.deepEqual(atTwentyNine, {
    sampleCount: 29,
    hitCount: 29,
    accuracyRate: null,
    windowDays: 30,
    status: 'collecting'
  })
  assert.deepEqual(atThirty, {
    sampleCount: 30,
    hitCount: 30,
    accuracyRate: 1,
    windowDays: 30,
    status: 'ready'
  })
})

test('aggregates sunrise, sunset and fireCloud separately with canonical identities only', () => {
  const rows = [
    observation({ id: 'sunrise', sceneType: 'sunrise', forecastScore: 40, observedLevel: 0 }),
    observation({ id: 'sunset', sceneType: 'sunset', forecastScore: 80, observedLevel: 3 }),
    observation({ id: 'fire', sceneType: 'fireCloud', forecastScore: 39, observedLevel: 2 }),
    observation({ id: 'duplicate', sceneType: 'sunset', forecastScore: 0, observedLevel: 3, windowStart: NOW - DAY }),
    observation({ id: 'missing-city', cityCode: '', sceneType: 'sunset' }),
    observation({ id: 'missing-window', sceneType: 'sunset', windowStart: null }),
    observation({ id: 'old', sceneType: 'sunset', observedAt: NOW - 31 * DAY })
  ]

  const result = aggregateAccuracy(rows, NOW)

  assert.deepEqual(result.sunrise, { sampleCount: 1, hitCount: 1, accuracyRate: null, windowDays: 30, status: 'collecting' })
  assert.deepEqual(result.sunset, { sampleCount: 1, hitCount: 1, accuracyRate: null, windowDays: 30, status: 'collecting' })
  assert.deepEqual(result.fireCloud, { sampleCount: 1, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' })
})

test('supports legacy observedScore and ignores incomplete observations', () => {
  const result = aggregateAccuracy([
    observation({ id: 'legacy-four', observedLevel: null, observedScore: 4, forecastScore: 80 }),
    observation({ id: 'legacy-two', observedLevel: null, observedScore: 2, forecastScore: 40, windowStart: NOW - DAY - 1 }),
    observation({ id: 'bad-legacy', observedLevel: null, observedScore: 9 }),
    observation({ id: 'missing-score', forecastScore: null }),
    observation({ id: 'missing-date', observationDate: '' })
  ], NOW)

  assert.deepEqual(result.sunset, { sampleCount: 2, hitCount: 2, accuracyRate: null, windowDays: 30, status: 'collecting' })
})

test('excludes historical observations without observedAt instead of treating windowStart as observed time', () => {
  const result = aggregateAccuracy([
    observation({ id: 'missing-observed-at', observedAt: null, windowStart: NOW - DAY })
  ], NOW)

  assert.deepEqual(result.sunset, { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' })
})

test('returns collecting structures for a city with no observations', () => {
  assert.deepEqual(aggregateAccuracy([], NOW), {
    sunrise: { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' },
    sunset: { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' },
    fireCloud: { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' }
  })
})
