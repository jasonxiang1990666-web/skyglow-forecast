const test = require('node:test')
const assert = require('node:assert/strict')
const { buildForecastId, locationGrid, enrichForecastWindows, persistForecastRecords } = require('../forecast-record')
const { weatherUpdatedAtFromResponses } = require('../qweather')

test('builds a stable nationwide forecast id from the canonical key and algorithm version', () => {
  const input = {
    cityCode: '101020100',
    sceneType: 'sunset',
    observationDate: '2026-08-07',
    windowStart: 1786100000000,
    algorithmVersion: '2.0'
  }
  assert.equal(buildForecastId(input), '101020100|sunset|2026-08-07|1786100000000|2.0')
  assert.notEqual(buildForecastId({ ...input, algorithmVersion: '2.1' }), buildForecastId(input))
})

test('rounds coordinates to the one-kilometre location grid', () => {
  assert.equal(locationGrid(31.2304, 121.4737), '31.23,121.47')
  assert.equal(locationGrid(null, null), '')
})

test('enriches each viewing window with distinct primary-sky and fire-cloud records without storing exact coordinates', () => {
  const confidence = {
    level: 'high',
    reasons: ['weather data is fresh'],
    ecStatus: 'ready',
    gfsStatus: 'ready',
    modelAgreement: 'consistent'
  }
  const result = enrichForecastWindows({
    forecast: {
      city: 'Shanghai',
      scoringVersion: '2.0',
      skyWindows: [{
        kind: 'sunset',
        date: '2026-08-07',
        startAt: 1786100000000,
        endAt: 1786103600000,
        primarySky: { score: 82, probability: 68 },
        fireCloud: { score: 73, probability: 55, vividnessLevel: 'medium' },
        skies: [{ score: 82, probability: 68 }, { score: 73, probability: 55, vividnessLevel: 'medium' }]
      }]
    },
    location: { id: '101020100', adm2: 'Shanghai', name: 'Huangpu' },
    coordinates: { latitude: 31.2304, longitude: 121.4737 },
    confidenceByKind: { sunset: confidence },
    weatherUpdatedAt: 1786096400000
  })

  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].forecastId, '101020100|sunset|2026-08-07|1786100000000|2.0')
  assert.equal(result.records[1].forecastId, '101020100|fireCloud|2026-08-07|1786100000000|2.0')
  assert.equal(result.records[0].locationGrid, '31.23,121.47')
  assert.equal(result.records[0].latitude, undefined)
  assert.equal(result.records[0].longitude, undefined)
  assert.equal(result.records[0].probability, 68)
  assert.equal(result.records[0].accuracyRate, undefined)
  assert.equal(result.records[1].vividnessLevel, 'medium')
  assert.equal(result.forecast.skyWindows[0].primarySky.forecastId, result.records[0].forecastId)
  assert.deepEqual(result.forecast.skyWindows[0].fireCloud.forecastConfidence, confidence)
})

test('keeps forecast enrichment safe when district, coordinates, and optional legacy fields are absent', () => {
  const result = enrichForecastWindows({
    forecast: {
      city: 'Shanghai',
      scoringVersion: '2.0',
      skyWindows: [{ kind: 'sunrise', date: '2026-08-08', startAt: 1786130000000, endAt: 1786133600000, skies: [{ score: 40 }, { score: 30 }] }]
    },
    location: { id: '101020100' }
  })

  assert.equal(result.records[0].districtName, '')
  assert.equal(result.records[0].locationGrid, '')
  assert.equal(result.records[0].confidenceLevel, 'low')
  assert.equal(result.records[1].sceneType, 'fireCloud')
})

test('upserts records by forecast id so a refresh replaces the authoritative snapshot', async () => {
  const stored = new Map()
  const db = {
    collection() {
      return {
        where({ forecastId }) {
          return {
            limit() { return this },
            async get() {
              const record = stored.get(forecastId)
              return { data: record ? [{ _id: forecastId, ...record }] : [] }
            }
          }
        },
        doc(id) {
          return { update: async ({ data }) => stored.set(id, data) }
        },
        add: async ({ data }) => stored.set(data.forecastId, data)
      }
    }
  }

  await persistForecastRecords(db, [{ forecastId: 'record-1', score: 50 }])
  await persistForecastRecords(db, [{ forecastId: 'record-1', score: 80 }])

  assert.equal(stored.size, 1)
  assert.deepEqual(stored.get('record-1'), { forecastId: 'record-1', score: 80 })
})

test('uses the latest available weather-provider update timestamp with a safe current-time fallback', () => {
  assert.equal(
    weatherUpdatedAtFromResponses({ updateTime: '2026-08-07T08:20+08:00' }, { updateTime: '2026-08-07T07:20+08:00' }, 1),
    Date.parse('2026-08-07T08:20+08:00')
  )
  assert.equal(weatherUpdatedAtFromResponses({}, {}, 1234), 1234)
})
