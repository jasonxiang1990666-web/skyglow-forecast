const cloud = require('wx-server-sdk')
const { SCENE_TYPES, WINDOW_DAYS, aggregateAccuracy, collecting } = require('./metrics')

const PAGE_SIZE = 100
const DAY = 24 * 60 * 60 * 1000

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

async function readPages(collection, query) {
  const rows = []
  let skip = 0
  while (true) {
    const result = await collection.where(query).orderBy('windowStart', 'desc').skip(skip).limit(PAGE_SIZE).get()
    const page = result && Array.isArray(result.data) ? result.data : []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    skip += page.length
  }
}

function recentQuery(db, cutoff) {
  if (!db || !db.command || typeof db.command.gte !== 'function') throw new Error('database range query unavailable')
  return db.command.gte(cutoff)
}

async function activeCityCodes(db, cutoff) {
  const rows = await readPages(db.collection('skyObservations'), { windowStart: recentQuery(db, cutoff) })
  return [...new Set(rows.map((row) => String(row && row.cityCode || '').trim()).filter(Boolean))]
}

async function cityObservations(db, cityCode, cutoff) {
  return readPages(db.collection('skyObservations'), {
    cityCode,
    windowStart: recentQuery(db, cutoff)
  })
}

async function writeCityStats(db, cityCode, metrics) {
  const updatedAt = typeof db.serverDate === 'function' ? db.serverDate() : Date.now()
  await Promise.all(SCENE_TYPES.map((sceneType) => db.collection('accuracyStats').doc(statId(cityCode, sceneType)).set({
    data: {
      cityCode,
      sceneType,
      period: '30d',
      ...metrics[sceneType],
      updatedAt
    }
  })))
}

async function aggregateAllActiveCities(db, now = Date.now()) {
  const cutoff = now - WINDOW_DAYS * DAY
  const cityCodes = await activeCityCodes(db, cutoff)
  const summaries = []
  for (const cityCode of cityCodes) {
    const metrics = aggregateAccuracy(await cityObservations(db, cityCode, cutoff), now)
    await writeCityStats(db, cityCode, metrics)
    summaries.push({ cityCode, ...metrics })
  }
  return { ok: true, cityCount: cityCodes.length, cities: summaries }
}

function metricFromStat(stat) {
  const sampleCount = Number(stat && stat.sampleCount)
  const hitCount = Number(stat && stat.hitCount)
  const validCounts = Number.isInteger(sampleCount) && sampleCount >= 0 && Number.isInteger(hitCount) && hitCount >= 0 && hitCount <= sampleCount
  if (!validCounts || Number(stat.windowDays) !== WINDOW_DAYS) return null
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

async function getCityAccuracy(db, cityCode) {
  const code = String(cityCode || '').trim()
  const result = fallback(code)
  if (!code) return result
  try {
    const query = await db.collection('accuracyStats').where({ cityCode: code, windowDays: WINDOW_DAYS }).limit(SCENE_TYPES.length).get()
    for (const stat of (query && Array.isArray(query.data) ? query.data : [])) {
      const sceneType = String(stat && stat.sceneType || '')
      const metric = metricFromStat(stat)
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

module.exports = { main, aggregateAllActiveCities, getCityAccuracy, fallback, statId }
