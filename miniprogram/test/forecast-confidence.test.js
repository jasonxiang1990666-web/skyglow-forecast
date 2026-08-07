const test = require('node:test')
const assert = require('node:assert/strict')
const { confidencePresentation } = require('../utils/forecast-confidence')

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
