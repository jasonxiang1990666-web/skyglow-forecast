const { getFeaturedViewingSpots } = require('../../services/weather')

const FAVORITES_KEY = 'featuredViewingSpotFavorites'

const filters = [
  { key: 'all', label: '全部' },
  { key: 'sunset', label: '晚霞' },
  { key: 'sunrise', label: '朝霞' },
  { key: 'fireCloud', label: '火烧云' },
  { key: 'favorites', label: '我的收藏' }
]

function readFavorites() {
  const value = wx.getStorageSync(FAVORITES_KEY)
  return Array.isArray(value) ? value : []
}

function filterSpots(spots, key, favorites) {
  if (key === 'favorites') return spots.filter((spot) => favorites.includes(spot.id))
  if (key === 'all') return spots
  return spots.filter((spot) => Array.isArray(spot.scenes) && spot.scenes.includes(key))
}

Page({
  data: {
    city: '',
    scene: '',
    windowStart: 0,
    filters,
    activeFilter: 'all',
    spots: [],
    visibleSpots: [],
    loading: true,
    message: ''
  },

  onLoad(options) {
    this.city = decodeURIComponent(options.city || wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity)
    this.scene = decodeURIComponent(options.scene || '')
    this.windowStart = Number(options.windowStart) || 0
    const activeFilter = ['sunset', 'sunrise', 'fireCloud'].includes(this.scene) ? this.scene : 'all'
    this.setData({ city: this.city, scene: this.scene, windowStart: this.windowStart, activeFilter })
    wx.setNavigationBarTitle({ title: `${this.city}观赏点` })
    this.loadSpots()
  },

  onShow() {
    if (this.data.spots.length) this.applyFilter()
  },

  onPullDownRefresh() {
    this.loadSpots(true)
  },

  loadSpots(fromPullDown = false) {
    this.setData({ loading: !fromPullDown, message: '' })
    getFeaturedViewingSpots(this.city)
      .then((result) => {
        this.setData({ spots: result.spots || [], message: result.message || '', loading: false })
        this.applyFilter()
      })
      .catch(() => {
        this.setData({ loading: false, spots: [], visibleSpots: [], message: '精选观赏点暂时无法获取，请稍后重试。' })
      })
      .finally(() => {
        if (fromPullDown) wx.stopPullDownRefresh()
      })
  },

  applyFilter() {
    const favorites = readFavorites()
    const visibleSpots = filterSpots(this.data.spots, this.data.activeFilter, favorites)
      .map((spot) => ({ ...spot, isFavorite: favorites.includes(spot.id) }))
    this.setData({ visibleSpots })
  },

  changeFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.key }, () => this.applyFilter())
  },

  goSpotDetail(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    const query = `id=${encodeURIComponent(id)}&city=${encodeURIComponent(this.city)}&scene=${encodeURIComponent(this.scene)}&windowStart=${this.windowStart}`
    wx.navigateTo({ url: `/pages/spot-detail/spot-detail?${query}` })
  },

  retry() {
    this.loadSpots()
  }
})
