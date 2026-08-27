const SCENES = [
  { key: 'sunrise', title: '朝霞' },
  { key: 'sunset', title: '晚霞' },
  { key: 'fireCloud', title: '火烧云' }
]

const COLLECTING_DETAIL = '样本积累到 30 条后显示准确率'

function accuracyPresentation(metric) {
  const sampleCount = metric && metric.sampleCount
  const accuracyRate = metric && metric.accuracyRate
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    return { status: 'collecting', value: '数据积累中', detail: COLLECTING_DETAIL }
  }
  if (sampleCount < 30) {
    return { status: 'collecting', value: `已积累 ${sampleCount}/30 条`, detail: COLLECTING_DETAIL }
  }
  if (!Number.isFinite(accuracyRate) || accuracyRate < 0 || accuracyRate > 1) {
    return { status: 'collecting', value: '数据积累中', detail: COLLECTING_DETAIL }
  }
  return { status: 'ready', value: `${Math.round(accuracyRate * 100)}%`, detail: '近 30 天历史命中率' }
}

function accuracyCards(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {}
  return SCENES.map((scene) => ({
    ...scene,
    ...accuracyPresentation(source[scene.key])
  }))
}

function accuracyPageState({ loading, metrics, error } = {}) {
  if (error) return { status: 'error' }
  if (loading) return { status: 'loading' }
  return {
    status: accuracyCards(metrics).some((card) => card.status === 'ready') ? 'ready' : 'collecting'
  }
}

module.exports = { accuracyPresentation, accuracyCards, accuracyPageState }
