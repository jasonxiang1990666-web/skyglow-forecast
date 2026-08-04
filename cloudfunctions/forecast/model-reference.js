const NUMERIC_METRICS = [
  { key: 'totalCloud', keys: ['totalCloud', 'cloud'], label: '总云量', unit: '%' },
  { key: 'lowCloud', keys: ['lowCloud', 'lowCloudCover'], label: '低云', unit: '%' },
  { key: 'midCloud', keys: ['midCloud', 'middleCloud', 'midCloudCover'], label: '中云', unit: '%' },
  { key: 'highCloud', keys: ['highCloud', 'highCloudCover'], label: '高云', unit: '%' },
  { key: 'precipitation', keys: ['precipitation', 'precip'], label: '降水', unit: 'mm' },
  { key: 'humidity', keys: ['humidity', 'relativeHumidity'], label: '相对湿度', unit: '%' },
  { key: 'visibility', keys: ['visibility'], label: '能见度', unit: 'km' }
]

function timestamp(value) {
  if (value instanceof Date) return value.getTime()
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return number
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function formatChinaTime(value) {
  const time = timestamp(value)
  if (!time) return '暂未提供'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(time)).replace(/\//g, '-')
}

function emptyModel(source, targetAt, reason = '') {
  return {
    source,
    name: source === 'EC' ? 'EC' : 'GFS',
    available: false,
    status: 'unavailable',
    statusText: '数据不足',
    runAt: 0,
    validAt: Number(targetAt) || 0,
    runAtText: '暂未同步',
    validAtText: formatChinaTime(targetAt),
    imageFileId: '',
    imageUrl: '',
    imageFeatures: null,
    reason: reason || `尚未同步到该观赏时段的 ${source} 云量图`
  }
}

function metricNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function readSnapshotMetric(snapshot, keys) {
  if (!snapshot) return null
  const metrics = snapshot.metrics || {}
  return metricNumber(...keys.map((key) => snapshot[key]), ...keys.map((key) => metrics[key]))
}

function getSnapshotMetrics(snapshot) {
  return NUMERIC_METRICS.reduce((result, definition) => {
    result[definition.key] = readSnapshotMetric(snapshot, definition.keys)
    return result
  }, {})
}

function formatMetricValue(value, unit) {
  if (!Number.isFinite(value)) return '—'
  const rounded = unit === 'mm' ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded}${unit}`
}

function cloudLabel(cloud) {
  if (!Number.isFinite(cloud)) return '未提供'
  if (cloud < 20) return '云量偏少'
  if (cloud <= 70) return '云量适中'
  return '云层偏厚'
}

function getModelSignal(snapshot) {
  if (!snapshot) return null
  const metrics = getSnapshotMetrics(snapshot)
  const cloud = metrics.totalCloud
  const precipitation = metrics.precipitation
  if (!Number.isFinite(cloud) || !Number.isFinite(precipitation)) return null
  return {
    cloud: Math.round(Math.max(0, Math.min(100, cloud))),
    precipitation: Math.max(0, precipitation),
    cloudLabel: cloudLabel(cloud),
    hasRain: precipitation > 0.2
  }
}

function buildMetricComparison(ecSnapshot, gfsSnapshot) {
  const ecMetrics = getSnapshotMetrics(ecSnapshot)
  const gfsMetrics = getSnapshotMetrics(gfsSnapshot)
  return NUMERIC_METRICS.map((definition) => {
    const ec = ecMetrics[definition.key]
    const gfs = gfsMetrics[definition.key]
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      ec,
      gfs,
      ecText: formatMetricValue(ec, definition.unit),
      gfsText: formatMetricValue(gfs, definition.unit),
      bothAvailable: Number.isFinite(ec) && Number.isFinite(gfs)
    }
  }).filter((item) => Number.isFinite(item.ec) || Number.isFinite(item.gfs))
}

function buildModelExplanation(ecSnapshot, gfsSnapshot) {
  const ec = getSnapshotMetrics(ecSnapshot)
  const gfs = getSnapshotMetrics(gfsSnapshot)
  const metrics = buildMetricComparison(ecSnapshot, gfsSnapshot)
  const favorable = []
  const attention = []
  const both = (key) => Number.isFinite(ec[key]) && Number.isFinite(gfs[key])
  const average = (key) => (ec[key] + gfs[key]) / 2

  if (both('totalCloud')) {
    const cloud = average('totalCloud')
    if (cloud >= 20 && cloud <= 70) favorable.push('两套模式的总云量处于适中范围，云层条件相对均衡。')
    else if (cloud < 20) attention.push('两套模式均提示总云量偏少，天空色彩层次可能有限。')
    else attention.push('两套模式均提示云层偏厚，日出或日落光线可能被遮挡。')
  }

  if (both('precipitation')) {
    if (Math.max(ec.precipitation, gfs.precipitation) > 0.2) attention.push('模式数值存在降水信号，云层与光照变化的不确定性会增加。')
    else favorable.push('两套模式均未给出明显降水信号，观赏时段的天气条件相对稳定。')
  }

  if (both('lowCloud')) {
    const lowCloud = average('lowCloud')
    if (lowCloud > 60) attention.push('低云数值偏高，靠近地平线的光线可能更容易受遮挡。')
    else if (lowCloud <= 35) favorable.push('低云数值不高，低空方向的遮挡信号相对较弱。')
  }

  if (both('midCloud') && both('highCloud')) {
    const upperCloud = (average('midCloud') + average('highCloud')) / 2
    if (upperCloud >= 15 && upperCloud <= 75) favorable.push('中高层云量信号存在且不过密，可作为观察天空层次的参考。')
    else if (upperCloud < 15) attention.push('中高层云量信号偏弱，天空层次变化可能不明显。')
    else attention.push('中高层云量偏多，光线穿透和色彩层次可能受影响。')
  }

  if (both('humidity')) {
    const humidity = average('humidity')
    if (humidity >= 85) attention.push('相对湿度偏高，空气通透感可能下降。')
    else if (humidity <= 70) favorable.push('相对湿度适中，通透条件的数值信号较平稳。')
  }

  if (both('visibility')) {
    const visibility = average('visibility')
    if (visibility < 10) attention.push('模式能见度偏低，远处天空层次可能不够清晰。')
    else if (visibility >= 15) favorable.push('模式能见度较好，远处天空轮廓的可见性相对有利。')
  }

  const fullCore = both('totalCloud') && both('precipitation')
  return {
    available: metrics.length > 0,
    label: fullCore ? '数值已同步' : '部分同步',
    summary: fullCore
      ? '以下解读基于同一观赏时段的 EC / GFS 数值预报，仅用于解释当前条件。'
      : '部分数值字段尚未同步，以下仅展示已获得的 EC / GFS 模型参考。',
    favorable,
    attention,
    metrics
  }
}

function buildAgreement(ecSnapshot, gfsSnapshot) {
  const ec = getModelSignal(ecSnapshot)
  const gfs = getModelSignal(gfsSnapshot)
  if (!ec || !gfs) {
    return {
      level: 'unavailable',
      label: '数据不足',
      message: '需同时同步 EC 与 GFS 的云量和预报降水数据，才能判断模式一致性。'
    }
  }

  const cloudDifference = Math.abs(ec.cloud - gfs.cloud)
  const sameRainSignal = ec.hasRain === gfs.hasRain
  const sameCloudBand = ec.cloudLabel === gfs.cloudLabel
  let level = 'low'
  let label = '分歧较大'
  if (cloudDifference <= 15 && sameRainSignal) {
    level = 'high'
    label = '较一致'
  } else if (cloudDifference <= 30 && (sameRainSignal || sameCloudBand)) {
    level = 'medium'
    label = '存在差异'
  }

  const rainText = ec.hasRain ? '存在降水信号' : '暂无明显降水信号'
  const message = level === 'high'
    ? `两种模式云量接近（相差 ${cloudDifference}%），且均判断${rainText}。`
    : level === 'medium'
      ? `两种模式云量相差 ${cloudDifference}% 或降水判断略有不同，建议临近时段再次查看。`
      : `两种模式对云量或降水的判断差异较大（云量相差 ${cloudDifference}%），本次霞况不确定性较高。`
  return { level, label, message, cloudDifference, ec, gfs }
}

function normalizeSnapshot(snapshot, source, targetAt) {
  if (!snapshot) return emptyModel(source, targetAt)
  const validAt = timestamp(snapshot.validAt || snapshot.targetAt)
  const runAt = timestamp(snapshot.runAt || snapshot.updatedAt || snapshot.createdAt)
  const imageValidAt = timestamp(snapshot.imageValidAt)
  const imageRunAt = timestamp(snapshot.imageRunAt)
  const imageFileId = snapshot.imageFileId || snapshot.imageFileID || ''
  const imageUrl = snapshot.imageUrl || ''
  const imageFeatures = snapshot.imageFeatures && typeof snapshot.imageFeatures === 'object'
    ? snapshot.imageFeatures
    : null
  const signal = getModelSignal(snapshot)
  const metrics = getSnapshotMetrics(snapshot)
  const hasImage = Boolean(imageFileId || imageUrl)
  const hasImageFeature = Boolean(imageFeatures && Number.isFinite(Number(imageFeatures.colorPotential)))

  if (!hasImage && !signal) return emptyModel(source, targetAt, '该模式尚未同步云量图或数值信号')
  return {
    source,
    name: source === 'EC' ? 'EC' : 'GFS',
    available: true,
    status: hasImage || hasImageFeature ? 'available' : 'partial',
    statusText: hasImage ? '已同步' : hasImageFeature ? '云图色阶已同步' : '图卡待同步',
    runAt,
    validAt,
    runAtText: formatChinaTime(runAt),
    validAtText: formatChinaTime(validAt),
    imageRunAt,
    imageValidAt,
    imageRunAtText: imageRunAt ? formatChinaTime(imageRunAt) : '',
    imageValidAtText: imageValidAt ? formatChinaTime(imageValidAt) : '',
    imageFileId,
    imageUrl,
    imageFeatures,
    cloud: signal ? signal.cloud : null,
    precipitation: signal ? signal.precipitation : null,
    cloudText: signal ? signal.cloudLabel : '未提供云量数据',
    rainText: signal ? (signal.hasRain ? '有降水信号' : '暂无明显降水') : '未提供降水数据',
    metrics,
    reason: snapshot.note || '云量图仅供模式趋势参考，请结合本地天气预报判断。'
  }
}

function buildModelReferenceFromSnapshots({ city, targetAt, scene, ecSnapshot, gfsSnapshot }) {
  const models = [
    normalizeSnapshot(ecSnapshot, 'EC', targetAt),
    normalizeSnapshot(gfsSnapshot, 'GFS', targetAt)
  ]
  const agreement = buildAgreement(ecSnapshot, gfsSnapshot)
  const explanation = buildModelExplanation(ecSnapshot, gfsSnapshot)
  const availableCount = models.filter((item) => item.available).length
  const imageCount = models.filter((item) => item.imageFileId || item.imageUrl).length
  const imageFeatureCount = models.filter((item) => item.imageFeatures && Number.isFinite(Number(item.imageFeatures.colorPotential))).length

  return {
    city,
    scene: scene || '',
    targetAt: timestamp(targetAt),
    targetAtText: formatChinaTime(targetAt),
    models,
    availableCount,
    state: availableCount === 2 ? 'ready' : availableCount ? 'partial' : 'unavailable',
    agreement,
    explanation,
    note: imageCount
      ? '模式云量图用于观察云系趋势；EC / GFS 原始数值已参与霞况评分与出现概率计算。'
      : imageFeatureCount
        ? '已读取 EC / GFS 云图色阶特征，并作为火烧云鲜艳度的辅助信号；它不是实际天空 RGB 颜色。'
      : availableCount
        ? 'EC / GFS 数值信号已同步，云量图仍在同步中；当前评分已融合原始模型特征。'
        : 'EC / GFS 模式数据正在同步中，当前仅使用本地逐小时预报。',
    attribution: 'EC 数据基于 ECMWF 预报产品；GFS 数据基于 NOAA/NCEP 预报产品。'
  }
}

module.exports = { buildModelReferenceFromSnapshots, buildAgreement, buildModelExplanation }
