const HOUR = 60 * 60 * 1000
const CHINA_OFFSET = 8 * HOUR
const { applyCalibration } = require('./calibration')

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function chinaDate(now) {
  return new Date(now.getTime() + CHINA_OFFSET).toISOString().slice(0, 10)
}

function parseSunTime(date, time) {
  return new Date(`${date}T${time}:00+08:00`)
}

function formatTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date)
}

function isBadWeather(text) {
  return /雨|雪|雷|雾|霾|沙尘|冰雹/.test(text || '')
}

function finiteValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readField(item, keys, fallback = null) {
  const source = item || {}
  for (const key of keys) {
    const value = finiteValue(source[key])
    if (value !== null) return value
  }
  return fallback
}

function averageField(records, keys, fallback = null) {
  const values = records.map((item) => readField(item, keys)).filter((value) => value !== null)
  if (!values.length) return fallback
  return values.reduce((total, value) => total + value, 0) / values.length
}

function hasAnyField(records, daily, keys) {
  return records.some((item) => readField(item, keys) !== null) || readField(daily, keys) !== null
}

function maxField(records, keys, fallback = 0) {
  const values = records.map((item) => readField(item, keys)).filter((value) => value !== null)
  return values.length ? Math.max(...values) : fallback
}

function sumField(records, keys, fallback = 0) {
  const values = records.map((item) => readField(item, keys)).filter((value) => value !== null)
  return values.length ? values.reduce((total, value) => total + value, 0) : fallback
}

function selectHours(hourly, start, end) {
  const lower = start.getTime() - HOUR
  const upper = end.getTime() + HOUR
  return hourly.filter((item) => {
    const time = new Date(item.fxTime).getTime()
    return time >= lower && time <= upper
  })
}

function getMetrics(records, daily, window) {
  const dailyData = daily || {}
  const cloud = averageField(records, ['cloud', 'cloudCover', 'totalCloud'], readField(dailyData, ['cloud', 'cloudCover', 'totalCloud'], 50))
  const lowCloud = averageField(records, ['lowCloud', 'cloudLow', 'lowCloudCover'], readField(dailyData, ['lowCloud', 'cloudLow', 'lowCloudCover']))
  const midCloud = averageField(records, ['midCloud', 'middleCloud', 'cloudMid', 'midCloudCover'], readField(dailyData, ['midCloud', 'middleCloud', 'cloudMid', 'midCloudCover']))
  const highCloud = averageField(records, ['highCloud', 'cloudHigh', 'highCloudCover'], readField(dailyData, ['highCloud', 'cloudHigh', 'highCloudCover']))
  const humidity = averageField(records, ['humidity', 'relativeHumidity'], readField(dailyData, ['humidity', 'relativeHumidity'], 65))
  const wind = averageField(records, ['windSpeed', 'windSpeedDay'], readField(dailyData, ['windSpeedDay', 'windSpeed'], 10))
  const visibility = averageField(records, ['vis', 'visibility'], readField(dailyData, ['vis', 'visibility'], 10))
  const rainProbability = maxField(records, ['pop', 'precipProbability'], 0)
  const precipitation = sumField(records, ['precip', 'precipitation'], readField(dailyData, ['precip', 'precipitation'], 0))
  const hasPrecipitation = records.some((item) => readField(item, ['precip', 'precipitation'], 0) > 0 || isBadWeather(item.text))
  const hasSevereWeather = records.some((item) => /雷|暴雨|大风|冰雹/.test(item.text || ''))
  const pressure = averageField(records, ['pressure', 'surfacePressure'], readField(dailyData, ['pressure', 'surfacePressure']))
  const dewPoint = averageField(records, ['dew', 'dewPoint'], readField(dailyData, ['dew', 'dewPoint']))
  const cloudLayerCount = [lowCloud, midCloud, highCloud].filter((value) => value !== null).length
  const coreFieldsAvailable = [
    hasAnyField(records, dailyData, ['cloud', 'cloudCover', 'totalCloud']),
    hasAnyField(records, dailyData, ['humidity', 'relativeHumidity']),
    hasAnyField(records, dailyData, ['windSpeed', 'windSpeedDay']),
    hasAnyField(records, dailyData, ['vis', 'visibility']),
    hasAnyField(records, dailyData, ['pop', 'precipProbability'])
  ]
  const dataCompleteness = coreFieldsAvailable.filter(Boolean).length / coreFieldsAvailable.length
  const windowMinutes = window ? Math.max(1, (window.end.getTime() - window.start.getTime()) / (60 * 1000)) : 60

  return {
    cloud,
    lowCloud,
    midCloud,
    highCloud,
    humidity,
    wind,
    visibility,
    rainProbability,
    precipitation,
    hasPrecipitation,
    hasSevereWeather,
    pressure,
    dewPoint,
    cloudLayerCount,
    cloudLayersAvailable: cloudLayerCount > 0,
    dataCompleteness,
    windowMinutes,
    modelAgreementScore: null
  }
}

function modelNumber(snapshot, keys) {
  const metrics = snapshot && snapshot.metrics ? snapshot.metrics : {}
  for (const key of keys) {
    const value = finiteValue(snapshot && snapshot[key])
    if (value !== null) return value
    const metricValue = finiteValue(metrics[key])
    if (metricValue !== null) return metricValue
  }
  return null
}

function buildModelFeatures(modelReference, targetAt) {
  const models = modelReference && Array.isArray(modelReference.models)
    ? modelReference.models.filter((model) => model.available)
    : []
  const fields = {
    cloud: ['cloud', 'totalCloud'],
    lowCloud: ['lowCloud', 'lowCloudCover'],
    midCloud: ['midCloud', 'midCloudCover'],
    highCloud: ['highCloud', 'highCloudCover'],
    precipitation: ['precipitation', 'precip'],
    humidity: ['humidity', 'relativeHumidity'],
    visibility: ['visibility', 'vis']
  }
  const sources = models.map((model) => {
    const values = Object.keys(fields).reduce((result, key) => {
      result[key] = modelNumber(model, fields[key])
      return result
    }, {})
    const availableFields = Object.values(values).filter((value) => value !== null).length
    const distance = Math.abs(finiteValue(model.validAt) - Number(targetAt || modelReference.targetAt || 0))
    const freshness = Number.isFinite(distance) && distance > 0
      ? clamp(1 - distance / (6 * HOUR), 0.25, 1)
      : 1
    return {
      source: model.source,
      values,
      imageFeatures: model.imageFeatures && typeof model.imageFeatures === 'object' ? model.imageFeatures : null,
      quality: Math.max(0.15, (availableFields / Object.keys(fields).length) * freshness)
    }
  })
  const fused = Object.keys(fields).reduce((result, key) => {
    const available = sources.filter((source) => source.values[key] !== null)
    const weight = available.reduce((sum, source) => sum + source.quality, 0)
    result[key] = weight
      ? available.reduce((sum, source) => sum + source.values[key] * source.quality, 0) / weight
      : null
    return result
  }, {})
  const agreementLevel = modelReference && modelReference.agreement && modelReference.agreement.level
  const agreementScore = agreementLevel === 'high'
    ? 100
    : agreementLevel === 'medium'
      ? 65
      : agreementLevel === 'low'
        ? 35
        : null
  const quality = sources.length
    ? sources.reduce((sum, source) => sum + source.quality, 0) / sources.length
    : 0
  const fieldsAvailable = Object.values(fused).filter((value) => value !== null).length
  const imageSources = sources.filter((source) => source.imageFeatures && Number.isFinite(Number(source.imageFeatures.colorPotential)))
  const imageWeight = imageSources.reduce((sum, source) => sum + source.quality, 0)
  const imageFeatures = imageWeight
    ? ['colorPotential', 'cloudCarrier', 'spatialContinuity', 'confidence'].reduce((result, key) => {
        const available = imageSources.filter((source) => Number.isFinite(Number(source.imageFeatures[key])))
        const weight = available.reduce((sum, source) => sum + source.quality, 0)
        result[key] = weight
          ? available.reduce((sum, source) => sum + Number(source.imageFeatures[key]) * source.quality, 0) / weight
          : null
        return result
      }, { source: imageSources.some((source) => source.imageFeatures.status === 'ready') ? 'cloud-map-values' : 'numeric-proxy', status: imageSources.some((source) => source.imageFeatures.status === 'ready') ? 'ready' : 'proxy' })
    : null
  return {
    available: sources.length > 0 && fieldsAvailable > 0,
    sourceCount: sources.length,
    quality,
    dataCompleteness: fieldsAvailable / Object.keys(fields).length,
    agreementScore,
    agreementLevel: agreementLevel || 'unavailable',
    values: fused,
    imageFeatures
  }
}

function fuseValue(localValue, modelValue, localQuality, modelQuality) {
  if (localValue === null && modelValue === null) return null
  if (localValue === null) return modelValue
  if (modelValue === null) return localValue
  const localWeight = Math.max(0.1, localQuality)
  const modelWeight = Math.max(0.1, modelQuality)
  return (localValue * localWeight + modelValue * modelWeight) / (localWeight + modelWeight)
}

function fuseMetrics(metrics, modelReference, targetAt) {
  const model = buildModelFeatures(modelReference, targetAt)
  if (!model.available) return { ...metrics, imageFeatures: null, modelFusion: model }
  const localQuality = Math.max(0.2, metrics.dataCompleteness)
  const modelQuality = Math.max(0.2, model.quality)
  const values = model.values
  const fused = {
    ...metrics,
    cloud: fuseValue(metrics.cloud, values.cloud, localQuality, modelQuality),
    lowCloud: fuseValue(metrics.lowCloud, values.lowCloud, localQuality, modelQuality),
    midCloud: fuseValue(metrics.midCloud, values.midCloud, localQuality, modelQuality),
    highCloud: fuseValue(metrics.highCloud, values.highCloud, localQuality, modelQuality),
    humidity: fuseValue(metrics.humidity, values.humidity, localQuality, modelQuality),
    visibility: fuseValue(metrics.visibility, values.visibility, localQuality, modelQuality),
    precipitation: fuseValue(metrics.precipitation, values.precipitation, localQuality, modelQuality),
    hasPrecipitation: metrics.hasPrecipitation || (values.precipitation !== null && values.precipitation > 0.2),
    cloudLayerCount: [metrics.lowCloud, metrics.midCloud, metrics.highCloud, values.lowCloud, values.midCloud, values.highCloud]
      .filter((value) => value !== null).length,
    cloudLayersAvailable: Boolean(metrics.cloudLayersAvailable || values.lowCloud !== null || values.midCloud !== null || values.highCloud !== null),
    dataCompleteness: Math.max(metrics.dataCompleteness, model.dataCompleteness),
    modelAgreementScore: model.agreementScore,
    imageFeatures: model.imageFeatures,
    modelFusion: model
  }
  return fused
}

function cloudAmountScore(cloud) {
  if (cloud === null) return 0.5
  if (cloud <= 10) return clamp(0.55 + cloud / 40, 0.55, 0.8)
  if (cloud >= 88) return 0.35
  return clamp(1 - Math.abs(cloud - 50) / 70, 0.35, 1)
}

function layerCloudScore(value, minimum, maximum) {
  if (value === null) return null
  const middle = (minimum + maximum) / 2
  if (value < minimum) return clamp(0.5 + value / Math.max(1, minimum) * 0.3, 0.45, 0.8)
  if (value > maximum) return clamp(0.85 - (value - maximum) / 50, 0.25, 0.85)
  return clamp(0.82 + 0.18 * (1 - Math.abs(value - middle) / Math.max(1, (maximum - minimum) / 2)), 0.82, 1)
}

function cloudStructureScore(metrics) {
  const total = cloudAmountScore(metrics.cloud)
  const layers = [
    [layerCloudScore(metrics.lowCloud, 15, 65), 0.35],
    [layerCloudScore(metrics.midCloud, 15, 70), 0.35],
    [layerCloudScore(metrics.highCloud, 10, 55), 0.15]
  ].filter(([value]) => value !== null)
  if (!layers.length) return total
  const layerWeight = layers.reduce((sum, [, weight]) => sum + weight, 0)
  const layerScore = layers.reduce((sum, [value, weight]) => sum + value * weight, 0) / layerWeight
  return clamp(total * 0.35 + layerScore * 0.65, 0, 1)
}

function humidityScore(humidity) {
  if (humidity === null) return 0.55
  return clamp(1 - Math.abs(humidity - 65) / 45, 0.2, 1)
}

function transparencyScore(metrics) {
  const visibility = metrics.visibility === null ? 0.55 : clamp((metrics.visibility - 2) / 18, 0.1, 1)
  return clamp(visibility * 0.7 + humidityScore(metrics.humidity) * 0.3, 0, 1)
}

function precipitationScore(metrics) {
  let score = clamp(1 - metrics.rainProbability / 100, 0, 1)
  if (metrics.precipitation > 0) score *= clamp(1 - metrics.precipitation / 5, 0.15, 1)
  if (metrics.hasPrecipitation) score = Math.min(score, 0.45)
  if (metrics.hasSevereWeather) score = Math.min(score, 0.1)
  return score
}

function stabilityScore(metrics) {
  if (metrics.wind === null) return 0.65
  if (metrics.wind <= 12) return 1
  if (metrics.wind <= 25) return clamp(1 - (metrics.wind - 12) / 65, 0.75, 1)
  return clamp(0.8 - (metrics.wind - 25) / 35, 0.15, 0.8)
}

function lightPathScore(metrics) {
  const temporal = metrics.windowMinutes >= 35 && metrics.windowMinutes <= 80 ? 1 : 0.85
  const cloudAccess = metrics.cloud > 85 ? 0.35 : 0.7 + cloudStructureScore(metrics) * 0.3
  return clamp(temporal * cloudAccess, 0, 1)
}

function confidenceFor(metrics) {
  const recordBonus = metrics.windowMinutes >= 35 ? 0.08 : 0
  const modelAdjustment = metrics.modelAgreementScore === null ? 0 : (metrics.modelAgreementScore - 50) / 500
  const raw = metrics.dataCompleteness * 0.82 + (metrics.cloudLayersAvailable ? 0.1 : 0) + recordBonus + modelAdjustment
  // 没有 EC/GFS 信号时，可信度暂不显示为“高”。
  const value = Math.round(clamp(raw * 100, 30, metrics.modelAgreementScore === null ? 68 : 92))
  const level = value >= 75 ? 'high' : value >= 50 ? 'medium' : 'low'
  const label = level === 'high' ? '高' : level === 'medium' ? '中' : '低'
  const reason = metrics.dataCompleteness < 0.4
    ? '天气字段不完整，评分已降级并限制上限'
    : metrics.modelAgreementScore === null
      ? '已使用本地天气数据，EC/GFS模型信号暂不可用'
      : metrics.modelAgreementScore < 50
        ? 'EC/GFS模型差异较大，可信度已下调'
        : '已融合EC/GFS原始特征与本地天气数据'
  return { value, level, label, reason }
}

function scoreForType(metrics, type) {
  const components = {
    cloudStructure: Math.round(cloudStructureScore(metrics) * 100),
    lightPath: Math.round(lightPathScore(metrics) * 100),
    transparency: Math.round(transparencyScore(metrics) * 100),
    precipitation: Math.round(precipitationScore(metrics) * 100),
    stability: Math.round(stabilityScore(metrics) * 100),
    moisture: Math.round(humidityScore(metrics.humidity) * 100)
  }
  const weights = type === '火烧云'
    ? { cloudStructure: 0.36, lightPath: 0.24, transparency: 0.12, precipitation: 0.14, stability: 0.06, moisture: 0.08 }
    : { cloudStructure: 0.35, lightPath: 0.2, transparency: 0.15, precipitation: 0.18, stability: 0.08, moisture: 0.04 }
  let score = Object.keys(weights).reduce((total, key) => total + components[key] * weights[key], 0)
  if (metrics.hasSevereWeather || metrics.rainProbability >= 85 || metrics.visibility < 3) score = Math.min(score, 35)
  else if (metrics.hasPrecipitation || metrics.rainProbability >= 70) score = Math.min(score, 45)
  if (metrics.modelAgreementScore !== null && metrics.modelAgreementScore < 40) score = Math.min(score, 70)
  if (metrics.dataCompleteness < 0.4) score = Math.min(score, 45)
  else if (metrics.dataCompleteness < 0.7) score = Math.min(score, 65)
  const confidence = confidenceFor(metrics)
  return {
    score: Math.round(clamp(score, 0, 100)),
    components,
    confidence,
    version: '2.0'
  }
}

function occurrenceProbability(scoreResult, metrics, type, calibrationProfile) {
  const prior = type === '火烧云' ? 25 : type === '朝霞' ? 55 : 60
  const confidence = scoreResult.confidence.value / 100
  let probability = prior + (scoreResult.score - prior) * 0.72 * confidence
  if (metrics.hasSevereWeather) probability = Math.min(probability, 20)
  else if (metrics.hasPrecipitation || metrics.rainProbability >= 80) probability = Math.min(probability, 35)
  if (confidence < 0.4) probability = Math.min(probability, 40)
  else if (confidence < 0.5) probability = Math.min(probability, 50)
  const calibrated = applyCalibration(Math.round(clamp(probability, 5, 90)), scoreResult.score, type, calibrationProfile)
  return calibrated
}

function fireCloudVividness(metrics) {
  // 鲜艳度是“出现后有多艳”的强度指标，不等同于出现概率。
  // 当前阶段使用 EC/GFS 分层云量、光路、能见度和降水信号构建可解释的基础指数；
  // 后续接入云相态、云底高度和 CAMS AOD 后，可继续替换对应分量。
  const carrier = cloudStructureScore(metrics)
  const lightPath = lightPathScore(metrics)
  const atmosphere = transparencyScore(metrics)
  const imagePotential = metrics.imageFeatures && Number.isFinite(Number(metrics.imageFeatures.colorPotential))
    ? clamp(Number(metrics.imageFeatures.colorPotential) / 100, 0, 1)
    : null
  const imageConfidence = metrics.imageFeatures && Number.isFinite(Number(metrics.imageFeatures.confidence))
    ? clamp(Number(metrics.imageFeatures.confidence) / 100, 0, 1)
    : 0
  // Cloud-map colour is an auxiliary signal. Keep its influence bounded so a
  // stale/proxy feature can never override precipitation or local weather.
  const imageWeight = imagePotential === null ? 0 : clamp(0.08 + imageConfidence * 0.12, 0.08, 0.2)
  const blendedCarrier = imagePotential === null
    ? carrier
    : carrier * (1 - imageWeight) + imagePotential * imageWeight
  const duration = clamp((metrics.windowMinutes || 60) / 60, 0.55, 1)
  const lowCloudPenalty = metrics.lowCloud === null
    ? 1
    : metrics.lowCloud <= 65
      ? 1
      : clamp(1 - (metrics.lowCloud - 65) / 70, 0.35, 1)
  const rainPenalty = metrics.hasSevereWeather
    ? 0.12
    : metrics.hasPrecipitation || metrics.rainProbability >= 70
      ? 0.45
      : 1
  const raw = 2.4 * (
    blendedCarrier * 0.35 +
    lightPath * 0.25 +
    atmosphere * 0.25 +
    duration * 0.15
  ) * lowCloudPenalty * rainPenalty
  const value = Number(clamp(raw, 0, 2.5).toFixed(2))
  const level = value >= 1 ? 'large' : value >= 0.5 ? 'medium' : value >= 0.2 ? 'small' : 'none'
  const label = level === 'large' ? '大烧' : level === 'medium' ? '中烧' : level === 'small' ? '小烧' : '无'
  const reason = level === 'none'
    ? '云层、光路或空气条件不足，鲜艳度有限'
    : level === 'large'
      ? '中高云层次、光路和空气显色条件较好'
      : level === 'medium'
        ? '具备一定中高云和光照条件，局部可能较鲜艳'
        : '有少量适合着色的云层，但范围或光路有限'
  return {
    value,
    text: value.toFixed(2),
    level,
    label,
    reason,
    components: {
      cloudCarrier: Math.round(carrier * 100),
      imageColorPotential: imagePotential === null ? null : Math.round(imagePotential * 100),
      imageWeight: Math.round(imageWeight * 100),
      lightPath: Math.round(lightPath * 100),
      atmosphere: Math.round(atmosphere * 100),
      duration: Math.round(duration * 100),
      lowCloudPenalty: Math.round(lowCloudPenalty * 100)
    }
  }
}

function fireCloudScore(metrics, baseScore) {
  const result = scoreForType(metrics, '火烧云')
  const vividness = fireCloudVividness(metrics)
  return {
    ...result,
    score: Math.round(clamp(result.score * 0.8 + baseScore * 0.2, 0, 95)),
    vividness: vividness.value,
    vividnessText: vividness.text,
    vividnessLevel: vividness.level,
    vividnessLabel: vividness.label,
    vividnessReason: vividness.reason,
    vividnessComponents: vividness.components
  }
}

function tier(score) {
  if (score >= 70) return { key: 'high', label: '值得期待' }
  if (score >= 40) return { key: 'medium', label: '不妨看看' }
  return { key: 'low', label: '不太明显' }
}

function reasonFor(metrics, type) {
  if (metrics.hasPrecipitation || metrics.rainProbability >= 70) return '降水可能性较高，光照条件有限'
  if (metrics.visibility < 5) return '能见度一般，色彩可能受影响'
  if (metrics.cloud < 20) return '云量偏少，天空层次可能有限'
  if (metrics.cloud > 80) return '云层偏厚，阳光可能被遮挡'
  return type === '火烧云' ? '云量与水汽条件较适中' : '云量适中，暂无明显降水'
}

function buildItem(type, scoreResult, start, end, metrics, direction, calibrationProfile) {
  const score = scoreResult.score
  const level = tier(score)
  const probability = occurrenceProbability(scoreResult, metrics, type, calibrationProfile)
  return {
    type,
    score,
    probability: probability.probability,
    probabilityLabel: probability.label,
    probabilityStatus: probability.status,
    calibrationSampleCount: probability.sampleCount,
    calibrationSource: probability.source,
    confidence: scoreResult.confidence.value,
    confidenceLevel: scoreResult.confidence.level,
    confidenceLabel: scoreResult.confidence.label,
    confidenceReason: scoreResult.confidence.reason,
    scoreVersion: scoreResult.version,
    scoreComponents: scoreResult.components,
    ...(type === '火烧云'
      ? {
          vividness: scoreResult.vividness,
          vividnessText: scoreResult.vividnessText,
          vividnessLevel: scoreResult.vividnessLevel,
          vividnessLabel: scoreResult.vividnessLabel,
          vividnessReason: scoreResult.vividnessReason,
          vividnessComponents: scoreResult.vividnessComponents
        }
      : {}),
    time: `${formatTime(start)}–${formatTime(end)}`,
    reason: reasonFor(metrics, type),
    direction: level.key === 'high' ? direction : '',
    tier: level.key,
    label: level.label,
    showDirection: level.key === 'high'
  }
}

function buildDetailTimeline(window, hourly) {
  const lower = window.start.getTime() - 3 * HOUR
  const upper = window.end.getTime() + 3 * HOUR
  return hourly
    .filter((item) => {
      const time = new Date(item.fxTime).getTime()
      return time >= lower && time <= upper
    })
    .map((item) => {
      const time = new Date(item.fxTime)
      const precipitation = number(item.precip, 0)
      const probability = number(item.pop, 0)
      return {
        timestamp: time.getTime(),
        time: formatTime(time),
        weather: item.text || '天气变化中',
        probability,
        precipitationText: formatRainAmount(precipitation),
        cloud: Math.round(number(item.cloud, 0)),
        isWindow: time.getTime() >= window.start.getTime() && time.getTime() <= window.end.getTime(),
        isRaining: probability >= 40 || precipitation > 0 || isBadWeather(item.text)
      }
    })
}

function buildFactors(metrics) {
  const favorable = []
  const unfavorable = []

  if (metrics.cloud >= 30 && metrics.cloud <= 70) favorable.push('云量适中，天空层次更容易显现')
  else if (metrics.cloud < 30) unfavorable.push('云量偏少，色彩层次可能有限')
  else unfavorable.push('云层偏厚，日光可能被遮挡')

  if (!metrics.hasPrecipitation && metrics.rainProbability < 40) favorable.push('降水信号较弱，光照条件更稳定')
  else unfavorable.push('降水可能会削弱光照和能见度')

  if (metrics.visibility >= 8) favorable.push('能见度较好，远处天空更清晰')
  else if (metrics.visibility < 5) unfavorable.push('能见度有限，色彩可能不够通透')

  if (metrics.wind > 25) unfavorable.push('风力偏大，户外观赏需注意安全')

  return { favorable: favorable.slice(0, 3), unfavorable: unfavorable.slice(0, 3) }
}

function buildAirReference(airQuality, visibility) {
  const indexes = airQuality && Array.isArray(airQuality.indexes) ? airQuality.indexes : []
  const pollutants = airQuality && Array.isArray(airQuality.pollutants) ? airQuality.pollutants : []
  const index = indexes.find((item) => item.code === 'cn-mee') || indexes[0] || {}
  const pm25 = pollutants.find((item) => item.code === 'pm2p5') || {}
  const aqi = number(index.aqi, null)
  const pm25Value = number(pm25.concentration && pm25.concentration.value, null)
  const roundedVisibility = Math.round(number(visibility, 10))
  const hasAirData = Number.isFinite(aqi) || Number.isFinite(pm25Value)

  let level = 'good'
  let label = '良好'
  let description = '空气较通透，远处天空层次更容易显现'
  if (roundedVisibility < 5 || aqi >= 151 || pm25Value >= 75) {
    level = 'poor'
    label = '较差'
    description = '雾霾或低能见度可能削弱天空色彩'
  } else if (roundedVisibility < 8 || aqi >= 101 || pm25Value >= 35) {
    level = 'medium'
    label = '一般'
    description = '空气通透度一般，远处色彩可能不够清晰'
  }

  return {
    level,
    label,
    description,
    aqiText: Number.isFinite(aqi) ? String(Math.round(aqi)) : '暂不可用',
    pm25Text: Number.isFinite(pm25Value) ? `${Math.round(pm25Value)} μg/m³` : '暂不可用',
    visibilityText: `${roundedVisibility}km`,
    hasAirData,
    note: hasAirData
      ? 'AQI 与 PM2.5 为当前空气质量参考；能见度为建议观赏时段预报。'
      : '当前 AQI 与 PM2.5 暂不可用；通透度仅参考建议观赏时段的能见度。'
  }
}

function relativeLabel(date, kind, today) {
  const prefix = date === today ? '今天' : '明日'
  return `${prefix}${kind === 'sunrise' ? '清晨' : '傍晚'}`
}

function getWindows(daily, now) {
  const today = chinaDate(now)
  const horizon = now.getTime() + 24 * HOUR
  const windows = []
  daily.forEach((day) => {
    [['sunrise', -45, 15], ['sunset', -30, 25]].forEach(([kind, before, after]) => {
      if (!day[kind]) return
      const solar = parseSunTime(day.fxDate, day[kind])
      const start = new Date(solar.getTime() + before * 60 * 1000)
      const end = new Date(solar.getTime() + after * 60 * 1000)
      if (end.getTime() > now.getTime() && start.getTime() < horizon) {
        windows.push({ kind, start, end, solar, daily: day, title: relativeLabel(day.fxDate, kind, today) })
      }
    })
  })
  return windows.sort((a, b) => a.start - b.start).slice(0, 2)
}

function buildWindow(window, hourly, modelReference, calibrationProfile) {
  const localMetrics = getMetrics(selectHours(hourly, window.start, window.end), window.daily, window)
  const metrics = fuseMetrics(localMetrics, modelReference, window.solar.getTime())
  const type = window.kind === 'sunrise' ? '朝霞' : '晚霞'
  const direction = window.kind === 'sunrise' ? '面向东侧天空' : '面向西侧天空'
  const skyResult = scoreForType(metrics, type)
  const sky = buildItem(type, skyResult, window.start, window.end, metrics, direction, calibrationProfile)
  const fireResult = fireCloudScore(metrics, sky.score)
  const fire = buildItem('火烧云', fireResult, window.start, window.end, metrics, direction, calibrationProfile)
  const skies = [sky, fire]
  return {
    title: window.title,
    kind: window.kind,
    date: window.daily.fxDate,
    time: sky.time,
    solarAt: window.solar.getTime(),
    solarTime: formatTime(window.solar),
    startAt: window.start.getTime(),
    endAt: window.end.getTime(),
    startTime: formatTime(window.start),
    endTime: formatTime(window.end),
    skies,
    // 同一观赏时段内，朝霞/晚霞与火烧云作为一组展示；
    // 火烧云仍使用独立评分，但不再因分数更高而替代主霞况。
    primarySky: sky,
    fireCloud: fire,
    hero: { ...sky, displayTitle: sky.type },
    secondarySkies: [fire],
    hourlyTimeline: buildDetailTimeline(window, hourly),
    factors: buildFactors(metrics),
    modelFusion: metrics.modelFusion
  }
}

function groupRainRecords(records) {
  if (!records.length) return []
  const groups = []
  let group = []
  records.forEach((item) => {
    const currentTime = new Date(item.fxTime).getTime()
    const previous = group[group.length - 1]
    const previousTime = previous ? new Date(previous.fxTime).getTime() : 0
    if (previous && currentTime - previousTime > HOUR * 1.5) {
      groups.push(group)
      group = []
    }
    group.push(item)
  })
  if (group.length) groups.push(group)

  return groups.map((groupRecords) => buildRainEvent(groupRecords))
}

function buildRainEvents(hourly, now) {
  const horizon = now.getTime() + 24 * HOUR
  const rainHours = hourly.filter((item) => {
    const time = new Date(item.fxTime).getTime()
    return time >= now.getTime() && time < horizon &&
      (number(item.pop, 0) >= 40 || number(item.precip, 0) > 0 || isBadWeather(item.text))
  })
  return groupRainRecords(rainHours)
}

function rainIntensity(records) {
  const texts = records.map((item) => item.text || '').join(' ')
  const maximum = Math.max(...records.map((item) => number(item.precip, 0)), 0)
  if (/雷/.test(texts)) return '雷阵雨'
  if (/暴雨|大暴雨/.test(texts) || maximum >= 10) return '大雨'
  if (/中雨/.test(texts) || maximum >= 2.5) return '中雨'
  if (/小雨|雨/.test(texts) || maximum > 0) return '小雨'
  return '有雨'
}

function formatRainAmount(amount) {
  const fixed = amount < 1 ? amount.toFixed(1) : amount.toFixed(1).replace(/\.0$/, '')
  return `${fixed}mm`
}

function formatDuration(start, end) {
  const hours = Math.max(1, Math.round((end - start) / HOUR))
  return `约${hours}小时`
}

function buildRainEvent(records) {
  const start = new Date(records[0].fxTime)
  const last = new Date(records[records.length - 1].fxTime)
  const end = new Date(last.getTime() + HOUR)
  const probability = Math.max(...records.map((item) => number(item.pop, 0)), 0)
  const amount = records.reduce((total, item) => total + number(item.precip, 0), 0)
  const intensity = rainIntensity(records)
  return {
    startAt: start.getTime(),
    endAt: end.getTime(),
    startTime: formatTime(start),
    endTime: formatTime(end),
    time: `${formatTime(start)}–${formatTime(end)}`,
    duration: formatDuration(start, end),
    probability,
    precipitation: amount,
    precipitationText: formatRainAmount(amount),
    intensity,
    text: `${intensity}，出门建议带伞`
  }
}

function buildRainTimeline(hourly, now) {
  const horizon = now.getTime() + 12 * HOUR
  return hourly
    .filter((item) => {
      const time = new Date(item.fxTime).getTime()
      return time >= now.getTime() - HOUR && time < horizon
    })
    .map((item) => {
      const time = new Date(item.fxTime)
      const precipitation = number(item.precip, 0)
      const probability = number(item.pop, 0)
      return {
        timestamp: time.getTime(),
        time: formatTime(time),
        weather: item.text || '天气变化中',
        probability,
        precipitation,
        precipitationText: formatRainAmount(precipitation),
        isRaining: probability >= 40 || precipitation > 0 || isBadWeather(item.text)
      }
    })
}

function pickTimelineNodes(timeline, count = 6) {
  if (timeline.length <= count) return timeline
  const indexes = new Set()
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.round(index * (timeline.length - 1) / (count - 1)))
  }
  return [...indexes].map((index) => timeline[index])
}

function buildShortRainForecast(hourly, now) {
  const timeline = buildRainTimeline(hourly, now)
  const rainHours = timeline.filter((item) => item.isRaining)
  if (!rainHours.length) return null

  const records = rainHours.map((point) => ({
    fxTime: new Date(point.timestamp).toISOString(),
    pop: point.probability,
    precip: point.precipitation,
    text: point.weather
  }))
  const event = groupRainRecords(records)[0]
  if (!event) return null
  const startsIn = event.startAt - now.getTime()
  const isCurrent = event.startAt <= now.getTime() && event.endAt > now.getTime()
  const isSoon = event.startAt <= now.getTime() + 3 * HOUR && event.endAt > now.getTime()
  const hoursUntil = Math.max(1, Math.ceil(startsIn / HOUR))
  let headline = '未来12小时可能有雨'
  if (isCurrent) headline = `正在下${event.intensity}`
  else if (startsIn <= HOUR) headline = '雨快来了'
  else if (isSoon) headline = `约${hoursUntil}小时后有${event.intensity}`

  const detail = isCurrent
    ? `预计至${event.endTime}前后结束 · 累计${event.precipitationText}`
    : `${event.startTime}开始 · 预计持续${event.duration}`

  return {
    ...event,
    headline,
    detail,
    isSoon,
    isCurrent,
    timeline,
    summaryTimeline: pickTimelineNodes(timeline)
  }
}

function rainImpactFor(window, rainEvents) {
  const overlap = rainEvents.find((event) => event.startAt < window.end.getTime() && event.endAt > window.start.getTime())
  return overlap ? `该时段有${overlap.intensity}，观赏条件受影响` : ''
}

function buildAlertRainForecast(alert, now) {
  if (!alert) return null
  const title = alert.headline || (alert.eventType && alert.eventType.name) || ''
  const detail = alert.description || ''
  const content = `${title} ${detail}`
  if (!/雷雨|暴雨|大雨|强降水|短时强降水|雷电/.test(content)) return null

  return {
    headline: '未来3小时可能有强降雨',
    detail: `${title || '已发布降雨预警'}，请以安全预警为准`,
    probability: 100,
    precipitationText: '以预警为准',
    isSoon: true,
    isCurrent: false,
    alertDriven: true,
    timeline: [],
    summaryTimeline: []
  }
}

function trendLabel(date, today) {
  const days = Math.round((parseSunTime(date, '12:00') - parseSunTime(today, '12:00')) / (24 * HOUR))
  return ['今天', '明天', '后天'][days] || `${date.slice(5, 7)}月${date.slice(8)}日`
}

function weekLabel(date, today) {
  const offset = Math.round((parseSunTime(date, '12:00') - parseSunTime(today, '12:00')) / (24 * HOUR))
  if (offset === 0) return '今天'
  if (offset === 1) return '明天'
  return `周${['日', '一', '二', '三', '四', '五', '六'][parseSunTime(date, '12:00').getDay()]}`
}

function buildTwoWeekForecastView({ city, hourly, daily, now = new Date() }) {
  const today = chinaDate(now)
  const days = daily
    .filter((day) => day.fxDate >= today)
    .slice(0, 14)
    .map((day, index) => {
      const hourlyRecords = index < 7
        ? hourly.filter((item) => chinaDate(new Date(item.fxTime)) === day.fxDate)
        : []
      const hasProbability = hourlyRecords.length > 0
      const probability = hasProbability
        ? Math.max(...hourlyRecords.map((item) => number(item.pop, 0)), 0)
        : null
      const precipitation = number(day.precip, 0)
      return {
        date: day.fxDate,
        day: weekLabel(day.fxDate, today),
        dateText: `${Number(day.fxDate.slice(5, 7))}月${Number(day.fxDate.slice(8))}日`,
        weather: day.textDay || day.textNight || '天气变化中',
        temperature: `${day.tempMin}–${day.tempMax}℃`,
        probability,
        probabilityText: hasProbability ? `${probability}%` : '暂不提供',
        precipitation,
        precipitationText: formatRainAmount(precipitation),
        hasRain: (probability || 0) >= 40 || precipitation > 0 || isBadWeather(day.textDay) || isBadWeather(day.textNight)
      }
    })

  if (!days.length) throw new Error('未获得未来两周的天气预报数据')
  return {
    city,
    updatedAt: `更新于 ${formatTime(now)}`,
    days
  }
}

function buildForecastView({ city, locationLabel = city, hourly, daily, alerts, airQuality, now = new Date(), modelReferences = {}, calibrationProfile = null }) {
  const rainEvents = buildRainEvents(hourly, now)
  const windowDefinitions = getWindows(daily, now)
  const windows = windowDefinitions.map((window) => ({
    ...buildWindow(window, hourly, modelReferences[window.kind], calibrationProfile),
    rainImpact: rainImpactFor(window, rainEvents)
  }))
  if (windows.length < 2) throw new Error('未获得足够的日出日落预报数据')
  const primaryMetrics = getMetrics(
    selectHours(hourly, windowDefinitions[0].start, windowDefinitions[0].end),
    windowDefinitions[0].daily
  )
  const airReference = buildAirReference(airQuality, primaryMetrics.visibility)
  const alert = alerts[0]
  const shortRain = buildShortRainForecast(hourly, now) || buildAlertRainForecast(alert, now)
  const today = chinaDate(now)
  const calibrationName = `${city}历史观测校准`
  const calibrationSuffix = calibrationProfile && calibrationProfile.status === 'calibrated' ? '' : '（待校准）'
  return {
    city,
    locationLabel,
    scoringVersion: '2.0',
    scoringMethod: `EC/GFS原始特征融合 + ${calibrationName}${calibrationSuffix}`,
    calibration: calibrationProfile
      ? {
          status: calibrationProfile.status,
          sampleCount: calibrationProfile.sampleCount,
          minimumSamples: calibrationProfile.minimumSamples,
          source: calibrationProfile.source,
          reason: calibrationProfile.reason
        }
      : { status: 'pending', sampleCount: 0, minimumSamples: 30, source: 'skyObservations' },
    updatedAt: `更新于 ${formatTime(now)}`,
    primaryWindow: windows[0],
    secondaryWindow: windows[1],
    skyWindows: windows,
    allLow: windows.every((window) => window.skies.every((item) => item.tier === 'low')),
    hasRain: rainEvents.length > 0,
    rain: rainEvents.length ? { events: rainEvents, primary: rainEvents[0] } : null,
    shortRain,
    airReference,
    warning: alert ? { title: alert.headline || alert.eventType.name, detail: alert.description } : null,
    trend: daily.filter((day) => day.fxDate >= today).slice(0, 3).map((day) => ({
      day: trendLabel(day.fxDate, today),
      weather: day.textDay,
      temperature: `${day.tempMin}–${day.tempMax}℃`,
      precipitation: `${day.precip || 0}mm`
    }))
  }
}

module.exports = { buildForecastView, buildTwoWeekForecastView }
