const cloud = require('wx-server-sdk')

const COLLECTION = 'viewingSpots'

function getDb() {
  return cloud.database()
}

function normalizeCity(value) {
  return String(value || '').trim().replace(/市$/, '')
}

function directionText(directions = []) {
  const labels = {
    east: '东向开阔',
    southeast: '东南向开阔',
    south: '南向开阔',
    southwest: '西南向开阔',
    west: '西向开阔',
    northwest: '西北向开阔'
  }
  return directions.map((item) => labels[item] || item).filter(Boolean).join(' · ')
}

function sceneText(scenes = []) {
  const labels = { sunrise: '朝霞优先', sunset: '晚霞优先', fireCloud: '火烧云' }
  return scenes.map((item) => labels[item] || item).filter(Boolean).join(' · ')
}

function distanceBetween(latitudeA, longitudeA, latitudeB, longitudeB) {
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite)) return null
  const earthRadius = 6371000
  const toRadians = (value) => value * Math.PI / 180
  const latitudeDelta = toRadians(latitudeB - latitudeA)
  const longitudeDelta = toRadians(longitudeB - longitudeA)
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

function formatDistance(distance) {
  if (!Number.isFinite(distance)) return ''
  return distance < 1000 ? `${Math.max(100, Math.round(distance / 100) * 100)}米` : `${(distance / 1000).toFixed(1)}公里`
}

function normalizeSpot(record, { scene, latitude, longitude } = {}) {
  const scenes = Array.isArray(record.scenes) ? record.scenes : []
  const directions = Array.isArray(record.viewDirections) ? record.viewDirections : []
  const spotLatitude = Number(record.latitude)
  const spotLongitude = Number(record.longitude)
  const distance = distanceBetween(Number(latitude), Number(longitude), spotLatitude, spotLongitude)
  const sceneMatched = !scene || scenes.includes(scene) || (scene === 'sunset' && scenes.includes('fireCloud'))

  return {
    id: record._id,
    name: String(record.name || '未命名观赏点'),
    city: String(record.city || ''),
    district: String(record.district || ''),
    address: String(record.address || ''),
    latitude: spotLatitude,
    longitude: spotLongitude,
    type: String(record.type || '开阔观景点'),
    openness: Math.min(5, Math.max(1, Number(record.openness) || 3)),
    scenes,
    sceneText: sceneText(scenes),
    viewDirections: directions,
    directionText: directionText(directions),
    tips: String(record.tips || '请以现场视野、开放状态和安全情况为准。'),
    safetyNotice: String(record.safetyNotice || ''),
    verifiedAt: String(record.verifiedAt || ''),
    distance,
    distanceText: formatDistance(distance),
    sceneMatched
  }
}

function sortSpots(left, right) {
  const leftDistance = Number.isFinite(left.distance) ? left.distance : Number.MAX_SAFE_INTEGER
  const rightDistance = Number.isFinite(right.distance) ? right.distance : Number.MAX_SAFE_INTEGER
  return Number(right.sceneMatched) - Number(left.sceneMatched)
    || right.openness - left.openness
    || leftDistance - rightDistance
}

async function getFeaturedViewingSpots({ city, scene, latitude, longitude }) {
  const cityKey = normalizeCity(city)
  if (!cityKey) throw new Error('缺少城市参数')

  try {
    const response = await getDb().collection(COLLECTION).where({
      cityKey,
      status: 'published'
    }).limit(100).get()
    const spots = (response.data || [])
      .map((record) => normalizeSpot(record, { scene, latitude, longitude }))
      .sort(sortSpots)

    return {
      enabled: true,
      city: cityKey,
      spots,
      message: spots.length ? '' : `${cityKey}的精选观赏点正在整理中，可先查看附近开阔地点。`
    }
  } catch (error) {
    // 首次上线时集合可能尚未创建；用户端仍可使用腾讯地图附近地点推荐。
    console.warn('Featured viewing spots unavailable', error.message)
    return {
      enabled: false,
      city: cityKey,
      spots: [],
      message: `${cityKey}的精选观赏点正在整理中，可先查看附近开阔地点。`
    }
  }
}

async function getFeaturedViewingSpot(id) {
  if (!id) throw new Error('缺少观赏点参数')
  try {
    const response = await getDb().collection(COLLECTION).doc(String(id)).get()
    const record = response.data
    if (!record || record.status !== 'published') return { spot: null }
    return { spot: normalizeSpot(record) }
  } catch (error) {
    console.warn('Featured viewing spot detail unavailable', error.message)
    return { spot: null }
  }
}

module.exports = { getFeaturedViewingSpots, getFeaturedViewingSpot }
