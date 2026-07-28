const cloud = require('wx-server-sdk')
const { lookupCity, lookupCoordinates, searchCities, getWeather, getTwoWeekWeather, getAirQuality, getAlerts } = require('./qweather')
const { buildForecastView, buildTwoWeekForecastView } = require('./scoring')
const { buildNationalCityOverview } = require('./national-overview')
const { getNearbyViewingSpots } = require('./places')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function nextChinaDayStart() {
  const offset = 8 * 60 * 60 * 1000
  const chinaDate = new Date(Date.now() + offset).toISOString().slice(0, 10)
  const nextDate = new Date(`${chinaDate}T00:00:00+08:00`)
  return new Date(nextDate.getTime() + 24 * 60 * 60 * 1000)
}

exports.main = async (event) => {
  if (event.action === 'resolveLocation') {
    const location = await lookupCoordinates(event.latitude, event.longitude)
    return { city: location.adm2 || location.name }
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

  const city = String(event.city || '').trim()
  if (!city) throw new Error('缺少城市参数')

  if (event.action === 'nationalCityOverview') {
    return buildNationalCityOverview({
      targetAt: event.targetAt,
      scene: event.scene
    })
  }

  const location = await lookupCity(city)
  if (event.action === 'twoWeekForecast') {
    const { hourly, daily } = await getTwoWeekWeather(location.id)
    return buildTwoWeekForecastView({ city: location.name, hourly, daily })
  }

  const [{ hourly, daily }, alerts, airQuality] = await Promise.all([
    getWeather(location.id),
    getAlerts(location.lat, location.lon),
    getAirQuality(location.lat, location.lon)
  ])
  const now = event.mode === 'tomorrow' ? nextChinaDayStart() : new Date()
  return buildForecastView({ city: location.name, hourly, daily, alerts, airQuality, now })
}
