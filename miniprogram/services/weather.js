const { build24HourView, getTier } = require('../utils/sky-score')
const { USE_CLOUD_FORECAST } = require('../config/runtime')

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('全国城市概览请求超时')), milliseconds)
    promise.then((result) => {
      clearTimeout(timer)
      resolve(result)
    }).catch((error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const demoForecast = {
  date: '接下来24小时',
  updatedAt: '今天 20:00 更新',
  skyWindows: [
    {
      title: '今天傍晚',
      time: '18:49–19:27',
      skies: [
        { type: '晚霞', score: 82, time: '18:49–19:27', reason: '西侧云层条件较好', direction: '面向西侧天空' },
        { type: '火烧云', score: 46, time: '18:55 前后', reason: '色彩强度预计一般', direction: '' }
      ]
    },
    {
      title: '明日清晨',
      time: '05:02–05:38',
      skies: [
        { type: '朝霞', score: 68, time: '05:02–05:38', reason: '东侧云量适中', direction: '' },
        { type: '火烧云', score: 42, time: '05:10 前后', reason: '有机会出现暖色云层', direction: '' }
      ]
    }
  ],
  rain: {
    events: [
      { probability: 70, time: '明日 14:00–17:00', text: '有阵雨，出门建议带伞' }
    ]
  },
  warning: null,
  trend: [
    { day: '明天', weather: '多云', temperature: '26–34℃', precipitation: '30%' },
    { day: '后天', weather: '阵雨', temperature: '25–31℃', precipitation: '75%' },
    { day: '大后天', weather: '晴', temperature: '27–35℃', precipitation: '10%' }
  ]
}

function groupSkyWindows(forecast) {
  const windows = forecast.skyWindows || [forecast.primaryWindow, forecast.secondaryWindow].filter(Boolean)
  const skyWindows = windows.map((skyWindow) => {
    const skies = Array.isArray(skyWindow.skies) ? skyWindow.skies.map((item) => {
      const normalized = {
        ...item,
        probability: Number.isFinite(Number(item.probability)) ? Number(item.probability) : (Number(item.score) || 0)
      }
      if (normalized.tier && normalized.label) return normalized
      const tier = getTier(Number(item.score) || 0)
      return { ...normalized, tier: tier.key, label: tier.label, showDirection: tier.key === 'high' && Boolean(item.direction) }
    }) : []
    const primarySky = skies.find((item) => item.type === '朝霞' || item.type === '晚霞') || skyWindow.primarySky || skyWindow.hero || skies[0]
    const fireCloud = skies.find((item) => item.type === '火烧云') || skyWindow.fireCloud || null
    if (fireCloud && !fireCloud.vividnessLabel) {
      const vividness = Number(fireCloud.vividness)
      const fallbackValue = Number.isFinite(vividness) ? vividness : Number(fireCloud.score || 0) / 100
      const vividnessLevel = fallbackValue >= 1 ? 'large' : fallbackValue >= 0.5 ? 'medium' : fallbackValue >= 0.2 ? 'small' : 'none'
      const vividnessLabel = vividnessLevel === 'large' ? '大烧' : vividnessLevel === 'medium' ? '中烧' : vividnessLevel === 'small' ? '小烧' : '无'
      Object.assign(fireCloud, {
        vividness: Number(fallbackValue.toFixed(2)),
        vividnessText: fallbackValue.toFixed(2),
        vividnessLevel,
        vividnessLabel
      })
    }
    return {
      ...skyWindow,
      skies,
      primarySky,
      fireCloud,
      hero: { ...primarySky, displayTitle: primarySky.displayTitle || primarySky.type },
      secondarySkies: fireCloud ? [fireCloud] : []
    }
  })
  return {
    ...forecast,
    skyWindows,
    primaryWindow: skyWindows[0],
    secondaryWindow: skyWindows[1] || skyWindows[0]
  }
}

function getStoredCoordinates() {
  try {
    const coordinates = wx.getStorageSync('selectedCoordinates')
    if (!coordinates) return null
    const rawLatitude = coordinates.latitude
    const rawLongitude = coordinates.longitude
    // 空字符串会被 Number('') 转成 0，不能把它误判为有效的 0,0 坐标。
    if (rawLatitude === '' || rawLongitude === '' || rawLatitude === null || rawLongitude === null || rawLatitude === undefined || rawLongitude === undefined) {
      return null
    }
    const latitude = Number(rawLatitude)
    const longitude = Number(rawLongitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    if (latitude === 0 && longitude === 0) return null
    return { latitude, longitude }
  } catch (error) {
    return null
  }
}

function getNext24HourForecast(city, options = {}) {
  if (USE_CLOUD_FORECAST) {
    const storedCoordinates = getStoredCoordinates()
    const latitude = Number(options.latitude ?? (storedCoordinates && storedCoordinates.latitude))
    const longitude = Number(options.longitude ?? (storedCoordinates && storedCoordinates.longitude))
    const data = { city }
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0)) {
      data.latitude = latitude
      data.longitude = longitude
    }
    return wx.cloud.callFunction({
      name: 'forecast',
      data
    }).then((response) => {
      if (!response.result || !response.result.primaryWindow) {
        throw new Error('云函数未返回有效预报')
      }
      return groupSkyWindows(response.result)
    })
  }

  // 本地开发阶段使用演示数据，避免未部署云函数时影响页面预览。
  return Promise.resolve({ ...build24HourView(demoForecast), city })
}

function getTwoWeekWeatherForecast(city) {
  if (USE_CLOUD_FORECAST) {
    return wx.cloud.callFunction({
      name: 'forecast',
      data: { action: 'twoWeekForecast', city }
    }).then((response) => {
      if (!response.result || !Array.isArray(response.result.days) || !response.result.days.length) {
        throw new Error('云函数未返回有效的两周天气预报')
      }
      return response.result
    })
  }

  return Promise.resolve({
    city,
    updatedAt: '演示数据',
    days: [
      ['今天', '7月28日', '多云', '29–34℃', 0, '0.0mm'],
      ['明天', '7月29日', '多云', '29–36℃', 10, '0.0mm'],
      ['周三', '7月30日', '小雨', '27–33℃', 65, '4.2mm'],
      ['周四', '7月31日', '阴', '26–31℃', 35, '0.6mm'],
      ['周五', '8月1日', '多云', '27–33℃', 15, '0.0mm'],
      ['周六', '8月2日', '晴', '28–35℃', 5, '0.0mm'],
      ['周日', '8月3日', '晴', '28–36℃', 0, '0.0mm'],
      ['周一', '8月4日', '多云', '27–34℃', null, '0.0mm'],
      ['周二', '8月5日', '小雨', '26–31℃', null, '3.1mm'],
      ['周三', '8月6日', '阴', '25–30℃', null, '1.2mm'],
      ['周四', '8月7日', '多云', '26–32℃', null, '0.0mm'],
      ['周五', '8月8日', '晴', '27–34℃', null, '0.0mm'],
      ['周六', '8月9日', '多云', '28–35℃', null, '0.0mm'],
      ['周日', '8月10日', '晴', '28–35℃', null, '0.0mm']
    ].map(([day, dateText, weather, temperature, probability, precipitationText]) => ({
      day,
      dateText,
      weather,
      temperature,
      probability,
      probabilityText: probability === null ? '暂不提供' : `${probability}%`,
      precipitationText,
      hasRain: (probability || 0) >= 40 || precipitationText !== '0.0mm'
    }))
  })
}

function getNationalCityOverview(city, options = {}) {
  if (USE_CLOUD_FORECAST) {
    return withTimeout(wx.cloud.callFunction({
      name: 'forecast',
      data: {
        action: 'nationalCityOverview',
        city,
        scene: options.scene,
        targetAt: options.targetAt
      }
    }), 15000).then((response) => {
      const result = response.result
      if (!result || !Array.isArray(result.cities) || !result.cities.length) {
        throw new Error('云函数未返回有效的全国城市概览')
      }
      return result
    })
  }

  const levels = ['low', 'medium', 'high', 'medium', 'low', 'medium', 'high']
  const colors = { low: '#aab9c7', medium: '#d6aa59', high: '#c77a3a' }
  return Promise.resolve({
    model: '城市概览',
    title: options.scene === 'sunrise' ? '全国重点城市朝霞概览' : '全国重点城市晚霞概览',
    validAt: '演示时段',
    updatedAt: '演示数据',
    cities: levels.map((level, index) => ({
      name: ['乌鲁木齐', '北京', '西安', '成都', '上海', '广州', '海口'][index],
      left: 24 + index * 8,
      top: 26 + (index % 3) * 17,
      score: level === 'high' ? 74 : level === 'medium' ? 57 : 36,
      key: level,
      label: level === 'high' ? '值得期待' : level === 'medium' ? '不妨看看' : '不太明显',
      color: colors[level]
    })),
    note: '演示重点城市概览；本地逐小时预报优先。'
  })
}

function getNearbyViewingSpots({ latitude, longitude, scene }) {
  return withTimeout(wx.cloud.callFunction({
    name: 'forecast',
    data: {
      action: 'nearbyViewingSpots',
      latitude,
      longitude,
      scene
    }
  }), 9000).then((response) => {
    const result = response.result
    if (!result || !Array.isArray(result.spots)) {
      throw new Error('云函数未返回有效的地点推荐')
    }
    return result
  })
}

function getFeaturedViewingSpots(city, options = {}) {
  return withTimeout(wx.cloud.callFunction({
    name: 'forecast',
    data: {
      action: 'featuredViewingSpots',
      city,
      scene: options.scene || '',
      latitude: options.latitude,
      longitude: options.longitude
    }
  }), 9000).then((response) => {
    const result = response.result
    if (!result || !Array.isArray(result.spots)) {
      throw new Error('云函数未返回有效的精选观赏点')
    }
    return result
  })
}

function getFeaturedViewingSpot(id) {
  return withTimeout(wx.cloud.callFunction({
    name: 'forecast',
    data: { action: 'featuredViewingSpotDetail', id }
  }), 9000).then((response) => {
    if (!response.result) throw new Error('云函数未返回观赏点详情')
    return response.result
  })
}

module.exports = {
  getNext24HourForecast,
  getTwoWeekWeatherForecast,
  getNationalCityOverview,
  getNearbyViewingSpots,
  getFeaturedViewingSpots,
  getFeaturedViewingSpot
}
