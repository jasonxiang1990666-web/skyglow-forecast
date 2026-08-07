const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const INDEX_PATH = require.resolve('../index')

function loadForecastMain() {
  const calls = { city: 0, coordinates: [], records: [] }
  const location = { id: '101020100', adm2: 'Shanghai', name: 'Shanghai', lat: '31.23', lon: '121.47' }
  const forecast = {
    city: 'Shanghai',
    scoringVersion: '2.0',
    skyWindows: [{
      kind: 'sunset',
      date: '2026-08-07',
      startAt: 1786100000000,
      endAt: 1786103600000,
      primarySky: { score: 82, probability: 68 },
      fireCloud: { score: 73, probability: 55 },
      skies: [{ score: 82, probability: 68 }, { score: 73, probability: 55 }]
    }]
  }
  const stubs = {
    'wx-server-sdk': {
      DYNAMIC_CURRENT_ENV: 'test',
      init: () => {},
      database: () => ({
        collection: () => ({ doc: () => ({ set: async ({ data }) => calls.records.push(data) }) })
      })
    },
    './qweather': {
      lookupCity: async () => { calls.city += 1; return location },
      lookupCoordinates: async (latitude, longitude) => { calls.coordinates.push([latitude, longitude]); return location },
      searchCities: async () => [],
      getWeather: async () => ({ hourly: [], daily: [], weatherUpdatedAt: 1786096400000 }),
      getTwoWeekWeather: async () => ({ hourly: [], daily: [] }),
      getAirQuality: async () => null,
      getAlerts: async () => []
    },
    './scoring': { buildForecastView: () => forecast, buildTwoWeekForecastView: () => ({}) },
    './national-overview': { buildNationalCityOverview: () => ({}) },
    './places': { getNearbyViewingSpots: () => [] },
    './featured-spots': { getFeaturedViewingSpots: () => [], getFeaturedViewingSpot: () => ({}) },
    './model-live': { getLiveModelReferences: async () => ({}) },
    './calibration': { getCalibrationProfile: async () => null }
  }
  const load = Module._load
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === INDEX_PATH && stubs[request]) return stubs[request]
    return load.call(this, request, parent, isMain)
  }
  delete require.cache[INDEX_PATH]
  const main = require('../index').main
  return {
    main,
    calls,
    restore() {
      Module._load = load
      delete require.cache[INDEX_PATH]
    }
  }
}

test('null and empty GPS values use city lookup without persisting a fake zero-coordinate grid', async () => {
  for (const [latitude, longitude] of [[null, null], ['', '']]) {
    const harness = loadForecastMain()
    try {
      const response = await harness.main({ city: 'Shanghai', latitude, longitude })
      assert.equal(harness.calls.city, 1)
      assert.deepEqual(harness.calls.coordinates, [])
      assert.equal(harness.calls.records.length, 2)
      assert.equal(harness.calls.records[0].locationGrid, '')
      assert.equal(response.skyWindows[0].primarySky.score, 82)
    } finally {
      harness.restore()
    }
  }
})

test('numeric coordinate strings still use coordinate lookup', async () => {
  const harness = loadForecastMain()
  try {
    await harness.main({ city: 'Shanghai', latitude: '31.2304', longitude: '121.4737' })
    assert.equal(harness.calls.city, 0)
    assert.deepEqual(harness.calls.coordinates, [[31.2304, 121.4737]])
  } finally {
    harness.restore()
  }
})
