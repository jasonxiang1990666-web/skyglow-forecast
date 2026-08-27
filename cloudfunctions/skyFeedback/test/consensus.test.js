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

function fakeDatabase(initialRows, authoritativeForecast = forecastRecord, options = {}) {
  const feedback = new Map(initialRows.map((item) => [item._id, { ...item }]))
  const observations = new Map(Object.entries(options.observations || {}))
  const accuracyCityRegistry = new Map(Object.entries(options.accuracyCityRegistry || {}))
  let nextFeedbackId = 1

  function matches(item, query) {
    return Object.entries(query).every(([key, value]) => {
      if (value && value.operation === 'gte') return item[key] >= value.operand
      return item[key] === value
    })
  }

  function replaceMap(target, source) {
    target.clear()
    for (const [key, value] of source) target.set(key, value)
  }

  function collection(name, feedbackState, observationState, registryState) {
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
          const state = { offset: 0, maximum: Infinity, orderField: '', orderDirection: 'asc' }
          const chain = {
            orderBy(field, direction) {
              state.orderField = field
              state.orderDirection = direction
              return chain
            },
            skip(offset) {
              state.offset = offset
              return chain
            },
            limit(maximum) {
              state.maximum = maximum
              return chain
            },
            async get() {
              let data = [...feedbackState.values()].filter((item) => matches(item, query))
              if (state.orderField) {
                data.sort((left, right) => String(left[state.orderField]).localeCompare(String(right[state.orderField])))
                if (state.orderDirection === 'desc') data.reverse()
              }
              return { data: data.slice(state.offset, state.offset + state.maximum) }
            }
          }
          return chain
        },
        async add({ data }) {
          const id = `submitted-${nextFeedbackId}`
          nextFeedbackId += 1
          feedbackState.set(id, { _id: id, ...data })
          return { _id: id }
        },
        doc(id) {
          return {
            async get() {
              return { data: feedbackState.has(id) ? { ...feedbackState.get(id) } : null }
            },
            async update({ data }) {
              feedbackState.set(id, { ...feedbackState.get(id), ...data })
            }
          }
        }
      }
    }
    if (name === 'skyObservations') {
      return {
        doc(id) {
          return {
            async get() {
              if (options.observationGetError) throw options.observationGetError
              if (!observationState.has(id)) {
                throw new Error(`document.get:fail document with _id ${id} does not exist`)
              }
              return { data: { ...observationState.get(id) } }
            },
            async set({ data }) {
              if (options.failObservationSet) throw new Error('injected observation failure')
              observationState.set(id, { ...data })
            }
          }
        }
      }
    }
    if (name === 'accuracyCityRegistry') {
      return {
        doc(id) {
          return {
            async set({ data }) {
              registryState.set(id, { ...data })
            }
          }
        }
      }
    }
    throw new Error(`Unexpected collection: ${name}`)
  }

  const database = {
    feedback,
    observations,
    accuracyCityRegistry,
    command: {
      gte(operand) {
        return { operation: 'gte', operand }
      }
    },
    serverDate() {
      return 'SERVER_DATE'
    },
    collection(name) {
      return collection(name, feedback, observations, accuracyCityRegistry)
    },
    async runTransaction(updateFunction) {
      const transactionFeedback = new Map([...feedback].map(([id, item]) => [id, { ...item }]))
      const transactionObservations = new Map([...observations].map(([id, item]) => [id, { ...item }]))
      const transactionRegistry = new Map([...accuracyCityRegistry].map(([id, item]) => [id, { ...item }]))
      const transaction = {
        collection(name) {
          return collection(name, transactionFeedback, transactionObservations, transactionRegistry)
        }
      }
      const result = await updateFunction(transaction)
      replaceMap(feedback, transactionFeedback)
      replaceMap(observations, transactionObservations)
      replaceMap(accuracyCityRegistry, transactionRegistry)
      return result
    }
  }
  return database
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

test('promotion atomically registers the observation city for accuracy aggregation', async () => {
  const db = fakeDatabase([
    row('a', 'u1'),
    row('b', 'u2'),
    row('c', 'u3')
  ])

  await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })

  assert.equal(db.accuracyCityRegistry?.get(forecastRecord.cityCode)?.cityCode, forecastRecord.cityCode)
  assert.equal(db.accuracyCityRegistry?.get(forecastRecord.cityCode)?.lastObservedAt, forecastRecord.windowEnd)
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

test('a stale concurrent candidate snapshot never shrinks committed observation contributors', async () => {
  const observationId = `${forecastRecord.forecastId}|${forecastRecord.sceneType}`
  const db = fakeDatabase(
    [row('a', 'u1'), row('b', 'u2'), row('c', 'u3')],
    forecastRecord,
    {
      observations: {
        [observationId]: {
          forecastId: forecastRecord.forecastId,
          sceneType: forecastRecord.sceneType,
          sourceFeedbackIds: ['a', 'b', 'c', 'd'],
          observedLevel: 2,
          seenLevel: 2,
          colorIntensity: 2,
          observationStatus: 'observed'
        }
      }
    }
  )

  await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })

  assert.deepEqual(db.observations.get(observationId).sourceFeedbackIds, ['a', 'b', 'c', 'd'])
})

test('an observation write failure rolls back every feedback approval', async () => {
  const db = fakeDatabase(
    [row('a', 'u1'), row('b', 'u2'), row('c', 'u3')],
    forecastRecord,
    { failObservationSet: true }
  )

  await assert.rejects(
    promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord }),
    /injected observation failure/
  )

  assert.equal([...db.feedback.values()].every((item) => item.reviewStatus === 'provisional'), true)
  assert.equal(db.observations.size, 0)
  assert.equal(db.accuracyCityRegistry.size, 0)
})

test('candidate discovery paginates past fifty noisy rows to later valid voters', async () => {
  const noisy = Array.from({ length: 55 }, (_, index) => row(
    `noise-${String(index).padStart(2, '0')}`,
    `noise-user-${index}`,
    { reviewStatus: 'auto_approved', seenLevel: null, colorIntensity: null }
  ))
  const db = fakeDatabase([...noisy, row('valid-a', 'u1'), row('valid-b', 'u2'), row('valid-c', 'u3')])

  const result = await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })

  assert.equal(result.promoted, true)
  assert.deepEqual(result.feedbackIds, ['valid-a', 'valid-b', 'valid-c'])
  assert.equal(db.observations.size, 1)
})

test('first-ever consensus creates an observation when missing document reads throw by default', async () => {
  const db = fakeDatabase([row('a', 'u1'), row('b', 'u2'), row('c', 'u3')])

  const result = await promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord })

  assert.equal(result.promoted, true)
  assert.equal(db.observations.size, 1)
  assert.deepEqual(result.feedbackIds, ['a', 'b', 'c'])
})

test('non-not-found observation read errors still abort promotion and preserve provisional feedback', async () => {
  const db = fakeDatabase(
    [row('a', 'u1'), row('b', 'u2'), row('c', 'u3')],
    forecastRecord,
    { observationGetError: new Error('document.get:fail permission denied') }
  )

  await assert.rejects(
    promoteConsensusBatch({ db, eventKey: forecastRecord.forecastId, forecastRecord }),
    /permission denied/
  )
  assert.equal([...db.feedback.values()].every((item) => item.reviewStatus === 'provisional'), true)
  assert.equal(db.observations.size, 0)
})
