const { getCityAccuracy } = require('../../services/weather')
const { accuracyCards, accuracyPageState } = require('../../utils/accuracy')

function optionValue(value) {
  try {
    return decodeURIComponent(value || '')
  } catch (error) {
    return ''
  }
}

Page({
  data: {
    cityCode: '',
    cityName: '',
    cards: accuracyCards(),
    loading: true,
    loadError: '',
    viewState: 'loading'
  },

  onLoad(options = {}) {
    this.cityCode = optionValue(options.cityCode)
    this.cityName = optionValue(options.cityName) || wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity
    this.setData({ cityCode: this.cityCode, cityName: this.cityName })
    this.loadAccuracy()
  },

  onPullDownRefresh() {
    this.loadAccuracy(true)
  },

  loadAccuracy(fromPullDown = false) {
    if (!this.cityCode) {
      const metrics = {}
      this.setData({
        cards: accuracyCards(metrics),
        loading: false,
        loadError: '暂时无法识别当前城市，统计数据积累中。',
        viewState: accuracyPageState({ loading: false, metrics, error: true }).status
      })
      if (fromPullDown) wx.stopPullDownRefresh()
      return Promise.resolve()
    }

    if (!fromPullDown) this.setData({ loading: true, loadError: '', viewState: 'loading' })
    return getCityAccuracy(this.cityCode)
      .then((metrics) => {
        const cards = accuracyCards(metrics)
        this.setData({
          cards,
          loading: false,
          loadError: '',
          viewState: accuracyPageState({ loading: false, metrics }).status
        })
      })
      .catch(() => {
        const metrics = {}
        this.setData({
          cards: accuracyCards(metrics),
          loading: false,
          loadError: '暂时无法加载本城市预报表现，统计数据积累中。',
          viewState: accuracyPageState({ loading: false, metrics, error: true }).status
        })
      })
      .finally(() => {
        if (fromPullDown) wx.stopPullDownRefresh()
      })
  },

  retry() {
    this.loadAccuracy()
  }
})
