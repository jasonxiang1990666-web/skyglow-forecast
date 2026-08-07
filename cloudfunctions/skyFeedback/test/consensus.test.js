const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildConsensus,
  promotableFeedbackIds,
  promoteConsensusBatch
} = require('../consensus')

const forecastRecord = {
  forecastId: '101020100|sunset|2026-08-07|1786100000000|2.0',
  cityCode: '101020100',
  cityName: '上海',
  districtName: '黄浦区',
  locationGrid: '31.23,121.47',
  sceneType: 'sunset',
  observationDate: '2026-08-07',
  windowStart: 1786100000000,
  windowEnd: 1786103600000,
  score: 82,
  probability: 68,
  algorithmVersion: '2.0'
}

function row(id, user, overrides = {}) {
  return {
    _id: id,
    eventKey: forecastRecord.forecastId,
    forecastId: forecastRecord.forecastId,
    sceneType: forecastRecord.sceneType,
    windowStart: forecastRecord.windowStart,
    windowEnd: forecastRecord.windowEnd,
    anonymousUserHash: user,
    reviewStatus: 'provisional',
    reviewScore: 80,
    seenLevel: 2,
    colorIntensity: 2,
    ...overrides
  }
}

function fakeDatabase(initialRows, authoritativeForecast = forecastRecord) {
  const feedback = new Map(initialRows.map((item) => [item._id, { ...item }]))
  const observations = new Map()
  let nextFeedbackId = 1

  function matches(item, query) {
    return Object.entries(query).every(([key, value]) => item[key] === value)
  }

  return {
    feedback,
    observations,
    serverDate() {
      return 'SERVER_DATE'
    },
    collection(name) {
      if (name === 'forecastRecords') {
        return {
          doc(id) {
            return {
              async get() {
                return { data: id === authoritativeForecast.forecastId ? { ...authoritativeForecast } : null }
              }
            }
          }
        }
      }
      if (name === 'skyFeedback') {
        return {
          where(query) {
            return {
              limit(maximum) {
                return {
                  async get() {
                    return {
                      data: [...feedback.values()].filter((item) => matches(item, query)).slice(0, maximum)
                    }
                  }
                }
              }
            }
          },
          async add({ data }) {
            const id = `submitted-${nextFeedbackId}`
            nextFeedbackId += 1
            feedback.set(id, { _id: id, ...data })
            return { _id: id }
          },
          doc(id) {
            return {
              async update({ data }) {
                feedback.set(id, { ...feedback.get(id), ...data })
              }
            }
          }
        }
      }
      if (name === 'skyObservations') {
        return {
          doc(id) {
            return {
              async set({ data }) {
                observations.set(id, { ...data })
              }
            }
          }
        }
      }
      throw new Error(`Unexpected collection: ${name}`)
    }
  }
}

test('three high-trust provisional users can form first consensus', () => {
  const rows = [
    row('a', 'u1', { reviewScore: 82, seenLevel: 2 }),
    row('b', 'u2', { reviewScore: 80, seenLevel: 2 }),
    row('c', 'u3', { reviewScore: 85, seenLevel: 3, colorIntensity: 3 })
  ]

  assert.deepEqual(promotableFeedbackIds(rows).sort(), ['a', 'b', 'c'])
})

test('approved rows can seed consensus while low-trust, rejected, and duplicate-user rows cannot vote', () => {
  const rows = [
    row('approved', 'u1', { reviewStatus: 'auto_approved', reviewScore: 20 }),
    row('duplicate', 'u1', { seenLevel: 0, colorIntensity: 0, reviewScore: 99 }),
    row('second', 'u2'),
    row('third', 'u3', { seenLevel: 3, colorIntensity: 3 }),
    row('low', 'u4', { reviewScore: 74 }),
    row('rejected', 'u5', { reviewStatus: 'rejected', reviewScore: 100 })
  ]

  assert.deepEqual(promotableFeedbackIds(rows).sort(), ['approved', 'second', 'third'])
})

test('insufficient, contradictory, or differently scoped feedback remains provisional', () => {
  assert.equal(buildConsensus([row('a', 'u1'), row('b', 'u2')]).status, 'provisional')
  assert.equal(buildConsensus([
    row('a', 'u1', { seenLevel: 1, colorIntensity: 1 }),
    row('b', 'u2', { seenLevel: 2, colorIntensity: 2 }),
    row('c', 'u3', { seenLevel: 3, colorIntensity: 3 })
  ]).status, 'provisional')
  assert.equal(buildConsensus([
    row('a', 'u1'),
    row('b', 'u2'),
    row('c', 'u3', { forecastId: 'different-forecast', eventKey: 'different-forecast' })
  ]).status, 'provisional')
})

test('consensus derives a deterministic status and level independent of input order', () => {
  const rows = [
    row('a', 'u1', { seenLevel: 2, colorIntensity: 1 }),
    row('b', 'u2', { seenLevel: 3, colorIntensity: 2 }),
    row('c', 'u3', { seenLevel: 2, colorIntensity: 2 })
  ]

  const forward = buildConsensus(rows)
  const reverse = buildConsensus([...rows].reverse())
  assert.equal(forward.status, 'auto_approved')
  assert.equal(forward.observationStatus, 'observed')
  assert.equal(forward.observedLevel, 2)
  assert.equal(forward.seenLevel, 2)
  assert.equal(forward.colorIntensity, 2)
  assert.deepEqual(reverse, forward)
})

test('promotion is idempotent per forecast scene and trusts only the authoritative forecast snapshot', async () => {
  const db = fakeDatabase([
    row('a', 'u1', { seenLevel: 2, colorIntensity: 1, score: 1, probability: 2 }),
    row('b', 'u2', { seenLevel: 2, colorIntensity: 2, score: 3, probability: 4 }),
    row('c', 'u3', { seenLevel: 3, colorIntensity: 2, score: 5, probability: 6 })
  ])

  const first = await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })
  const second = await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })

  assert.equal(first.promoted, true)
  assert.equal(second.promoted, true)
  assert.equal(db.observations.size, 1)
  assert.deepEqual([...db.feedback.values()].map((item) => item.reviewStatus), [
    'auto_approved',
    'auto_approved',
    'auto_approved'
  ])
  const observation = [...db.observations.values()][0]
  assert.equal(observation.forecastId, forecastRecord.forecastId)
  assert.equal(observation.sceneType, 'sunset')
  assert.equal(observation.observedLevel, 2)
  assert.equal(observation.observationStatus, 'observed')
  assert.equal(observation.forecastScore, 82)
  assert.equal(observation.forecastProbability, 68)
  assert.deepEqual(observation.sourceFeedbackIds, ['a', 'b', 'c'])
  assert.equal(observation.anonymousUserHash, undefined)
  assert.equal(observation.note, undefined)
})

test('promotion writes nothing when authoritative scope has no consensus', async () => {
  const db = fakeDatabase([
    row('a', 'u1', { seenLevel: 1, colorIntensity: 1 }),
    row('b', 'u2', { seenLevel: 2, colorIntensity: 2 }),
    row('c', 'u3', { seenLevel: 3, colorIntensity: 3 }),
    row('other', 'u4', { forecastId: 'different-forecast', eventKey: forecastRecord.forecastId })
  ])

  const result = await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })

  assert.equal(result.promoted, false)
  assert.equal(result.status, 'provisional')
  assert.equal(db.observations.size, 0)
  assert.equal([...db.feedback.values()].every((item) => item.reviewStatus === 'provisional'), true)
})

test('the third valid submission triggers consensus without a manual review action', async () => {
  const Module = require('node:module')
  const db = fakeDatabase([row('a', 'u1'), row('b', 'u2')])
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() {
      return db
    },
    getWXContext() {
      return { OPENID: 'third-user-openid' }
    }
  }
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    return request === 'wx-server-sdk' ? fakeCloud : originalLoad.call(this, request, parent, isMain)
  }
  const indexPath = require.resolve('../index')
  delete require.cache[indexPath]
  const originalNow = Date.now
  Date.now = () => forecastRecord.windowStart + 1000

  try {
    const { main } = require('../index')
    const result = await main({
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

    assert.equal(result.status, 'auto_approved')
    assert.equal(db.observations.size, 1)
    assert.equal([...db.feedback.values()].every((item) => item.reviewStatus === 'auto_approved'), true)
  } finally {
    Date.now = originalNow
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})
