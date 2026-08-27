const cloud = require('wx-server-sdk')
const { SCENE_TYPES, WINDOW_DAYS, collecting } = require('./metrics')

const DAY = 24 * 60 * 60 * 1000
const CITY_PAGE_SIZE = 100
const MAX_STATS_AGE = 26 * 60 * 60 * 1000

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function fallback(cityCode = '') {
  return {
    cityCode: String(cityCode || '').trim(),
    windowDays: WINDOW_DAYS,
    sunrise: collecting(),
    sunset: collecting(),
    fireCloud: collecting()
  }
}

function statId(cityCode, sceneType) {
  return `${encodeURIComponent(cityCode)}|${sceneType}|${WINDOW_DAYS}d`
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function scoreBinExpression() {
  return {
    $switch: {
      branches: [
        { case: { $and: [{ $gte: ['$forecastScore', 0] }, { $lt: ['$forecastScore', 40] }] }, then: 0 },
        { case: { $and: [{ $gte: ['$forecastScore', 40] }, { $lt: ['$forecastScore', 60] }] }, then: 1 },
        { case: { $and: [{ $gte: ['$forecastScore', 60] }, { $lt: ['$forecastScore', 80] }] }, then: 2 },
        { case: { $and: [{ $gte: ['$forecastScore', 80] }, { $lte: ['$forecastScore', 100] }] }, then: 3 }
      ],
      default: null
    }
  }
}

function observedBinExpression() {
  return {
    $switch: {
      branches: [
        { case: { $in: ['$observedLevel', [0, 1, 2, 3]] }, then: '$observedLevel' },
        { case: { $eq: ['$observedScore', 0] }, then: 0 },
        { case: { $in: ['$observedScore', [1, 2]] }, then: 1 },
        { case: { $eq: ['$observedScore', 3] }, then: 2 },
        { case: { $eq: ['$observedScore', 4] }, then: 3 }
      ],
      default: null
    }
  }
}

function hitExpression() {
  return {
    $cond: [
      { $lte: [{ $abs: { $subtract: ['$forecastBin', '$observedBin'] } }, 1] },
      1,
      0
    ]
  }
}

function sceneCount($, sceneType, field) {
  return $.sum({ $cond: [{ $eq: ['$sceneType', sceneType] }, field, 0] })
}

async function aggregateCityPage(db, now, afterCityCode = '') {
  const command = db && db.command
  const $ = command && command.aggregate
  if (!command || !$ || typeof command.and !== 'function' || typeof command.gte !== 'function' || typeof command.gt !== 'function' || typeof command.in !== 'function' || typeof command.neq !== 'function') {
    throw new Error('database aggregation unavailable')
  }
  const cutoff = now - WINDOW_DAYS * DAY
  const observedAt = command.and(command.gte(cutoff), command.lte(now))
  const observationDate = command.and(command.neq(null), command.neq(''))
  const pipeline = db.collection('skyObservations').aggregate()
    .match({
      cityCode: command.gt(afterCityCode),
      sceneType: command.in(SCENE_TYPES),
      observationDate,
      windowStart: command.neq(null),
      observedAt
    })
    .group({
      _id: {
        cityCode: '$cityCode',
        sceneType: '$sceneType',
        observationDate: '$observationDate',
        windowStart: '$windowStart'
      },
      forecastScore: $.first('$forecastScore'),
      observedLevel: $.first('$observedLevel'),
      observedScore: $.first('$observedScore')
    })
    .project({
      cityCode: '$_id.cityCode',
      sceneType: '$_id.sceneType',
      forecastBin: scoreBinExpression(),
      observedBin: observedBinExpression()
    })
    .match({ forecastBin: command.in([0, 1, 2, 3]), observedBin: command.in([0, 1, 2, 3]) })
    .project({ cityCode: 1, sceneType: 1, hit: hitExpression() })
    .group({
      _id: '$cityCode',
      sunriseSampleCount: sceneCount($, 'sunrise', 1),
      sunriseHitCount: sceneCount($, 'sunrise', '$hit'),
      sunsetSampleCount: sceneCount($, 'sunset', 1),
      sunsetHitCount: sceneCount($, 'sunset', '$hit'),
      fireCloudSampleCount: sceneCount($, 'fireCloud', 1),
      fireCloudHitCount: sceneCount($, 'fireCloud', '$hit')
    })
    .sort({ _id: 1 })
    .limit(CITY_PAGE_SIZE)
  const result = await pipeline.end()
  return result && Array.isArray(result.data) ? result.data : []
}

function metricFromCounts(sampleCount, hitCount) {
  const samples = finite(sampleCount)
  const hits = finite(hitCount)
  if (!Number.isInteger(samples) || samples < 0 || !Number.isInteger(hits) || hits < 0 || hits > samples) return collecting()
  return {
    sampleCount: samples,
    hitCount: hits,
    accuracyRate: samples >= 30 ? hits / samples : null,
    windowDays: WINDOW_DAYS,
    status: samples >= 30 ? 'ready' : 'collecting'
  }
}

function metricsFromCityAggregate(row) {
  return {
    sunrise: metricFromCounts(row && row.sunriseSampleCount, row && row.sunriseHitCount),
    sunset: metricFromCounts(row && row.sunsetSampleCount, row && row.sunsetHitCount),
    fireCloud: metricFromCounts(row && row.fireCloudSampleCount, row && row.fireCloudHitCount)
  }
}

async function writeCityStats(db, cityCode, metrics, now) {
  const updatedAt = typeof db.serverDate === 'function' ? db.serverDate() : Date.now()
  await Promise.all(SCENE_TYPES.map((sceneType) => db.collection('accuracyStats').doc(statId(cityCode, sceneType)).set({
    data: {
      cityCode,
      sceneType,
      period: '30d',
      ...metrics[sceneType],
      coverageStart: now - WINDOW_DAYS * DAY,
      coverageEnd: now,
      updatedAt
    }
  })))
}

async function aggregateAllActiveCities(db, now = Date.now()) {
  const summaries = []
  let afterCityCode = ''
  while (true) {
    const page = await aggregateCityPage(db, now, afterCityCode)
    if (!page.length) break
    for (const row of page) {
      const cityCode = String(row && row._id || '').trim()
      if (!cityCode || cityCode <= afterCityCode) throw new Error('invalid city aggregation cursor')
      const metrics = metricsFromCityAggregate(row)
      await writeCityStats(db, cityCode, metrics, now)
      summaries.push({ cityCode, ...metrics })
      afterCityCode = cityCode
    }
    if (page.length < CITY_PAGE_SIZE) break
  }
  return { ok: true, cityCount: summaries.length, cities: summaries }
}

function hasCurrentCoverage(stat, now) {
  const coverageStart = finite(stat && stat.coverageStart)
  const coverageEnd = finite(stat && stat.coverageEnd)
  if (coverageStart === null || coverageEnd === null || coverageEnd > now || now - coverageEnd > MAX_STATS_AGE) return false
  return coverageStart <= coverageEnd - WINDOW_DAYS * DAY
}

function metricFromStat(stat, now) {
  const sampleCount = Number(stat && stat.sampleCount)
  const hitCount = Number(stat && stat.hitCount)
  const validCounts = Number.isInteger(sampleCount) && sampleCount >= 0 && Number.isInteger(hitCount) && hitCount >= 0 && hitCount <= sampleCount
  if (!validCounts || Number(stat.windowDays) !== WINDOW_DAYS || !hasCurrentCoverage(stat, now)) return null
  const accuracyRate = sampleCount >= 30 && typeof stat.accuracyRate === 'number' && Number.isFinite(stat.accuracyRate)
    ? stat.accuracyRate
    : null
  return {
    sampleCount,
    hitCount,
    accuracyRate,
    windowDays: WINDOW_DAYS,
    status: sampleCount >= 30 && accuracyRate !== null ? 'ready' : 'collecting'
  }
}

async function getCityAccuracy(db, cityCode, now = Date.now()) {
  const code = String(cityCode || '').trim()
  const result = fallback(code)
  if (!code) return result
  try {
    const query = await db.collection('accuracyStats').where({ cityCode: code, windowDays: WINDOW_DAYS }).limit(SCENE_TYPES.length).get()
    for (const stat of (query && Array.isArray(query.data) ? query.data : [])) {
      const sceneType = String(stat && stat.sceneType || '')
      const metric = metricFromStat(stat, now)
      if (SCENE_TYPES.includes(sceneType) && metric) result[sceneType] = metric
    }
    return result
  } catch (error) {
    console.warn('city accuracy lookup failed', error)
    return result
  }
}

async function main(event = {}) {
  let db
  try {
    db = cloud.database()
    if ((event.action || 'getCityAccuracy') === 'aggregate') {
      try {
        return await aggregateAllActiveCities(db)
      } catch (error) {
        console.warn('city accuracy aggregation failed', error)
        return { ok: false, cityCount: 0, cities: [] }
      }
    }
    if (event.action === 'getCityAccuracy' || !event.action) return await getCityAccuracy(db, event.cityCode)
    return fallback(event.cityCode)
  } catch (error) {
    console.warn('city accuracy database unavailable', error)
    return fallback(event.cityCode)
  }
}

module.exports = { main, aggregateAllActiveCities, aggregateCityPage, getCityAccuracy, fallback, statId }
