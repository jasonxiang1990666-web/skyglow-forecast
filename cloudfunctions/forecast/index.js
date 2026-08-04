const cloud = require('wx-server-sdk')
const { lookupCity, lookupCoordinates, searchCities, getWeather, getTwoWeekWeather, getAirQuality, getAlerts } = require('./qweather')
const { buildForecastView, buildTwoWeekForecastView } = require('./scoring')
const { buildNationalCityOverview } = require('./national-overview')
const { getNearbyViewingSpots } = require('./places')
const { getFeaturedViewingSpots, getFeaturedViewingSpot } = require('./featured-spots')
const { getLiveModelReferences } = require('./model-live')
const { getCalibrationProfile } = require('./calibration')

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

  const [{ hourly, daily }, alerts, airQuality] = await Promise.all([
    getWeather(location.id),
    getAlerts(location.lat, location.lon),
    getAirQuality(location.lat, location.lon)
  ])
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
  return buildForecastView({ city: resolvedCity, locationLabel, hourly, daily, alerts, airQuality, now, modelReferences, calibrationProfile })
}
