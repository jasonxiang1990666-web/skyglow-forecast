const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const INDEX_PATH = require.resolve('../index')
const forecastRecord = {
  forecastId: '101020100|sunset|2026-08-07|1786100000000|2.0',
  cityCode: '101020100',
  cityName: '上海',
  districtName: '黄浦区',
  sceneType: 'sunset',
  windowStart: 1786100000000,
  windowEnd: 1786103600000,
  locationGrid: '31.23,121.47'
}

function loadFeedbackMainWithUnavailableFrequencyLookup() {
  const written = []
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: 'test-openid' }),
    database: () => ({
      serverDate: () => 'SERVER_DATE',
      collection(name) {
        if (name === 'forecastRecords') {
          return { doc: () => ({ get: async () => ({ data: forecastRecord }) }) }
        }
        if (name !== 'skyFeedback') throw new Error(`Unexpected collection: ${name}`)
        return {
          where(query) {
            if (query.anonymousUserHash && !query.forecastId) {
              return {
                orderBy: () => ({ limit: () => ({ get: async () => { throw new Error('missing frequency index') } }) }),
                limit: () => ({ get: async () => [] })
              }
            }
            return { limit: () => ({ get: async () => ({ data: [] }) }) }
          }
        }
      },
      async runTransaction(callback) {
        return callback({
          collection: () => ({
            doc: () => ({
              get: async () => { throw new Error('document with _id test does not exist') },
              set: async ({ data }) => { written.push(data) }
            })
          })
        })
      }
    })
  }
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === INDEX_PATH && request === 'wx-server-sdk') return fakeCloud
    if (parent && parent.filename === INDEX_PATH && request === './consensus') return { promoteConsensusBatch: async () => ({ promoted: false, feedbackIds: [] }) }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[INDEX_PATH]
  return {
    main: require('../index').main,
    written,
    restore() {
      Module._load = originalLoad
      delete require.cache[INDEX_PATH]
    }
  }
}

test('submissions are conservatively downgraded when the cross-city frequency query fails', async () => {
  const harness = loadFeedbackMainWithUnavailableFrequencyLookup()
  const originalNow = Date.now
  const originalWarn = console.warn
  Date.now = () => forecastRecord.windowStart + 1000
  console.warn = () => {}
  try {
    await harness.main({
      forecastId: forecastRecord.forecastId,
      cityCode: forecastRecord.cityCode,
      sceneType: forecastRecord.sceneType,
      windowStart: forecastRecord.windowStart,
      windowEnd: forecastRecord.windowEnd,
      seenLevel: 2,
      colorIntensity: 2,
      cloudCondition: 'layered',
      visibilityLevel: 'good',
      tags: [],
      note: '',
      latitude: 31.2304,
      longitude: 121.4737
    })

    assert.equal(harness.written.length, 1)
    assert.equal(harness.written[0].reviewScore, 76)
    assert.equal(harness.written[0].reviewReasons.includes('frequency_lookup_unavailable'), true)
  } finally {
    Date.now = originalNow
    console.warn = originalWarn
    harness.restore()
  }
})
