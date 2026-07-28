const { getNationalCityOverview } = require('../../services/weather')

Page({
  data: {
    map: null,
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    this.city = decodeURIComponent(options.city || '')
    this.scene = decodeURIComponent(options.scene || '')
    this.targetAt = Number(options.targetAt)
    wx.setNavigationBarTitle({ title: '全国城市霞况概览' })
    this.loadMap()
  },

  onPullDownRefresh() {
    this.loadMap(true)
  },

  loadMap(fromPullDown = false) {
    this.setData({ loading: !fromPullDown, loadError: '' })
    getNationalCityOverview(this.city, { scene: this.scene, targetAt: this.targetAt })
      .then((map) => this.setData({ map, loading: false }))
      .catch(() => this.setData({
        loading: false,
        loadError: '全国城市霞况概览暂时无法获取，请稍后重试。'
      }))
      .finally(() => {
        if (fromPullDown) wx.stopPullDownRefresh()
      })
  },

  retry() {
    this.loadMap()
  }
})
