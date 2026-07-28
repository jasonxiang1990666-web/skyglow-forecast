const CAPITAL_CITIES = [
  { name: '北京', province: '北京市' },
  { name: '长春', province: '吉林省' },
  { name: '长沙', province: '湖南省' },
  { name: '成都', province: '四川省' },
  { name: '重庆', province: '重庆市' },
  { name: '福州', province: '福建省' },
  { name: '广州', province: '广东省' },
  { name: '贵阳', province: '贵州省' },
  { name: '哈尔滨', province: '黑龙江省' },
  { name: '海口', province: '海南省' },
  { name: '杭州', province: '浙江省' },
  { name: '合肥', province: '安徽省' },
  { name: '呼和浩特', province: '内蒙古自治区' },
  { name: '济南', province: '山东省' },
  { name: '昆明', province: '云南省' },
  { name: '兰州', province: '甘肃省' },
  { name: '拉萨', province: '西藏自治区' },
  { name: '南昌', province: '江西省' },
  { name: '南京', province: '江苏省' },
  { name: '南宁', province: '广西壮族自治区' },
  { name: '上海', province: '上海市' },
  { name: '沈阳', province: '辽宁省' },
  { name: '石家庄', province: '河北省' },
  { name: '太原', province: '山西省' },
  { name: '天津', province: '天津市' },
  { name: '乌鲁木齐', province: '新疆维吾尔自治区' },
  { name: '武汉', province: '湖北省' },
  { name: '西安', province: '陕西省' },
  { name: '西宁', province: '青海省' },
  { name: '银川', province: '宁夏回族自治区' },
  { name: '郑州', province: '河南省' }
]

const COMMON_CITIES = [
  { name: '北京', province: '北京市' },
  { name: '上海', province: '上海市' },
  { name: '广州', province: '广东省' },
  { name: '深圳', province: '广东省' },
  { name: '杭州', province: '浙江省' },
  { name: '成都', province: '四川省' }
]

const SEARCH_CITIES = CAPITAL_CITIES.concat(
  COMMON_CITIES.filter((commonCity) => !CAPITAL_CITIES.some((city) => city.name === commonCity.name))
)

function normalizeSearchText(value) {
  return String(value || '').replace(/\s/g, '').replace(/特别行政区|自治区|省|市/g, '')
}

function findLocalCities(query) {
  const normalizedQuery = normalizeSearchText(query)
  return SEARCH_CITIES.filter((city) => {
    const cityFirst = normalizeSearchText(`${city.name}${city.province}`)
    const provinceFirst = normalizeSearchText(`${city.province}${city.name}`)
    return cityFirst.includes(normalizedQuery) || provinceFirst.includes(normalizedQuery)
  })
}

function mergeCities(primary, secondary) {
  const seen = new Set()
  return primary.concat(secondary).filter((city) => {
    const key = city.id || `${city.name}-${city.province}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

Page({
  searchTimer: null,
  searchSequence: 0,

  data: {
    currentCity: '',
    query: '',
    cityOptions: CAPITAL_CITIES,
    commonCities: COMMON_CITIES
  },

  onShow() {
    this.setData({ currentCity: wx.getStorageSync('selectedCity') || getApp().globalData.defaultCity })
  },

  onSearchInput(event) {
    const query = event.detail.value.trim()
    const cityOptions = query ? findLocalCities(query) : CAPITAL_CITIES
    this.setData({ query, cityOptions })

    if (this.searchTimer) clearTimeout(this.searchTimer)
    const sequence = ++this.searchSequence
    if (!query) return

    this.searchTimer = setTimeout(async () => {
      try {
        const response = await wx.cloud.callFunction({
          name: 'forecast',
          data: { action: 'searchCity', keyword: query }
        })
        if (sequence !== this.searchSequence) return
        const remoteCities = (response.result && response.result.cities) || []
        this.setData({ cityOptions: mergeCities(remoteCities, findLocalCities(query)) })
      } catch (error) {
        // 云端搜索不可用时仍保留本地省会城市搜索结果。
      }
    }, 300)
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
  },

  useCurrentLocation() {
    wx.showLoading({ title: '正在定位' })
    wx.getLocation({
      type: 'gcj02',
      success: async ({ latitude, longitude }) => {
        try {
          const response = await wx.cloud.callFunction({
            name: 'forecast',
            data: { action: 'resolveLocation', latitude, longitude }
          })
          const city = response.result && response.result.city
          if (!city) throw new Error('未找到定位城市')
          wx.setStorageSync('selectedCity', city)
          wx.navigateBack()
        } catch (error) {
          wx.showToast({ title: '定位城市失败，可手动选择', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '未获得定位权限，可手动选择', icon: 'none' })
      }
    })
  },

  selectCity(event) {
    const city = event.currentTarget.dataset.city
    wx.setStorageSync('selectedCity', city)
    wx.navigateBack()
  }
})
