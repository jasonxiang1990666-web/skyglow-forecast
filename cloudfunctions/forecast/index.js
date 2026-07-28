const cloud = require('wx-server-sdk')
const { lookupCity, lookupCoordinates, searchCities, getWeather, getAlerts } = require('./qweather')
const { buildForecastView } = require('./scoring')

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

  const city = String(event.city || '').trim()
  if (!city) throw new Error('缺少城市参数')

  const location = await lookupCity(city)
  const [{ hourly, daily }, alerts] = await Promise.all([
    getWeather(location.id),
    getAlerts(location.lat, location.lon)
  ])
  const now = event.mode === 'tomorrow' ? nextChinaDayStart() : new Date()
  return buildForecastView({ city: location.name, hourly, daily, alerts, now })
}
