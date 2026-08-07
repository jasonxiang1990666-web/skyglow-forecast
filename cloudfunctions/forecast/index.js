const cloud = require('wx-server-sdk')
const { lookupCity, lookupCoordinates, searchCities, getWeather, getTwoWeekWeather, getAirQuality, getAlerts } = require('./qweather')
const { buildForecastView, buildTwoWeekForecastView } = require('./scoring')
const { buildNationalCityOverview } = require('./national-overview')
const { getNearbyViewingSpots } = require('./places')
const { getFeaturedViewingSpots, getFeaturedViewingSpot } = require('./featured-spots')
const { getLiveModelReferences } = require('./model-live')
const { getCalibrationProfile } = require('./calibration')
const { evaluateForecastConfidence } = require('./confidence')
const { enrichForecastWindows, persistForecastRecords } = require('./forecast-record')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function cityNameFromLocation(location) {
  return String((location && (location.adm2 || location.name)) || '').trim().replace(/市$/, '')
}

function locationLabelFromLocation(location) {
  const city = cityNameFromLocation(location)
  const name = String((location && location.name) || '').trim()
  const normalizedName = name.replace(/市$/, '')
  if (!city) return name
  if (!name || normalizedName === city) return city
  return `${city} · ${name}`
}

function nextChinaDayStart() {
  const offset = 8 * 60 * 60 * 1000
  const chinaDate = new Date(Date.now() + offset).toISOString().slice(0, 10)
  const nextDate = new Date(`${chinaDate}T00:00:00+08:00`)
  return new Date(nextDate.getTime() + 24 * 60 * 60 * 1000)
}

function getModelTargets(daily, now) {
  const horizon = now.getTime() + 24 * 60 * 60 * 1000
  return daily
    .flatMap((day) => ['sunrise', 'sunset'].map((kind) => {
      if (!day[kind]) return null
      const targetAt = new Date(`${day.fxDate}T${day[kind]}:00+08:00`).getTime()
      if (!Number.isFinite(targetAt) || targetAt <= now.getTime() || targetAt >= horizon) return null
      return { kind, targetAt }
    }))
    .filter(Boolean)
    .sort((left, right) => left.targetAt - right.targetAt)
    .slice(0, 2)
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function confidenceModel(modelReference, source) {
  const model = modelReference && Array.isArray(modelReference.models)
    ? modelReference.models.find((item) => item.source === source)
    : null
  const totalCloud = numberOrNull(model && (model.cloud ?? (model.metrics && model.metrics.totalCloud)))
  const precipitation = numberOrNull(model && (model.precipitation ?? (model.metrics && model.metrics.precipitation)))
  return {
    status: Number.isFinite(totalCloud) && Number.isFinite(precipitation) ? 'ready' : 'missing',
    validAt: numberOrNull(model && model.validAt),
    totalCloud,
    precipitation
  }
}

function requiredWeatherFields(hourly, window) {
  const record = (hourly || []).find((item) => {
    const timestamp = new Date(item.fxTime).getTime()
    return timestamp >= window.startAt && timestamp <= window.endAt
  }) || {}
  return [record.temp, record.cloud, record.precip, record.humidity]
}

function confidenceByWindow({ forecast, hourly, modelReferences, weatherUpdatedAt, now }) {
  return (forecast.skyWindows || []).reduce((result, window) => {
    const modelReference = modelReferences[window.kind] || {}
    const ec = confidenceModel(modelReference, 'EC')
    const gfs = confidenceModel(modelReference, 'GFS')
    result[window.kind] = evaluateForecastConfidence({
      now: now.getTime(),
      weatherUpdatedAt,
      requiredWeatherFields: requiredWeatherFields(hourly, window),
      ec,
      gfs
    })
    result[window.kind].ecValidAt = ec.validAt
    result[window.kind].gfsValidAt = gfs.validAt
    return result
  }, {})
}

exports.main = async (event) => {
  if (event.action === 'resolveLocation') {
    const location = await lookupCoordinates(event.latitude, event.longitude)
    return {
      city: cityNameFromLocation(location),
      district: location.name || '',
      locationLabel: locationLabelFromLocation(location)
    }
  }

  if (event.action === 'searchCity') {
    return { cities: await searchCities(event.keyword) }
  }

  if (event.action === 'nearbyViewingSpots') {
    return getNearbyViewingSpots({
      latitude: event.latitude,
      longitude: event.longitude,
      scene: event.scene
    })
  }

  if (event.action === 'featuredViewingSpotDetail') {
    return getFeaturedViewingSpot(event.id)
  }

  if (event.action === 'featuredViewingSpots') {
    return getFeaturedViewingSpots({
      city: event.city,
      scene: event.scene,
      latitude: event.latitude,
      longitude: event.longitude
    })
  }

  const city = String(event.city || '').trim()
  if (!city) throw new Error('缺少城市参数')

  if (event.action === 'nationalCityOverview') {
    return buildNationalCityOverview({
      targetAt: event.targetAt,
      scene: event.scene
    })
  }

  const requestedLatitude = Number(event.latitude)
  const requestedLongitude = Number(event.longitude)
  const hasCoordinates = Number.isFinite(requestedLatitude) && Number.isFinite(requestedLongitude)
  const location = hasCoordinates
    ? await lookupCoordinates(requestedLatitude, requestedLongitude)
    : await lookupCity(city)
  const resolvedCity = cityNameFromLocation(location) || location.name || city
  const locationLabel = hasCoordinates ? locationLabelFromLocation(location) : resolvedCity
  if (event.action === 'twoWeekForecast') {
    const { hourly, daily } = await getTwoWeekWeather(location.id)
    return buildTwoWeekForecastView({ city: resolvedCity, hourly, daily })
  }

  const [weather, alerts, airQuality] = await Promise.all([
    getWeather(location.id),
    getAlerts(location.lat, location.lon),
    getAirQuality(location.lat, location.lon)
  ])
  const { hourly, daily, weatherUpdatedAt } = weather
  const now = event.mode === 'tomorrow' ? nextChinaDayStart() : new Date()
  const modelTargets = getModelTargets(daily, now)
  const modelReferences = await getLiveModelReferences({
    db: cloud.database(),
    city: resolvedCity,
    latitude: hasCoordinates ? requestedLatitude : location.lat,
    longitude: hasCoordinates ? requestedLongitude : location.lon,
    targets: modelTargets
  })
  const calibrationProfile = await getCalibrationProfile(cloud.database(), resolvedCity)
  const view = buildForecastView({ city: resolvedCity, locationLabel, hourly, daily, alerts, airQuality, now, modelReferences, calibrationProfile })
  let enriched = { forecast: view, records: [] }
  try {
    enriched = enrichForecastWindows({
      forecast: view,
      location: { ...location, name: hasCoordinates ? location.name : '' },
      coordinates: hasCoordinates ? { latitude: requestedLatitude, longitude: requestedLongitude } : {},
      confidenceByKind: confidenceByWindow({ forecast: view, hourly, modelReferences, weatherUpdatedAt, now }),
      weatherUpdatedAt
    })
  } catch (error) {
    console.warn('forecast record enrichment failed', error)
  }
  await persistForecastRecords(cloud.database(), enriched.records).catch((error) => console.warn('forecast record persistence failed', error))
  return enriched.forecast
}
