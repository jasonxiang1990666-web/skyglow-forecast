const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const { validateFeedback, validateForecastBinding, consensusSeenLevel, assessLocationGrid, evaluateSubmission } = require('./review')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function hashOpenId(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32)
}

async function getForecastRecord(forecastId) {
  try {
    const result = await db.collection('forecastRecords').doc(forecastId).get()
    return result && result.data ? result.data : null
  } catch (error) {
    return null
  }
}

async function getConsensus(eventKey) {
  const result = await db.collection('skyFeedback').where({
    eventKey,
    reviewStatus: 'auto_approved'
  }).limit(50).get()
  const levels = result.data
    .map(consensusSeenLevel)
    .filter((item) => item !== null)
  if (!levels.length) return { count: 0, average: null }
  return {
    count: levels.length,
    average: levels.reduce((sum, item) => sum + item, 0) / levels.length
  }
}

function round(value) {
  return Math.round(value * 100) / 100
}

async function submit(event, openid) {
  const input = validateFeedback(event)
  const forecastRecord = await getForecastRecord(input.forecastId)
  validateForecastBinding({ feedback: input, forecastRecord, now: Date.now() })

  const anonymousUserHash = hashOpenId(openid)
  const eventKey = forecastRecord.forecastId
  const duplicate = await db.collection('skyFeedback').where({ forecastId: eventKey, anonymousUserHash }).limit(1).get()
  if (duplicate.data.length) {
    return { ok: false, duplicate: true, status: duplicate.data[0].reviewStatus, message: '你已提交过本次霞况反馈' }
  }

  const consensus = await getConsensus(eventKey)
  const consensusDelta = consensus.average === null ? null : Math.abs(input.seenLevel - consensus.average)
  const locationReview = assessLocationGrid(input.locationGrid, forecastRecord.locationGrid)
  const review = evaluateSubmission({
    inWindow: true,
    locationScore: locationReview.score,
    locationReason: locationReview.reason,
    frequencyScore: 1,
    completenessScore: input.legacyNormalized ? 0.75 : 1,
    consensusDelta,
    consensusCount: consensus.count
  })
  const serverDate = db.serverDate()
  const data = {
    eventKey,
    forecastId: forecastRecord.forecastId,
    cityCode: forecastRecord.cityCode,
    cityName: forecastRecord.cityName || '',
    districtName: forecastRecord.districtName || '',
    sceneType: forecastRecord.sceneType,
    windowStart: forecastRecord.windowStart,
    windowEnd: forecastRecord.windowEnd,
    seenLevel: input.seenLevel,
    colorIntensity: input.colorIntensity,
    cloudCondition: input.cloudCondition,
    visibilityLevel: input.visibilityLevel,
    tags: input.tags,
    note: input.note,
    locationGrid: input.locationGrid,
    source: 'user-feedback',
    anonymousUserHash,
    reviewStatus: review.reviewStatus,
    reviewScore: review.reviewScore,
    reviewReasons: review.reviewReasons,
    schemaVersion: review.schemaVersion,
    consensusCount: consensus.count,
    consensusAverage: consensus.average === null ? null : round(consensus.average),
    modelVersion: 'feedback-ai-v2',
    legacyNormalized: input.legacyNormalized,
    submittedAt: serverDate,
    reviewedAt: serverDate
  }
  const writeResult = await db.collection('skyFeedback').add({ data })
  return {
    ok: true,
    id: writeResult._id,
    status: review.reviewStatus,
    reviewScore: review.reviewScore,
    message: review.reviewStatus === 'auto_approved'
      ? '感谢反馈，AI核验通过。'
      : review.reviewStatus === 'rejected'
        ? '感谢反馈，已收到并将暂不用于模型校准。'
        : '感谢反馈，样本积累中，AI会在形成共识后再用于校准。'
  }
}

exports.main = async (event = {}) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) throw new Error('无法识别微信用户')
  if ((event.action || 'submit') !== 'submit') throw new Error('不支持的反馈操作')
  return submit(event, openid)
}
