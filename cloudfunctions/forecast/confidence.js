const HOUR_MS = 60 * 60 * 1000

function evaluateForecastConfidence(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const weatherAgeHours = getWeatherAgeHours(now, input.weatherUpdatedAt)
  const freshness = getFreshness(weatherAgeHours)
  const completeness = getCompleteness(input.requiredWeatherFields)
  const ecStatus = getModelStatus(input.ec)
  const gfsStatus = getModelStatus(input.gfs)
  const modelAgreement = getModelAgreement(input.ec, input.gfs)
  const level = getLevel(freshness, completeness, modelAgreement)

  return {
    level,
    label: getLabel(level),
    reasons: getReasons(freshness, completeness, modelAgreement),
    freshness,
    completeness,
    modelAgreement,
    weatherAgeHours,
    ecStatus,
    gfsStatus
  }
}

function getWeatherAgeHours(now, weatherUpdatedAt) {
  if (!Number.isFinite(weatherUpdatedAt)) return null
  return Math.max(0, (now - weatherUpdatedAt) / HOUR_MS)
}

function getFreshness(weatherAgeHours) {
  if (weatherAgeHours === null || weatherAgeHours > 6) return 'stale'
  if (weatherAgeHours > 3) return 'normal'
  return 'fresh'
}

function getCompleteness(requiredWeatherFields) {
  if (!Array.isArray(requiredWeatherFields)) return 'partial'
  return requiredWeatherFields.every(value => value !== null && value !== undefined)
    ? 'complete'
    : 'partial'
}

function getModelStatus(model) {
  if (!model || typeof model !== 'object') return 'missing'
  return typeof model.status === 'string' ? model.status : 'missing'
}

function isReadyModel(model) {
  return Boolean(
    model &&
    model.status === 'ready' &&
    Number.isFinite(model.totalCloud) &&
    Number.isFinite(model.precipitation)
  )
}

function getModelAgreement(ec, gfs) {
  if (!isReadyModel(ec) || !isReadyModel(gfs)) return 'unavailable'

  const cloudDifference = Math.abs(ec.totalCloud - gfs.totalCloud)
  const precipitationConflict = (ec.precipitation > 0) !== (gfs.precipitation > 0)

  if (cloudDifference > 30 || precipitationConflict) return 'conflict'
  if (cloudDifference > 15) return 'different'
  return 'consistent'
}

function getLevel(freshness, completeness, modelAgreement) {
  if (freshness === 'stale' || completeness === 'partial' || modelAgreement === 'conflict' || modelAgreement === 'unavailable') {
    return 'low'
  }
  if (freshness === 'fresh' && completeness === 'complete' && modelAgreement === 'consistent') {
    return 'high'
  }
  return 'medium'
}

function getLabel(level) {
  return {
    high: '高可信度',
    medium: '中可信度',
    low: '低可信度'
  }[level]
}

function getReasons(freshness, completeness, modelAgreement) {
  const reasons = []
  reasons.push({
    fresh: '天气数据新鲜',
    normal: '天气数据更新一般',
    stale: '天气数据偏旧'
  }[freshness])
  reasons.push(completeness === 'complete' ? '关键天气字段完整' : '关键天气字段缺失')
  reasons.push({
    consistent: 'EC/GFS 较一致',
    different: 'EC/GFS 存在差异',
    conflict: 'EC/GFS 分歧较大',
    unavailable: 'EC/GFS 模型数据不完整'
  }[modelAgreement])
  return reasons
}

module.exports = { evaluateForecastConfidence }
