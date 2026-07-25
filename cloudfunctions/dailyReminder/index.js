const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const TEMPLATE_ID = 'C7KsBELQ6RneIUbptlCEoNPvg5B9tHOY5nCkhTOpQG4'

function tomorrowText() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  date.setUTCDate(date.getUTCDate() + 1)
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
}

function bestSky(forecast, onlyHighProbability) {
  const all = (forecast.skyWindows || []).flatMap((window) => window.skies || [])
  const candidates = onlyHighProbability ? all.filter((item) => item.tier === 'high') : all
  return candidates.sort((a, b) => b.score - a.score)[0] || null
}

function buildReminder(forecast, preference) {
  const sky = bestSky(forecast, preference.onlyHighProbability)
  const rain = preference.rainReminder ? forecast.rain && forecast.rain.primary : null
  if (!sky && !rain) return null

  const weather = forecast.trend && forecast.trend[0] ? forecast.trend[0] : {}
  let tip = rain ? '明日有雨，出门记得带伞' : ''
  if (sky) {
    const direction = sky.showDirection && sky.direction ? `，${sky.direction}` : ''
    tip = `${sky.type}${sky.score}%${direction}`
    if (rain) tip = `${sky.type}${sky.score}%，有雨请带伞`
  }

  return {
    date1: { value: tomorrowText() },
    phrase2: { value: preference.city },
    phrase3: { value: String(weather.weather || '天气预报') },
    character_string4: { value: String(weather.temperature || '--') },
    thing5: { value: tip.slice(0, 20) }
  }
}

exports.main = async () => {
  const result = await db.collection('subscriptions')
    .where({ enabled: true, remainingQuota: db.command.gt(0) })
    .limit(100)
    .get()

  const forecasts = new Map()
  const sent = []
  const skipped = []
  const failed = []

  for (const subscription of result.data) {
    try {
      if (!forecasts.has(subscription.city)) {
        const response = await cloud.callFunction({
          name: 'forecast',
          data: { city: subscription.city, mode: 'tomorrow' }
        })
        forecasts.set(subscription.city, response.result)
      }
      const data = buildReminder(forecasts.get(subscription.city), subscription)
      if (!data) {
        skipped.push(subscription._id)
        continue
      }
      await cloud.openapi.subscribeMessage.send({
        touser: subscription.openid,
        templateId: TEMPLATE_ID,
        page: 'pages/index/index',
        data
      })
      await db.collection('subscriptions').doc(subscription._id).update({
        data: { enabled: false, remainingQuota: 0, sentAt: db.serverDate(), updatedAt: db.serverDate() }
      })
      sent.push(subscription._id)
    } catch (error) {
      if (Number(error.errCode) === 43101) {
        await db.collection('subscriptions').doc(subscription._id).update({
          data: { enabled: false, remainingQuota: 0, updatedAt: db.serverDate() }
        })
      }
      failed.push({ id: subscription._id, message: error.message })
    }
  }

  return { checked: result.data.length, sent, skipped, failed }
}
