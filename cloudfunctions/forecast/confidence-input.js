function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function adaptModelReference(modelReference, source) {
  const model = modelReference && Array.isArray(modelReference.models)
    ? modelReference.models.find((item) => item.source === source)
    : null
  const totalCloud = finiteOrNull(model && (model.cloud ?? (model.metrics && model.metrics.totalCloud)))
  const precipitation = finiteOrNull(model && (model.precipitation ?? (model.metrics && model.metrics.precipitation)))
  return {
    status: Number.isFinite(totalCloud) && Number.isFinite(precipitation) ? 'ready' : 'missing',
    validAt: finiteOrNull(model && model.validAt),
    totalCloud,
    precipitation
  }
}

module.exports = { adaptModelReference }
