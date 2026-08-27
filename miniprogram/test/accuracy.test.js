const test = require('node:test')
const assert = require('node:assert/strict')
const { accuracyPresentation, accuracyCards, accuracyPageState } = require('../utils/accuracy')
const { getCityAccuracy } = require('../services/weather')

test('shows accumulation progress instead of a percentage before 30 samples', () => {
  assert.deepEqual(accuracyPresentation({ sampleCount: 29, accuracyRate: 0.99 }), {
    status: 'collecting',
    value: '已积累 29/30 条',
    detail: '样本积累到 30 条后显示准确率'
  })
})

test('shows a rounded percentage when 30 samples have a valid accuracy rate', () => {
  assert.deepEqual(accuracyPresentation({ sampleCount: 30, accuracyRate: 0.8 }), {
    status: 'ready',
    value: '80%',
    detail: '近 30 天历史命中率'
  })
})

test('uses a conservative accumulation state for missing or malformed metrics', () => {
  assert.deepEqual(accuracyPresentation({ sampleCount: '30', accuracyRate: '0.8' }), {
    status: 'collecting',
    value: '数据积累中',
    detail: '样本积累到 30 条后显示准确率'
  })
  assert.deepEqual(accuracyPresentation(null), {
    status: 'collecting',
    value: '数据积累中',
    detail: '样本积累到 30 条后显示准确率'
  })
})

test('creates separate sunrise, sunset, and fire-cloud cards without exposing probability', () => {
  assert.deepEqual(accuracyCards({
    sunrise: { sampleCount: 30, accuracyRate: 0.8 },
    sunset: { sampleCount: 29, accuracyRate: 0.9 },
    fireCloud: { sampleCount: 0, probability: 1 }
  }), [
    { key: 'sunrise', title: '朝霞', status: 'ready', value: '80%', detail: '近 30 天历史命中率' },
    { key: 'sunset', title: '晚霞', status: 'collecting', value: '已积累 29/30 条', detail: '样本积累到 30 条后显示准确率' },
    { key: 'fireCloud', title: '火烧云', status: 'collecting', value: '已积累 0/30 条', detail: '样本积累到 30 条后显示准确率' }
  ])
})

test('maps loading, collecting, ready, and error page states to distinct view states', () => {
  assert.equal(accuracyPageState({ loading: true }).status, 'loading')
  assert.equal(accuracyPageState({ loading: false, metrics: {} }).status, 'collecting')
  assert.equal(accuracyPageState({ loading: false, metrics: { sunrise: { sampleCount: 30, accuracyRate: 0.8 } } }).status, 'ready')
  assert.equal(accuracyPageState({ loading: false, error: new Error('unavailable') }).status, 'error')
})

test('requests this city\'s accuracy from the dedicated cloud function', async () => {
  const originalWx = global.wx
  const calls = []
  global.wx = {
    cloud: {
      callFunction(options) {
        calls.push(options)
        return Promise.resolve({ result: { cityCode: '101020100' } })
      }
    }
  }

  try {
    assert.deepEqual(await getCityAccuracy('101020100'), { cityCode: '101020100' })
    assert.deepEqual(calls, [{ name: 'cityAccuracy', data: { action: 'getCityAccuracy', cityCode: '101020100' } }])
  } finally {
    global.wx = originalWx
  }
})
