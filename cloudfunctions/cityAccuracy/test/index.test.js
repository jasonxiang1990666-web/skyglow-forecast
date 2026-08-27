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

test('degrades a stale stored accuracy stat to collecting outside its current coverage', async () => {
  const originalLoad = Module._load
  const indexPath = require.resolve('../index')
  const now = Date.parse('2026-08-27T02:20:00+08:00')
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
    const { getCityAccuracy } = require('../index')
    const result = await getCityAccuracy({
      collection() {
        return {
          where() {
            return {
              limit() {
                return {
                  async get() {
                    return {
                      data: [{
                        cityCode: '101020100',
                        sceneType: 'sunset',
                        sampleCount: 30,
                        hitCount: 30,
                        accuracyRate: 1,
                        windowDays: 30,
                        coverageStart: now - 60 * 24 * 60 * 60 * 1000,
                        coverageEnd: now - 26 * 60 * 60 * 1000
                      }]
                    }
                  }
                }
              }
            }
          }
        }
      }
    }, '101020100', now)

    assert.deepEqual(result.sunset, { sampleCount: 0, hitCount: 0, accuracyRate: null, windowDays: 30, status: 'collecting' })
  } finally {
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})

test('reads bounded registry pages and aggregates only their indexed cities', async () => {
  const originalLoad = Module._load
  const indexPath = require.resolve('../index')
  const now = Date.parse('2026-08-27T02:20:00+08:00')
  const aggregateCalls = []
  const registryQueries = []
  const writes = []
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

  const registryPage = [{ cityCode: '101010100' }, { cityCode: '101020100' }]
  const aggregate = {
    match(value) { this.matchValues = [...(this.matchValues || []), value]; return this },
    project(value) { this.projects = [...(this.projects || []), value]; return this },
    group(value) { this.groups = [...(this.groups || []), value]; return this },
    sort(value) { this.sortValue = value; return this },
    limit(value) { this.limitValue = value; return this },
    async end() {
      aggregateCalls.push(this)
      const cityCode = this.matchValues.find((value) => typeof value.cityCode === 'string')?.cityCode
      if (cityCode === '101010100') return { data: [{ _id: 'sunrise', sampleCount: 30, hitCount: 29 }] }
      if (cityCode === '101020100') return { data: [{ _id: 'sunset', sampleCount: 30, hitCount: 28 }, { _id: 'fireCloud', sampleCount: 1, hitCount: 1 }] }
      return { data: [] }
    }
  }
  const db = {
    command: {
      gte(value) { return { gte: value, and(other) { return { gte: value, and: other } } } },
      lte(value) { return { lte: value } },
      gt(value) { return { gt: value } },
      neq(value) { return { neq: value } },
      and(...conditions) { return { and: conditions } },
      in(value) { return { in: value } },
      aggregate: {
        first(value) { return { first: value } },
        sum(value) { return { sum: value } }
      }
    },
    serverDate() { return 'server-date' },
    collection(name) {
      if (name === 'skyObservations') {
        return {
          aggregate() { return Object.create(aggregate) }
        }
      }
      if (name === 'accuracyCityRegistry') {
        return {
          where(query) {
            registryQueries.push(query)
            return {
              orderBy() { return this },
              limit() { return this },
              async get() { return { data: registryPage } }
            }
          }
        }
      }
      return {
        doc(id) {
          return { async set({ data }) { writes.push({ id, data }) } }
        }
      }
    }
  }

  try {
    const { aggregateAllActiveCities } = require('../index')
    const result = await aggregateAllActiveCities(db, now)
    assert.equal(result.cityCount, 2)
    assert.equal(writes.length, 6)
    assert.equal(writes.find((item) => item.data.cityCode === '101010100' && item.data.sceneType === 'sunrise').data.accuracyRate, 29 / 30)
    assert.equal(aggregateCalls.length, 2)
    assert.deepEqual(registryQueries, [{ cityCode: { gt: '' } }])
    assert.deepEqual(aggregateCalls.map((call) => call.matchValues.find((value) => typeof value.cityCode === 'string').cityCode), ['101010100', '101020100'])
    assert.ok(aggregateCalls.every((call) => call.matchValues.some((value) => value.observedAt)))
  } finally {
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})

test('does not infer legacy cities outside the registry or write their stats', async () => {
  const originalLoad = Module._load
  const indexPath = require.resolve('../index')
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database() { return {} } }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[indexPath]
  let aggregateCalled = false

  try {
    const { aggregateAllActiveCities } = require('../index')
    const result = await aggregateAllActiveCities({
      command: { gt(value) { return { gt: value } } },
      collection(name) {
        if (name === 'accuracyCityRegistry') {
          return {
            where() {
              return { orderBy() { return this }, limit() { return this }, async get() { return { data: [] } } }
            }
          }
        }
        if (name === 'skyObservations') return { aggregate() { aggregateCalled = true; throw new Error('legacy observations must not be scanned') } }
        throw new Error(`unexpected collection ${name}`)
      }
    }, Date.parse('2026-08-27T02:20:00+08:00'))

    assert.deepEqual(result, { ok: true, cityCount: 0, cities: [] })
    assert.equal(aggregateCalled, false)
  } finally {
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})
