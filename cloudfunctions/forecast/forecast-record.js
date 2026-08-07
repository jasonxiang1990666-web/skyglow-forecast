function buildForecastId({ cityCode, sceneType, observationDate, windowStart, algorithmVersion }) {
  return [cityCode, sceneType, observationDate, windowStart, algorithmVersion].join('|')
}

function locationGrid(latitude, longitude) {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return ''
  const lat = Number(latitude)
  const lon = Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return ''
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}

function forecastConfidence(confidence = {}) {
  return {
    ...confidence,
    level: confidence.level || 'low',
    reasons: Array.isArray(confidence.reasons) ? confidence.reasons : [],
    ecStatus: confidence.ecStatus || 'missing',
    gfsStatus: confidence.gfsStatus || 'missing',
    modelAgreement: confidence.modelAgreement || 'unavailable'
  }
}

function coordinateValues(coordinates = {}) {
  if (Array.isArray(coordinates)) return { latitude: coordinates[0], longitude: coordinates[1] }
  return {
    latitude: coordinates.latitude,
    longitude: coordinates.longitude
  }
}

function enrichForecastWindows({ forecast = {}, location = {}, coordinates, confidenceByKind = {}, weatherUpdatedAt } = {}) {
  const cityCode = String(location.id || '')
  const cityName = String(forecast.city || location.adm2 || location.name || '')
  const districtName = String(location.name || '')
  const { latitude, longitude } = coordinateValues(coordinates)
  const grid = locationGrid(latitude, longitude)
  const algorithmVersion = String(forecast.scoringVersion || '')
  const records = []
  const windows = Array.isArray(forecast.skyWindows) ? forecast.skyWindows : []
  const enrichedWindows = windows.map((window) => {
    const confidence = forecastConfidence(confidenceByKind[window.kind])
    const observationDate = String(window.date || '')
    const windowStart = Number(window.startAt)
    const windowEnd = Number(window.endAt)
    const primarySky = window.primarySky || (Array.isArray(window.skies) ? window.skies[0] : {}) || {}
    const fireCloud = window.fireCloud || (Array.isArray(window.skies) ? window.skies[1] : {}) || {}

    const enrichScene = (sceneType, sky) => {
      const forecastId = buildForecastId({ cityCode, sceneType, observationDate, windowStart, algorithmVersion })
      const record = {
        forecastId,
        cityCode,
        cityName,
        districtName,
        locationGrid: grid,
        sceneType,
        observationDate,
        windowStart,
        windowEnd,
        score: sky.score,
        probability: sky.probability,
        vividnessLevel: sky.vividnessLevel || null,
        confidenceLevel: confidence.level,
        confidenceReasons: confidence.reasons,
        weatherUpdatedAt: Number.isFinite(weatherUpdatedAt) ? weatherUpdatedAt : null,
        ecStatus: confidence.ecStatus,
        ecValidAt: Number.isFinite(confidence.ecValidAt) ? confidence.ecValidAt : null,
        gfsStatus: confidence.gfsStatus,
        gfsValidAt: Number.isFinite(confidence.gfsValidAt) ? confidence.gfsValidAt : null,
        modelAgreement: confidence.modelAgreement,
        algorithmVersion
      }
      records.push(record)
      return {
        ...sky,
        forecastId,
        forecastConfidence: confidence
      }
    }

    const enrichedPrimary = enrichScene(window.kind || '', primarySky)
    const enrichedFireCloud = enrichScene('fireCloud', fireCloud)
    return {
      ...window,
      primarySky: enrichedPrimary,
      fireCloud: enrichedFireCloud,
      hero: window.hero ? { ...window.hero, forecastId: enrichedPrimary.forecastId, forecastConfidence: confidence } : window.hero,
      skies: [enrichedPrimary, enrichedFireCloud],
      secondarySkies: [enrichedFireCloud]
    }
  })

  return {
    forecast: {
      ...forecast,
      skyWindows: enrichedWindows,
      primaryWindow: enrichedWindows[0] || forecast.primaryWindow,
      secondaryWindow: enrichedWindows[1] || forecast.secondaryWindow
    },
    records
  }
}

async function persistForecastRecords(db, records) {
  if (!db || !Array.isArray(records) || !records.length) return []
  try {
    const collection = db.collection('forecastRecords')
    return await Promise.all(records.map(async (record) => {
      try {
        const existing = await collection.where({ forecastId: record.forecastId }).limit(1).get()
        const prior = Array.isArray(existing.data) ? existing.data[0] : null
        if (prior && prior._id) return collection.doc(prior._id).update({ data: record })
        return collection.add({ data: record })
      } catch (error) {
        console.warn('forecast record persistence failed', error)
        return null
      }
    }))
  } catch (error) {
    console.warn('forecast record persistence failed', error)
    return []
  }
}

module.exports = { buildForecastId, locationGrid, enrichForecastWindows, persistForecastRecords }
