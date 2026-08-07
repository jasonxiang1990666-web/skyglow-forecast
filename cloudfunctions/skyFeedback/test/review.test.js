const test = require('node:test')
const assert = require('node:assert/strict')
const {
  validateFeedback,
  validateForecastBinding,
  buildLocationGrid,
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
