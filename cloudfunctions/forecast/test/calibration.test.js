const test = require('node:test')
const assert = require('node:assert/strict')

const { getCalibrationProfile, applyBoundedCalibration } = require('../calibration')
const { buildForecastView } = require('../scoring')

const DAY = 24 * 60 * 60 * 1000

function freshStat(sceneType, overrides = {}) {
  const now = Date.now()
  return {
    cityCode: '101020100',
    sceneType,
    windowDays: 30,
    status: 'ready',
    sampleCount: 30,
    hitCount: 24,
    accuracyRate: 0.8,
    coverageStart: now - 30 * DAY,
    coverageEnd: now,
    updatedAt: now,
    ...overrides
  }
}

function statsDatabase(rows, calls) {
  return {
    collection(name) {
      calls.collections.push(name)
      return {
        where(query) {
          calls.queries.push(query)
          return {
            limit() {
              return { get: async () => ({ data: rows }) }
            }
          }
        }
      }
    }
  }
}

function forecastView(calibrationProfile) {
  const daily = ['2026-08-27', '2026-08-28'].map((fxDate) => ({
    fxDate,
    sunrise: '05:30',
    sunset: '18:30',
    cloud: 50,
    humidity: 65,
    windSpeedDay: 10,
    vis: 10,
    pop: 0,
    precip: 0,
    textDay: '晴'
  }))
  const hourly = [
    '2026-08-27T10:00:00.000Z',
    '2026-08-27T21:00:00.000Z'
  ].map((fxTime) => ({ fxTime, temp: 24, cloud: 50, humidity: 65, windSpeed: 10, vis: 10, pop: 0, precip: 0, text: '晴' }))
  return buildForecastView({
    city: '上海',
    hourly,
    daily,
    alerts: [],
    airQuality: null,
    now: new Date('2026-08-27T12:00:00+08:00'),
    calibrationProfile
  })
}

test('keeps the original probability when the city stat has fewer than 30 samples', () => {
  assert.equal(typeof applyBoundedCalibration, 'function')

  const result = applyBoundedCalibration(64, 'sunset', {
    status: 'pending',
    source: 'accuracyStats',
    sampleCount: 29,
    minimumSamples: 30,
    stats: {
      sunset: { sampleCount: 29, accuracyRate: null, status: 'collecting' }
    }
  })

  assert.deepEqual(result, {
    probability: 64,
    status: 'pending',
    label: '模型估算出现概率（城市准确率积累中）',
    sampleCount: 29,
    source: 'accuracyStats',
    adjustment: 0
  })
})

test('applies a ready city accuracy adjustment capped at five percentage points', () => {
  const result = applyBoundedCalibration(64, 'sunset', {
    status: 'calibrated',
    source: 'accuracyStats',
    sampleCount: 30,
    minimumSamples: 30,
    stats: {
      sunset: { sampleCount: 30, accuracyRate: 1, status: 'ready' }
    }
  })

  assert.equal(result.probability, 69)
  assert.equal(result.adjustment, 5)
  assert.equal(result.status, 'calibrated')
  assert.equal(result.source, 'accuracyStats')
  assert.equal(result.sampleCount, 30)
  assert.match(result.label, /准确率/)
  assert.ok(Math.abs(result.probability - 64) <= 5)
})

test('reads fresh 30-day accuracy stats by machine city code', async () => {
  const calls = { collections: [], queries: [] }
  const profile = await getCalibrationProfile(statsDatabase([
    freshStat('sunrise'),
    freshStat('sunset'),
    freshStat('fireCloud')
  ], calls), '101020100')

  assert.equal(profile.cityCode, '101020100')
  assert.equal(profile.source, 'accuracyStats')
  assert.equal(profile.status, 'calibrated')
  assert.equal(profile.stats.sunset.sampleCount, 30)
  assert.equal(profile.stats.fireCloud.accuracyRate, 0.8)
  assert.deepEqual(calls.collections, ['accuracyStats'])
  assert.deepEqual(calls.queries, [{ cityCode: '101020100', windowDays: 30 }])
})

test('rejects a ready stat when its accuracy rate contradicts hit and sample counts', async () => {
  const profile = await getCalibrationProfile(statsDatabase([
    freshStat('sunset', { hitCount: 0, accuracyRate: 1 })
  ], { collections: [], queries: [] }), '101020100')

  const result = applyBoundedCalibration(64, 'sunset', profile)

  assert.equal(result.probability, 64)
  assert.equal(result.adjustment, 0)
  assert.equal(result.status, 'pending')
})

test('falls back unchanged for malformed stats and database failures', async () => {
  const malformed = await getCalibrationProfile(statsDatabase([
    freshStat('sunset', { accuracyRate: null })
  ], { collections: [], queries: [] }), '101020100')
  const originalWarn = console.warn
  console.warn = () => {}
  let failed
  try {
    failed = await getCalibrationProfile({
      collection() {
        throw new Error('database timeout')
      }
    }, '101020100')
  } finally {
    console.warn = originalWarn
  }

  for (const profile of [malformed, failed]) {
    const result = applyBoundedCalibration(47, 'sunset', profile)
    assert.equal(result.probability, 47)
    assert.equal(result.adjustment, 0)
    assert.equal(result.status, 'pending')
    assert.equal(result.source, 'accuracyStats')
  }
})

test('applies separate accuracy stats to sunrise, sunset, and fire-cloud probabilities', async () => {
  const profile = await getCalibrationProfile(statsDatabase([
    freshStat('sunrise', { hitCount: 6, accuracyRate: 0.2 }),
    freshStat('sunset', { hitCount: 24, accuracyRate: 0.8 }),
    freshStat('fireCloud', { hitCount: 15, accuracyRate: 0.5 })
  ], { collections: [], queries: [] }), '101020100')

  assert.equal(applyBoundedCalibration(50, '朝霞', profile).probability, 47)
  assert.equal(applyBoundedCalibration(50, '晚霞', profile).probability, 53)
  assert.equal(applyBoundedCalibration(50, '火烧云', profile).probability, 50)
})

test('calibration changes only probability, never sky score or fire-cloud vividness', () => {
  const baseline = forecastView(null)
  const calibrated = forecastView({
    status: 'calibrated',
    source: 'accuracyStats',
    sampleCount: 30,
    minimumSamples: 30,
    stats: {
      sunrise: { sampleCount: 30, accuracyRate: 1, status: 'ready' },
      sunset: { sampleCount: 30, accuracyRate: 1, status: 'ready' },
      fireCloud: { sampleCount: 30, accuracyRate: 1, status: 'ready' }
    }
  })

  for (const [index, window] of calibrated.skyWindows.entries()) {
    const original = baseline.skyWindows[index]
    assert.equal(window.primarySky.score, original.primarySky.score)
    assert.equal(window.fireCloud.score, original.fireCloud.score)
    assert.equal(window.fireCloud.vividness, original.fireCloud.vividness)
    assert.equal(window.primarySky.probability, original.primarySky.probability + 5)
    assert.equal(window.fireCloud.probability, original.fireCloud.probability + 5)
    assert.equal(window.primarySky.calibrationSource, 'accuracyStats')
    assert.equal(window.primarySky.calibrationAdjustment, 5)
  }
  assert.match(calibrated.calibration.note, /准确率.*不等同.*出现概率/)
})
