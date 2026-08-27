const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')

test('exports a getCityAccuracy action that degrades an empty city to collecting', async () => {
  const originalLoad = Module._load
  const indexPath = require.resolve('../index')
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database() {
          return {}
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[indexPath]

  try {
    const cityAccuracy = require('../index')
    assert.equal(typeof cityAccuracy.main, 'function')
    assert.deepEqual(await cityAccuracy.main({ action: 'getCityAccuracy', cityCode: '' }), {
      cityCode: '',
      windowDays: 30,
      sunrise: { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' },
      sunset: { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' },
      fireCloud: { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' }
    })
  } finally {
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})

test('returns collecting metrics when the accuracyStats lookup fails', async () => {
  const originalLoad = Module._load
  const originalWarn = console.warn
  const indexPath = require.resolve('../index')
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database() {
          return {
            collection() {
              return {
                where() {
                  throw new Error('database unavailable')
                }
              }
            }
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[indexPath]
  console.warn = () => {}

  try {
    const { main } = require('../index')
    const result = await main({ action: 'getCityAccuracy', cityCode: '101020100' })
    assert.equal(result.cityCode, '101020100')
    assert.equal(result.sunrise.status, 'collecting')
    assert.equal(result.sunset.accuracyRate, null)
    assert.equal(result.fireCloud.sampleCount, 0)
  } finally {
    Module._load = originalLoad
    console.warn = originalWarn
    delete require.cache[indexPath]
  }
})
