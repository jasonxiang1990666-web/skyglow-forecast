const MIN_CALIBRATION_SAMPLES = 30
const MAX_OBSERVATIONS = 1000

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function scoreBin(score) {
  const value = finite(score)
  if (value === null) return null
  return Math.max(0, Math.min(4, Math.floor(Math.max(0, Math.min(100, value)) / 20)))
}

function normalizeType(value) {
  const type = String(value || '').trim()
  if (type === '火烧云') return '火烧云'
  if (type === '朝霞') return '朝霞'
  if (type === '晚霞') return '晚霞'
  return ''
}

function observationOutcome(item) {
  const observed = finite(item.observedScore ?? item.quality ?? item.rating ?? item.outcome)
  if (observed === null) return null
  // 0-4 级观测：3 级及以上视为“值得观赏”。
  if (observed <= 4) return observed >= 3 ? 1 : 0
  return observed >= 70 ? 1 : 0
}

function emptyProfile(city, reason = '暂无足够的上海历史观测记录') {
  return {
    city,
    source: 'skyObservations',
    status: 'pending',
    sampleCount: 0,
    minimumSamples: MIN_CALIBRATION_SAMPLES,
    bins: {},
    reason
  }
}

function buildProfile(city, observations) {
  const buckets = {}
  observations.forEach((item) => {
    const type = normalizeType(item.type || item.scene)
    const bin = scoreBin(item.score)
    const outcome = observationOutcome(item)
    if (!type || bin === null || outcome === null) return
    const key = `${type}:${bin}`
    if (!buckets[key]) buckets[key] = { type, bin, samples: 0, successes: 0 }
    buckets[key].samples += 1
    buckets[key].successes += outcome
  })

  const sampleCount = Object.values(buckets).reduce((sum, item) => sum + item.samples, 0)
  const bins = Object.values(buckets).reduce((result, item) => {
    const prior = item.type === '火烧云' ? 0.25 : 0.55
    // Beta(1,1) 平滑，避免小样本直接产生 0% 或 100%。
    const rate = (item.successes + prior) / (item.samples + 1)
    result[`${item.type}:${item.bin}`] = {
      samples: item.samples,
      successes: item.successes,
      rate: Math.round(rate * 1000) / 10
    }
    return result
  }, {})

  return {
    city,
    source: 'skyObservations',
    status: sampleCount >= MIN_CALIBRATION_SAMPLES ? 'calibrated' : 'pending',
    sampleCount,
    minimumSamples: MIN_CALIBRATION_SAMPLES,
    bins,
    reason: sampleCount >= MIN_CALIBRATION_SAMPLES
      ? '基于上海历史观测记录进行概率校准'
      : `上海历史观测记录不足 ${MIN_CALIBRATION_SAMPLES} 条，暂不宣称为统计概率`
  }
}

function applyCalibration(rawProbability, score, type, profile) {
  const fallback = {
    probability: rawProbability,
    status: 'pending',
    label: '模型估算概率（待校准）',
    sampleCount: profile ? profile.sampleCount : 0,
    source: profile ? profile.source : 'skyObservations'
  }
  if (!profile || profile.status !== 'calibrated') return fallback
  const bin = scoreBin(score)
  const bucket = bin === null ? null : profile.bins[`${type}:${bin}`]
  if (!bucket || bucket.samples < 5) return fallback
  return {
    probability: Math.round(Math.max(5, Math.min(95, bucket.rate))),
    status: 'calibrated',
    label: '上海历史校准概率',
    sampleCount: profile.sampleCount,
    source: profile.source
  }
}

async function getCalibrationProfile(db, city) {
  try {
    const result = await db.collection('skyObservations').where({ city }).limit(MAX_OBSERVATIONS).get()
    return buildProfile(city, result.data || [])
  } catch (error) {
    // 集合尚未创建或暂无权限时不影响主预报。
    return emptyProfile(city, '上海历史观测集合尚未配置，当前仅显示模型估算概率')
  }
}

module.exports = { getCalibrationProfile, applyCalibration, buildProfile }
