const https = require('https')

const MAP_API_HOST = 'https://apis.map.qq.com'
const MAX_DISTANCE_METERS = 10000
const PREFERRED_DISTANCE_METERS = 5000

function getMapKey() {
  return String(process.env.TENCENT_MAP_KEY || '').trim()
}

function requestJson(url, timeout = 5500) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          const payload = JSON.parse(body)
          if (response.statusCode >= 400 || payload.status !== 0) {
            reject(new Error(`腾讯位置服务请求失败：${payload.message || response.statusCode}`))
            return
          }
          resolve(payload)
        } catch (error) {
          reject(new Error('腾讯位置服务返回了无法解析的数据'))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('腾讯位置服务请求超时')))
    request.on('error', reject)
  })
}

function metersBetween(latitudeA, longitudeA, latitudeB, longitudeB) {
  const earthRadius = 6371000
  const toRadians = (value) => value * Math.PI / 180
  const latitudeDelta = toRadians(latitudeB - latitudeA)
  const longitudeDelta = toRadians(longitudeB - longitudeA)
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

function viewingReason(spot, scene) {
  const name = `${spot.title || ''}${spot.category || ''}${spot.address || ''}`
  const direction = scene === 'sunrise' ? '东侧' : '西侧'
  if (/江|河|湖|海|滨|港|湾/.test(name)) return `临水视野通常较开阔，建议留意${direction}天空`
  if (/山|峰|高地|塔|台|阁|楼/.test(name)) return `较高或有观景条件，建议留意${direction}天空`
  if (/观景|景观|瞭望/.test(name)) return `观景点候选，建议确认${direction}是否开阔`
  return `公共开阔地点候选，建议寻找${direction}无遮挡区域`
}

function rankSpot(spot) {
  const name = `${spot.title || ''}${spot.category || ''}`
  let score = 0
  if (/江|河|湖|海|滨|港|湾/.test(name)) score += 36
  if (/山|峰|高地|塔|台|阁|楼/.test(name)) score += 28
  if (/观景|景观|瞭望/.test(name)) score += 24
  if (/公园|绿地|广场/.test(name)) score += 16
  score += Math.max(0, 18 - Math.round(spot.distance / 700))
  if (spot.distance <= PREFERRED_DISTANCE_METERS) score += 18
  return score
}

async function searchNearby(keyword, latitude, longitude) {
  const key = getMapKey()
  const params = new URLSearchParams({
    keyword,
    boundary: `nearby(${latitude},${longitude},${MAX_DISTANCE_METERS})`,
    orderby: '_distance',
    page_size: '20',
    key
  })
  const payload = await requestJson(`${MAP_API_HOST}/ws/place/v1/search?${params.toString()}`)
  return payload.data || []
}

async function getNearbyViewingSpots({ latitude, longitude, scene }) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('定位坐标无效')

  if (!getMapKey()) {
    return {
      enabled: false,
      message: '地点推荐服务尚未配置，请稍后再试。',
      spots: []
    }
  }

  const searches = await Promise.allSettled([
    searchNearby('公园', lat, lng),
    searchNearby('观景', lat, lng)
  ])
  const rawSpots = searches.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  const seen = new Set()
  const spots = rawSpots.map((item) => {
    const spotLat = Number(item.location && item.location.lat)
    const spotLng = Number(item.location && item.location.lng)
    const distance = Number.isFinite(spotLat) && Number.isFinite(spotLng)
      ? metersBetween(lat, lng, spotLat, spotLng)
      : Number(item._distance || item.distance || Infinity)
    return {
      name: item.title || '附近观赏点',
      address: item.address || '',
      category: item.category || '',
      latitude: spotLat,
      longitude: spotLng,
      distance,
      distanceText: distance < 1000 ? `${Math.max(100, Math.round(distance / 100) * 100)}米` : `${(distance / 1000).toFixed(1)}公里`,
      reason: viewingReason(item, scene)
    }
  }).filter((item) => {
    const key = `${item.name}-${item.latitude}-${item.longitude}`
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude) || item.distance > MAX_DISTANCE_METERS || seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => rankSpot(right) - rankSpot(left) || left.distance - right.distance).slice(0, 3)

  if (!spots.length && searches.every((result) => result.status === 'rejected')) {
    console.warn('Nearby POI requests failed', searches.map((result) => result.reason && result.reason.message))
    throw new Error('附近地点暂时无法查询')
  }

  return {
    enabled: true,
    radiusText: '优先5公里内，最多10公里',
    direction: scene === 'sunrise' ? '东侧' : '西侧',
    spots,
    note: '地点来自地图公开 POI；请以现场开放状态、视野与安全情况为准。'
  }
}

module.exports = { getNearbyViewingSpots }
