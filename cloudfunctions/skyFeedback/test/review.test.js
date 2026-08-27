const test = require('node:test')
const assert = require('node:assert/strict')
const {
  validateFeedback,
  validateForecastBinding,
  buildLocationGrid,
  consensusSeenLevel,
  assessLocationGrid,
  assessSubmissionFrequency,
  feedbackDocumentId,
  insertFeedbackOnce,
  evaluateSubmission,
  normalizeObservations
} = require('../review')

const validInput = {
  forecastId: '101020100|sunset|2026-08-07|1786100000000|2.0',
  cityCode: '101020100',
  sceneType: 'sunset',
  windowStart: 1786100000000,
  windowEnd: 1786103600000,
  seenLevel: 2,
  colorIntensity: 3,
  cloudCondition: 'layered',
  visibilityLevel: 'good',
  tags: ['视野开阔'],
  note: '晚霞层次清楚',
  latitude: 31.2304,
  longitude: 121.4737
}

const forecastRecord = {
  forecastId: validInput.forecastId,
  cityCode: '101020100',
  cityName: '上海',
  districtName: '黄浦区',
  sceneType: 'sunset',
  observationDate: '2026-08-07',
  windowStart: 1786100000000,
  windowEnd: 1786103600000,
  score: 82,
  probability: 68,
  locationGrid: '31.23,121.47',
  algorithmVersion: '2.0'
}

test('requires a forecast id and every nationwide forecast binding field', () => {
  for (const field of ['forecastId', 'cityCode', 'sceneType', 'windowStart', 'windowEnd']) {
    assert.throws(() => validateFeedback({ ...validInput, [field]: undefined }), /预报|城市|霞况|时段/)
  }
})

test('rejects invalid structured observation values', () => {
  const invalidCases = [
    ['seenLevel', 4],
    ['seenLevel', 1.5],
    ['colorIntensity', -1],
    ['cloudCondition', 'storm'],
    ['visibilityLevel', 'perfect']
  ]
  for (const [field, value] of invalidCases) {
    assert.throws(() => validateFeedback({ ...validInput, [field]: value }), /反馈|霞色|云层|能见度/)
  }
})

test('normalizes note, tags, and location without retaining exact coordinates', () => {
  const input = validateFeedback({
    ...validInput,
    tags: ['视野开阔', '视野开阔', '正在下雨', '建筑遮挡', '云层较厚', '光照被遮挡', '额外标签'],
    note: '霞'.repeat(80)
  })
  assert.equal(input.note.length, 60)
  assert.deepEqual(input.tags, ['视野开阔', '正在下雨', '建筑遮挡', '云层较厚', '光照被遮挡'])
  assert.equal(input.locationGrid, '31.23,121.47')
  assert.equal(input.latitude, undefined)
  assert.equal(input.longitude, undefined)
  assert.equal(buildLocationGrid(31.2304, 121.4737), '31.23,121.47')
})

test('missing or invalid coordinates lower trust but do not reject feedback', () => {
  const missing = validateFeedback({ ...validInput, latitude: undefined, longitude: undefined })
  const invalid = validateFeedback({ ...validInput, latitude: 100, longitude: 121 })
  assert.equal(missing.locationGrid, '')
  assert.equal(missing.locationScore, 0.55)
  assert.equal(invalid.locationGrid, '')
  assert.equal(invalid.locationScore, 0.55)
})

test('uses the authoritative record for identity and the submission window', () => {
  assert.deepEqual(
    validateForecastBinding({ feedback: validateFeedback(validInput), forecastRecord, now: 1786101800000 }),
    forecastRecord
  )
  assert.throws(
    () => validateForecastBinding({ feedback: validateFeedback({ ...validInput, cityCode: '101010100' }), forecastRecord, now: 1786101800000 }),
    /预报记录不匹配/
  )
  assert.throws(
    () => validateForecastBinding({ feedback: validateFeedback(validInput), forecastRecord, now: 1786103600001 }),
    /不在本次霞况反馈时段内/
  )
})

test('returns required AI review status fields and keeps no-consensus input provisional', () => {
  const result = evaluateSubmission({
    inWindow: true,
    locationScore: 1,
    frequencyScore: 1,
    completenessScore: 1,
    consensusDelta: null,
    consensusCount: 0
  })
  assert.equal(result.reviewStatus, 'provisional')
  assert.equal(result.status, 'provisional')
  assert.equal(Number.isInteger(result.reviewScore), true)
  assert.equal(Array.isArray(result.reviewReasons), true)
  assert.equal(result.schemaVersion, 2)
})

test('rejects submissions outside the authoritative window', () => {
  const result = evaluateSubmission({
    inWindow: false,
    locationScore: 1,
    frequencyScore: 1,
    completenessScore: 1,
    consensusDelta: null,
    consensusCount: 0
  })
  assert.equal(result.reviewStatus, 'rejected')
  assert.equal(result.reviewReasons.includes('outside_window'), true)
})

test('normalizes legacy observedScore into the new schema and uses only authoritative forecast scores', () => {
  const legacy = validateFeedback({
    ...validInput,
    seenLevel: undefined,
    colorIntensity: undefined,
    cloudCondition: undefined,
    visibilityLevel: undefined,
    observedScore: 4,
    score: 1,
    forecastScore: 3
  })
  assert.equal(legacy.seenLevel, 3)
  assert.equal(legacy.colorIntensity, 3)
  assert.equal(legacy.cloudCondition, 'few')
  assert.equal(legacy.visibilityLevel, 'good')
  assert.equal(legacy.observedScore, undefined)

  const observation = normalizeObservations({ feedback: { _id: 'feedback-1', ...legacy }, forecastRecord })
  assert.equal(observation.forecastScore, 82)
  assert.equal(observation.forecastProbability, 68)
  assert.equal(observation.clientScore, undefined)
  assert.equal(observation.districtName, '黄浦区')
  assert.equal(observation.locationGrid, '31.23,121.47')
})

test('does not invent a zero score when the authoritative forecast has no score', () => {
  const observation = normalizeObservations({
    feedback: { ...validateFeedback(validInput), reviewScore: null },
    forecastRecord: { ...forecastRecord, score: null, probability: '' }
  })
  assert.equal(observation.forecastScore, null)
  assert.equal(observation.forecastProbability, null)
  assert.equal(observation.reviewScore, null)
})

test('excludes malformed new and legacy values from consensus', () => {
  assert.equal(consensusSeenLevel({ seenLevel: 2 }), 2)
  assert.equal(consensusSeenLevel({ seenLevel: null, observedScore: 4 }), 3)
  assert.equal(consensusSeenLevel({ seenLevel: '', observedScore: 2 }), 1)
  for (const row of [
    { seenLevel: null },
    { seenLevel: '' },
    { seenLevel: 1.5, observedScore: 4 },
    { seenLevel: 4 },
    { seenLevel: '2' },
    { observedScore: null },
    { observedScore: '' },
    { observedScore: 1.5 },
    { observedScore: -1 },
    { observedScore: 5 },
    { observedScore: '4' }
  ]) {
    assert.equal(consensusSeenLevel(row), null)
  }
})

test('downgrades a far-away coarse grid but accepts an adjacent grid', () => {
  assert.deepEqual(assessLocationGrid('', forecastRecord.locationGrid), { score: 0.55, reason: 'location_unavailable' })
  const adjacent = assessLocationGrid('31.24,121.48', forecastRecord.locationGrid)
  assert.deepEqual(adjacent, { score: 1, reason: 'location_grid_matched' })

  const beijing = assessLocationGrid('39.90,116.40', forecastRecord.locationGrid)
  assert.deepEqual(beijing, { score: 0.2, reason: 'location_grid_mismatch' })
  const reviewed = evaluateSubmission({
    inWindow: true,
    locationScore: beijing.score,
    locationReason: beijing.reason,
    frequencyScore: 1,
    completenessScore: 1,
    consensusDelta: null,
    consensusCount: 0
  })
  assert.equal(reviewed.reviewReasons.includes('location_grid_mismatch'), true)
  assert.equal(reviewed.reviewScore < 75, true)
})

test('downgrades rapid submissions spanning four cities but ignores older activity', () => {
  const now = Date.UTC(2026, 7, 7, 12, 0, 0)
  const recentRows = [
    { cityCode: '101010100', submittedAt: new Date(now - 60 * 1000) },
    { cityCode: '101020100', submittedAt: new Date(now - 2 * 60 * 1000) },
    { cityCode: '101280101', submittedAt: new Date(now - 9 * 60 * 1000) }
  ]
  assert.deepEqual(
    assessSubmissionFrequency(recentRows, { cityCode: '101190101', now }),
    { score: 0.2, reason: 'cross_city_frequency_anomaly' }
  )
  assert.deepEqual(
    assessSubmissionFrequency([
      ...recentRows,
      { cityCode: '101190101', submittedAt: new Date(now - 11 * 60 * 1000) }
    ], { cityCode: '101190101', now: now + 10 * 60 * 1000 }),
    { score: 1, reason: 'frequency_normal' }
  )
})

test('downgrades conservatively when the recent-submission lookup is unavailable', () => {
  const now = Date.UTC(2026, 7, 7, 12, 0, 0)
  assert.deepEqual(
    assessSubmissionFrequency([], { cityCode: '101190101', now, lookupAvailable: false }),
    { score: 0.2, reason: 'frequency_lookup_unavailable' }
  )
})

test('atomically stores only one feedback row for the same user and forecast id', async () => {
  const rows = new Map()
  const db = {
    runTransaction: async (callback) => callback({
      collection: () => ({
        doc: (id) => ({
          get: async () => {
            if (!rows.has(id)) throw new Error(`document with _id ${id} does not exist`)
            return { data: rows.get(id) }
          },
          set: async ({ data }) => rows.set(id, { _id: id, ...data })
        })
      })
    })
  }
  const documentId = feedbackDocumentId(validInput.forecastId, 'anonymous-user-hash')
  assert.equal(documentId, feedbackDocumentId(validInput.forecastId, 'anonymous-user-hash'))
  assert.notEqual(documentId, feedbackDocumentId(validInput.forecastId, 'other-user-hash'))

  const first = await insertFeedbackOnce({ db, documentId, data: { forecastId: validInput.forecastId, reviewStatus: 'provisional' } })
  const duplicate = await insertFeedbackOnce({ db, documentId, data: { forecastId: validInput.forecastId, reviewStatus: 'rejected' } })

  assert.deepEqual(first, { created: true, id: documentId, data: rows.get(documentId) })
  assert.deepEqual(duplicate, { created: false, id: documentId, data: rows.get(documentId) })
  assert.equal(rows.size, 1)
  assert.equal(rows.get(documentId).reviewStatus, 'provisional')
})
