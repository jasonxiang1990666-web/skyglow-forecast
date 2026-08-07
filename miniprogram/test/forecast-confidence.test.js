const test = require('node:test')
const assert = require('node:assert/strict')
const { confidencePresentation, confidenceDetails } = require('../utils/forecast-confidence')

test('presents high confidence with the consistent-model summary', () => {
  assert.deepEqual(confidencePresentation({ level: 'high', modelAgreement: 'consistent' }), {
    label: '高可信度',
    tone: 'high',
    summary: 'EC/GFS 较一致'
  })
})

test('presents medium confidence with the model-difference summary', () => {
  assert.deepEqual(confidencePresentation({ level: 'medium', modelAgreement: 'different' }), {
    label: '中可信度',
    tone: 'medium',
    summary: 'EC/GFS 存在差异'
  })
})

test('presents low confidence with the model-conflict summary', () => {
  assert.deepEqual(confidencePresentation({ level: 'low', modelAgreement: 'conflict' }), {
    label: '低可信度',
    tone: 'low',
    summary: 'EC/GFS 分歧较大'
  })
})

test('uses a safe fallback when confidence data is unavailable', () => {
  assert.deepEqual(confidencePresentation(null), {
    label: '可信度待同步',
    tone: 'pending',
    summary: '模型数据待同步'
  })
})

test('normalizes detail confidence with update time and no more than three reasons', () => {
  assert.deepEqual(confidenceDetails({
    level: 'high',
    modelAgreement: 'consistent',
    weatherUpdatedAt: 1786062000000,
    reasons: ['数据新鲜', '关键字段完整', 'EC/GFS 较一致', '不应显示']
  }, { forecastId: '101020100|sunset|2026-08-07|1786100000000|2.0' }), {
    available: true,
    label: '高可信度',
    tone: 'high',
    updatedAt: '2026-08-07 08:20',
    modelAgreement: 'EC/GFS 较一致',
    reasons: ['数据新鲜', '关键字段完整', 'EC/GFS 较一致']
  })
})

test('uses a safe detail fallback for legacy records without forecast identity', () => {
  assert.deepEqual(confidenceDetails({ level: 'high', modelAgreement: 'consistent' }, {}), {
    available: false,
    message: '当前仅提供基础霞况预报'
  })
})

test('uses a safe detail fallback when model data is unavailable or reasons are malformed', () => {
  assert.deepEqual(confidenceDetails({
    level: 'low',
    modelAgreement: 'unavailable',
    reasons: '模型暂不可用'
  }, { forecastId: '101020100|sunset|2026-08-07|1786100000000|2.0' }), {
    available: false,
    message: '当前仅提供基础霞况预报'
  })
})
