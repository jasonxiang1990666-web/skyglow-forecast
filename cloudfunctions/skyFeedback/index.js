const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ALLOWED_TYPES = new Set(['朝霞', '晚霞'])
const ALLOWED_TAGS = new Set(['云层较厚', '光照被遮挡', '正在下雨', '视野开阔', '视野受建筑遮挡'])

function text(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength)
}

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function hashOpenId(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32)
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map((item) => text(item, 20)).filter((item) => ALLOWED_TAGS.has(item)))].slice(0, 5)
}

function validateInput(event) {
  const city = text(event.city, 30)
  const type = text(event.type, 10)
  const targetAt = number(event.targetAt)
  const startAt = number(event.startAt)
  const endAt = number(event.endAt)
  const observedScore = number(event.observedScore == null ? event.score : event.observedScore)
  if (!city) throw new Error('缺少城市')
  if (!ALLOWED_TYPES.has(type)) throw new Error('只支持朝霞或晚霞反馈')
  if (!targetAt || !startAt || !endAt || endAt <= startAt) throw new Error('观赏时段无效')
  if (observedScore === null || observedScore < 0 || observedScore > 4) throw new Error('请选择0到4分的观赏结果')
  return {
    city,
    type,
    targetAt: Math.round(targetAt),
    startAt: Math.round(startAt),
    endAt: Math.round(endAt),
    observedScore,
    tags: normalizeTags(event.tags),
    note: text(event.note, 120),
    latitude: number(event.latitude),
    longitude: number(event.longitude)
  }
}

function locationScore(input) {
  if (input.latitude === null || input.longitude === null) return 0.55
  if (input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180) return 0
  return 1
}

async function getConsensus(eventKey) {
  const result = await db.collection('skyFeedback').where({
    eventKey,
    reviewStatus: 'auto_approved'
  }).limit(50).get()
  const scores = result.data.map((item) => Number(item.observedScore)).filter((item) => Number.isFinite(item))
  if (!scores.length) return { count: 0, average: null, delta: null }
  const average = scores.reduce((sum, item) => sum + item, 0) / scores.length
  return { count: scores.length, average, delta: null }
}

function round(value) {
  return Math.round(value * 100) / 100
}

async function submit(event, openid) {
  const input = validateInput(event)
  const now = Date.now()
  // 与页面保持一致：只在建议观赏时段内接受反馈。
  if (now < input.startAt || now > input.endAt) {
    throw new Error('当前不在本次霞况反馈时段内')
  }

  const openidHash = hashOpenId(openid)
  const eventKey = `${input.city}|${input.type}|${input.targetAt}`
  const duplicate = await db.collection('skyFeedback').where({ eventKey, openidHash }).limit(1).get()
  if (duplicate.data.length) {
    return { ok: false, duplicate: true, status: duplicate.data[0].reviewStatus, message: '你已提交过本次霞况反馈' }
  }

  const consensus = await getConsensus(eventKey)
  const delta = consensus.average === null ? null : Math.abs(input.observedScore - consensus.average)
  consensus.delta = delta
  const timeComponent = 1
  const locationComponent = locationScore(input)
  const consensusComponent = consensus.average === null ? 0.5 : (delta <= 1 ? 1 : delta <= 2 ? 0.6 : 0.2)
  const completenessComponent = input.tags.length || input.note ? 1 : 0.75
  const trustScore = Math.round((timeComponent * 0.35 + locationComponent * 0.25 + consensusComponent * 0.25 + completenessComponent * 0.15) * 100)
  let reviewStatus = 'provisional'
  if (trustScore < 45) reviewStatus = 'rejected'
  else if (consensus.count >= 2 && delta !== null && delta <= 1 && trustScore >= 75) reviewStatus = 'auto_approved'

  const reviewReasons = [
    '提交时间在允许反馈窗口内',
    locationComponent >= 1 ? '已提供有效定位网格' : '未提供定位，仅降低可信度',
    consensus.count ? `同一时段已有${consensus.count}条AI通过样本` : '同一时段暂未形成多人共识',
    input.tags.length || input.note ? '反馈包含补充信息' : '反馈缺少补充信息'
  ]
  const locationGrid = locationComponent >= 1
    ? `${input.latitude.toFixed(2)},${input.longitude.toFixed(2)}`
    : ''
  const data = {
    eventKey,
    city: input.city,
    type: input.type,
    targetAt: input.targetAt,
    startAt: input.startAt,
    endAt: input.endAt,
    observedScore: input.observedScore,
    tags: input.tags,
    note: input.note,
    locationGrid,
    source: 'user-feedback',
    openidHash,
    reviewStatus,
    trustScore,
    reviewReasons,
    consensusCount: consensus.count,
    consensusAverage: consensus.average === null ? null : round(consensus.average),
    modelVersion: 'feedback-ai-v1',
    submittedAt: db.serverDate(),
    reviewedAt: db.serverDate()
  }
  const writeResult = await db.collection('skyFeedback').add({ data })
  return {
    ok: true,
    id: writeResult._id,
    status: reviewStatus,
    trustScore,
    message: reviewStatus === 'auto_approved'
      ? '感谢反馈，AI核验通过。'
      : reviewStatus === 'rejected'
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
