const SCENE_TYPES = new Set(['sunrise', 'sunset', 'fireCloud'])

function nonEmpty(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim()
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hasCanonicalIdentity({ cityCode, sceneType, observationDate, windowStart, algorithmVersion } = {}) {
  return Boolean(
    nonEmpty(cityCode) &&
    SCENE_TYPES.has(sceneType) &&
    nonEmpty(observationDate) &&
    finiteOrNull(windowStart) !== null &&
    nonEmpty(algorithmVersion)
  )
}

function buildForecastId(identity = {}) {
  if (!hasCanonicalIdentity(identity)) return ''
  const { cityCode, sceneType, observationDate, windowStart, algorithmVersion } = identity
  return [nonEmpty(cityCode), sceneType, nonEmpty(observationDate), Number(windowStart), nonEmpty(algorithmVersion)].join('|')
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
  if (!coordinates || typeof coordinates !== 'object') return { latitude: undefined, longitude: undefined }
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
    const windowStart = finiteOrNull(window.startAt)
    const windowEnd = finiteOrNull(window.endAt)
    const primarySky = window.primarySky || (Array.isArray(window.skies) ? window.skies[0] : {}) || {}
    const fireCloud = window.fireCloud || (Array.isArray(window.skies) ? window.skies[1] : {}) || {}

    const enrichScene = (sceneType, sky) => {
      const forecastId = buildForecastId({ cityCode, sceneType, observationDate, windowStart, algorithmVersion })
      if (!forecastId) {
        return {
          ...sky,
          forecastConfidence: confidence
        }
      }
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
        if (!record) return null
        const canonicalId = buildForecastId(record)
        if (!canonicalId || record.forecastId !== canonicalId) return null
        return collection.doc(record.forecastId).set({ data: record })
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

async function persistForecastRecordsSafely(getDatabase, records) {
  try {
    return await persistForecastRecords(getDatabase(), records)
  } catch (error) {
    console.warn('forecast record persistence failed', error)
    return []
  }
}

module.exports = { buildForecastId, locationGrid, enrichForecastWindows, persistForecastRecords, persistForecastRecordsSafely }
