const { getFeaturedViewingSpot } = require('../../services/weather')

const FAVORITES_KEY = 'featuredViewingSpotFavorites'

function sceneLabel(scene) {
  return { sunrise: '朝霞', sunset: '晚霞', fireCloud: '火烧云' }[scene] || '霞况'
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function arrivalTip(windowStart) {
  const start = Number(windowStart)
  if (!Number.isFinite(start) || start <= Date.now()) return '建议提前 15 分钟抵达，预留寻找开阔视野的时间。'
  return `建议 ${formatTime(start - 15 * 60 * 1000)} 前抵达，预留寻找开阔视野的时间。`
}

function readFavorites() {
  const value = wx.getStorageSync(FAVORITES_KEY)
  return Array.isArray(value) ? value : []
}

Page({
  data: {
    spot: null,
    city: '',
    scene: '',
    sceneLabel: '',
    arrivalTip: '',
    isFavorite: false,
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    this.id = decodeURIComponent(options.id || '')
    const city = decodeURIComponent(options.city || '')
    const scene = decodeURIComponent(options.scene || '')
    const windowStart = Number(options.windowStart) || 0
    this.setData({ city, scene, sceneLabel: sceneLabel(scene), arrivalTip: arrivalTip(windowStart) })
    this.loadSpot()
  },

  loadSpot() {
    this.setData({ loading: true, loadError: '' })
    getFeaturedViewingSpot(this.id)
      .then((result) => {
        if (!result.spot) throw new Error('观赏点不存在或暂未公开')
        const favorites = readFavorites()
        this.setData({ spot: result.spot, isFavorite: favorites.includes(result.spot.id), loading: false })
        wx.setNavigationBarTitle({ title: result.spot.name })
      })
      .catch((error) => {
        this.setData({ loading: false, loadError: error.message || '暂时无法加载观赏点详情。' })
      })
  },

  toggleFavorite() {
    const spot = this.data.spot
    if (!spot) return
    const favorites = readFavorites()
    const index = favorites.indexOf(spot.id)
    if (index >= 0) favorites.splice(index, 1)
    else favorites.push(spot.id)
    wx.setStorageSync(FAVORITES_KEY, favorites)
    this.setData({ isFavorite: index < 0 })
    wx.showToast({ title: index < 0 ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  navigate() {
    const spot = this.data.spot
    if (!spot || !Number.isFinite(Number(spot.latitude)) || !Number.isFinite(Number(spot.longitude))) return
    wx.openLocation({
      latitude: Number(spot.latitude),
      longitude: Number(spot.longitude),
      name: spot.name,
      address: spot.address || '',
      scale: 17
    })
  },

  onShareAppMessage() {
    const spot = this.data.spot
    if (!spot) return {}
    return {
      title: `${spot.name}｜${this.data.sceneLabel}观赏点`,
      path: `/pages/spot-detail/spot-detail?id=${encodeURIComponent(spot.id)}&city=${encodeURIComponent(this.data.city)}&scene=${encodeURIComponent(this.data.scene)}`
    }
  },

  retry() {
    this.loadSpot()
  }
})
