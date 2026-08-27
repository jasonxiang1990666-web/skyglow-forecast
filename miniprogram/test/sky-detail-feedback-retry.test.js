const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { savePendingFeedback, readPendingFeedback } = require('../utils/feedback-retry')

const PAGE_PATH = require.resolve('../pages/sky-detail/sky-detail')
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
  tags: [],
  note: ''
}

function storage() {
  const values = new Map()
  return {
    getStorageSync: (key) => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key)
  }
}

function loadRetryPage(submissions) {
  let definition
  const originalLoad = Module._load
  const originalPage = global.Page
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === PAGE_PATH && request === '../../services/weather') {
      return {
        getNext24HourForecast: async () => ({}),
        getNearbyViewingSpots: async () => ({}),
        getFeaturedViewingSpots: async () => ({}),
        submitSkyFeedback: async (input) => { submissions.push(input); return { ok: true, message: 'ok' } }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  global.Page = (page) => { definition = page }
  delete require.cache[PAGE_PATH]
  require(PAGE_PATH)
  return {
    definition,
    restore() {
      Module._load = originalLoad
      global.Page = originalPage
      delete require.cache[PAGE_PATH]
    }
  }
}

function pageInstance(definition, skyWindow) {
  return {
    ...definition,
    data: {
      selected: { forecastId: payload.forecastId },
      skyWindow,
      feedback: { submitting: false, submitted: false, message: '' }
    },
    setData(changes) {
      for (const [key, value] of Object.entries(changes)) {
        const [section, property] = key.split('.')
        if (property) this.data[section][property] = value
        else this.data[key] = value
      }
    }
  }
}

test('does not send a pending retry after the loaded authoritative window has closed', async () => {
  const submissions = []
  const wxStorage = storage()
  savePendingFeedback(wxStorage, payload)
  const harness = loadRetryPage(submissions)
  const originalWx = global.wx
  const originalNow = Date.now
  global.wx = wxStorage
  Date.now = () => 1500
  try {
    pageInstance(harness.definition, { startAt: 1000, endAt: 1400 }).retryPendingFeedback()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(submissions, [])
    assert.equal(readPendingFeedback(wxStorage), null)
  } finally {
    Date.now = originalNow
    global.wx = originalWx
    harness.restore()
  }
})

test('does not send a pending retry when the loaded authoritative window is missing', async () => {
  const submissions = []
  const wxStorage = storage()
  savePendingFeedback(wxStorage, payload)
  const harness = loadRetryPage(submissions)
  const originalWx = global.wx
  global.wx = wxStorage
  try {
    pageInstance(harness.definition, null).retryPendingFeedback()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(submissions, [])
    assert.notEqual(readPendingFeedback(wxStorage), null)
  } finally {
    global.wx = originalWx
    harness.restore()
  }
})

test('sends a pending retry while the loaded authoritative window is active even if the stored window is stale', async () => {
  const submissions = []
  const wxStorage = storage()
  savePendingFeedback(wxStorage, payload)
  const harness = loadRetryPage(submissions)
  const originalWx = global.wx
  const originalNow = Date.now
  global.wx = wxStorage
  Date.now = () => 3500
  try {
    pageInstance(harness.definition, { startAt: 3000, endAt: 4000 }).retryPendingFeedback()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(submissions, [payload])
  } finally {
    Date.now = originalNow
    global.wx = originalWx
    harness.restore()
  }
})
