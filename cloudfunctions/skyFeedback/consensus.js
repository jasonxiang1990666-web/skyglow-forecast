const { consensusSeenLevel } = require('./review')

const MIN_DISTINCT_USERS = 3
const MIN_PROVISIONAL_REVIEW_SCORE = 75
const QUERY_PAGE_SIZE = 50
const MAX_NEW_CONTRIBUTORS_PER_TRANSACTION = 45

function strictLevel(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3
    ? value
    : null
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function scopeKey(row) {
  return [
    String(row.forecastId || row.eventKey || ''),
    String(row.sceneType || ''),
    finite(row.windowStart),
    finite(row.windowEnd)
  ].join('|')
}

function candidate(row) {
  if (!row || !row._id || !row.anonymousUserHash) return null
  const approved = row.reviewStatus === 'auto_approved'
  const highTrustProvisional = row.reviewStatus === 'provisional' &&
    typeof row.reviewScore === 'number' &&
    Number.isFinite(row.reviewScore) &&
    row.reviewScore >= MIN_PROVISIONAL_REVIEW_SCORE
  if (!approved && !highTrustProvisional) return null

  const seenLevel = consensusSeenLevel(row)
  if (seenLevel === null) return null
  const suppliedColor = row.colorIntensity !== null && row.colorIntensity !== undefined && row.colorIntensity !== ''
  const colorIntensity = suppliedColor ? strictLevel(row.colorIntensity) : seenLevel
  if (colorIntensity === null) return null

  return {
    row,
    id: String(row._id),
    user: String(row.anonymousUserHash),
    scope: scopeKey(row),
    approved,
    seenLevel,
    colorIntensity
  }
}

function candidateOrder(left, right) {
  if (left.user !== right.user) return left.user.localeCompare(right.user)
  if (left.approved !== right.approved) return left.approved ? -1 : 1
  const scoreDelta = (finite(right.row.reviewScore) || 0) - (finite(left.row.reviewScore) || 0)
  if (scoreDelta) return scoreDelta
  return left.id.localeCompare(right.id)
}

function uniqueCandidates(rows) {
  const seenUsers = new Set()
  return rows
    .map(candidate)
    .filter(Boolean)
    .sort(candidateOrder)
    .filter((item) => {
      if (seenUsers.has(item.user)) return false
      seenUsers.add(item.user)
      return true
    })
}

function roundedAverage(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function clusterOrder(left, right) {
  if (left.length !== right.length) return right.length - left.length
  const leftIds = left.map((item) => item.id).sort().join('|')
  const rightIds = right.map((item) => item.id).sort().join('|')
  return leftIds.localeCompare(rightIds)
}

function consensusCluster(candidates) {
  const clusters = []
  for (let seenFloor = 0; seenFloor <= 3; seenFloor += 1) {
    for (let colorFloor = 0; colorFloor <= 3; colorFloor += 1) {
      const cluster = candidates.filter((item) => (
        item.seenLevel >= seenFloor && item.seenLevel <= seenFloor + 1 &&
        item.colorIntensity >= colorFloor && item.colorIntensity <= colorFloor + 1
      ))
      if (cluster.length >= MIN_DISTINCT_USERS) clusters.push(cluster)
    }
  }
  clusters.sort(clusterOrder)
  return clusters[0] || []
}

function provisionalResult() {
  return {
    formed: false,
    status: 'provisional',
    observationStatus: 'provisional',
    observedLevel: null,
    seenLevel: null,
    colorIntensity: null,
    feedbackIds: [],
    distinctUserCount: 0
  }
}

function buildConsensus(rows = []) {
  const byScope = new Map()
  for (const item of uniqueCandidates(Array.isArray(rows) ? rows : [])) {
    if (!byScope.has(item.scope)) byScope.set(item.scope, [])
    byScope.get(item.scope).push(item)
  }

  const possible = [...byScope.entries()]
    .map(([scope, items]) => ({ scope, cluster: consensusCluster(items) }))
    .filter((item) => item.cluster.length >= MIN_DISTINCT_USERS)
    .sort((left, right) => clusterOrder(left.cluster, right.cluster) || left.scope.localeCompare(right.scope))
  if (!possible.length) return provisionalResult()

  const cluster = possible[0].cluster
  const seenLevel = roundedAverage(cluster.map((item) => item.seenLevel))
  const colorIntensity = roundedAverage(cluster.map((item) => item.colorIntensity))
  const sceneType = String(cluster[0].row.sceneType || '')
  const observedLevel = sceneType === 'fireCloud' ? colorIntensity : seenLevel
  return {
    formed: true,
    status: 'auto_approved',
    observationStatus: seenLevel > 0 ? 'observed' : 'not_observed',
    observedLevel,
    seenLevel,
    colorIntensity,
    feedbackIds: cluster.map((item) => item.id).sort(),
    distinctUserCount: cluster.length
  }
}

function promotableFeedbackIds(rows = []) {
  return buildConsensus(rows).feedbackIds
}

function authoritativeRows(rows, eventKey, forecastRecord) {
  return rows.filter((row) => (
    row &&
    row.eventKey === eventKey &&
    row.forecastId === forecastRecord.forecastId &&
    row.sceneType === forecastRecord.sceneType &&
    Number(row.windowStart) === Number(forecastRecord.windowStart) &&
    Number(row.windowEnd) === Number(forecastRecord.windowEnd)
  ))
}

function observationKey(forecastRecord) {
  return `${forecastRecord.forecastId}|${forecastRecord.sceneType}`
}

function isDocumentNotFound(error) {
  const message = String(error && (error.errMsg || error.message) || error || '')
  return /document with _id .+ does not exist/.test(message)
}

async function getOptionalDocument(reference) {
  try {
    return await reference.get()
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null }
    throw error
  }
}

function buildObservation({ forecastRecord, consensus, rows, reviewedAt }) {
  const promotedRows = rows.filter((row) => consensus.feedbackIds.includes(String(row._id)))
  const reviewScores = promotedRows.map((row) => finite(row.reviewScore)).filter((value) => value !== null)
  const seenLevels = promotedRows.map(consensusSeenLevel).filter((value) => value !== null)
  const colorLevels = promotedRows.map((row) => strictLevel(row.colorIntensity) ?? consensusSeenLevel(row)).filter((value) => value !== null)
  return {
    forecastId: forecastRecord.forecastId,
    cityCode: String(forecastRecord.cityCode || ''),
    cityName: String(forecastRecord.cityName || ''),
    districtName: String(forecastRecord.districtName || ''),
    locationGrid: String(forecastRecord.locationGrid || ''),
    sceneType: forecastRecord.sceneType,
    observationDate: String(forecastRecord.observationDate || ''),
    windowStart: Number(forecastRecord.windowStart),
    windowEnd: Number(forecastRecord.windowEnd),
    observedAt: Number(forecastRecord.windowEnd),
    observationStatus: consensus.observationStatus,
    observedLevel: consensus.observedLevel,
    seenLevel: consensus.seenLevel,
    colorIntensity: consensus.colorIntensity,
    forecastScore: finite(forecastRecord.score),
    forecastProbability: finite(forecastRecord.probability),
    algorithmVersion: String(forecastRecord.algorithmVersion || ''),
    reviewStatus: 'auto_approved',
    reviewScore: reviewScores.length ? roundedAverage(reviewScores) : null,
    reviewScoreTotal: reviewScores.reduce((sum, value) => sum + value, 0),
    reviewScoreCount: reviewScores.length,
    consensusCount: consensus.distinctUserCount,
    seenLevelTotal: seenLevels.reduce((sum, value) => sum + value, 0),
    seenLevelMin: seenLevels.length ? Math.min(...seenLevels) : consensus.seenLevel,
    seenLevelMax: seenLevels.length ? Math.max(...seenLevels) : consensus.seenLevel,
    colorIntensityTotal: colorLevels.reduce((sum, value) => sum + value, 0),
    colorIntensityMin: colorLevels.length ? Math.min(...colorLevels) : consensus.colorIntensity,
    colorIntensityMax: colorLevels.length ? Math.max(...colorLevels) : consensus.colorIntensity,
    source: 'feedback-consensus',
    sourceFeedbackIds: [...consensus.feedbackIds],
    schemaVersion: 2,
    reviewedAt
  }
}

async function registerAccuracyCity(transaction, observation, updatedAt) {
  const cityCode = String(observation && observation.cityCode || '').trim()
  if (!cityCode) return
  const observedAt = finite(observation.observedAt)
  await transaction.collection('accuracyCityRegistry').doc(cityCode).set({
    data: {
      cityCode,
      lastObservedAt: observedAt,
      updatedAt
    }
  })
}

async function readAllPages(collection, query) {
  const rows = []
  let offset = 0
  while (true) {
    const result = await collection
      .where(query)
      .orderBy('_id', 'asc')
      .skip(offset)
      .limit(QUERY_PAGE_SIZE)
      .get()
    const page = Array.isArray(result.data) ? result.data : []
    rows.push(...page)
    if (page.length < QUERY_PAGE_SIZE) return rows
    offset += page.length
  }
}

async function discoverCandidates(db, eventKey) {
  const collection = db.collection('skyFeedback')
  const provisionalQuery = { eventKey, reviewStatus: 'provisional' }
  if (db.command && typeof db.command.gte === 'function') {
    provisionalQuery.reviewScore = db.command.gte(MIN_PROVISIONAL_REVIEW_SCORE)
  }
  const [approved, provisional] = await Promise.all([
    readAllPages(collection, { eventKey, reviewStatus: 'auto_approved' }),
    readAllPages(collection, provisionalQuery)
  ])
  return [...approved, ...provisional].sort((left, right) => String(left._id).localeCompare(String(right._id)))
}

function existingLevel(existing, field, fallback) {
  const value = finite(existing[field])
  return value === null ? fallback : value
}

function mergeObservation({ existing, forecastRecord, newRows, reviewedAt }) {
  const existingIds = Array.isArray(existing.sourceFeedbackIds) ? existing.sourceFeedbackIds.map(String) : []
  const newIds = newRows.map((row) => String(row._id))
  const sourceFeedbackIds = [...new Set([...existingIds, ...newIds])].sort()
  const existingCount = existingIds.length
  const newSeenLevels = newRows.map(consensusSeenLevel)
  const newColorLevels = newRows.map((row) => strictLevel(row.colorIntensity) ?? consensusSeenLevel(row))
  const seenMin = Math.min(
    existingLevel(existing, 'seenLevelMin', existing.seenLevel),
    ...newSeenLevels
  )
  const seenMax = Math.max(
    existingLevel(existing, 'seenLevelMax', existing.seenLevel),
    ...newSeenLevels
  )
  const colorMin = Math.min(
    existingLevel(existing, 'colorIntensityMin', existing.colorIntensity),
    ...newColorLevels
  )
  const colorMax = Math.max(
    existingLevel(existing, 'colorIntensityMax', existing.colorIntensity),
    ...newColorLevels
  )
  if (seenMax - seenMin > 1 || colorMax - colorMin > 1) return null

  const seenLevelTotal = existingLevel(existing, 'seenLevelTotal', existing.seenLevel * existingCount) +
    newSeenLevels.reduce((sum, value) => sum + value, 0)
  const colorIntensityTotal = existingLevel(existing, 'colorIntensityTotal', existing.colorIntensity * existingCount) +
    newColorLevels.reduce((sum, value) => sum + value, 0)
  const consensusCount = sourceFeedbackIds.length
  const seenLevel = Math.round(seenLevelTotal / consensusCount)
  const colorIntensity = Math.round(colorIntensityTotal / consensusCount)
  const observedLevel = forecastRecord.sceneType === 'fireCloud' ? colorIntensity : seenLevel
  const newReviewScores = newRows.map((row) => finite(row.reviewScore)).filter((value) => value !== null)
  const existingReviewScoreCount = existingLevel(
    existing,
    'reviewScoreCount',
    finite(existing.reviewScore) === null ? 0 : existingCount
  )
  const reviewScoreCount = existingReviewScoreCount + newReviewScores.length
  const reviewScoreTotal = existingLevel(
    existing,
    'reviewScoreTotal',
    (finite(existing.reviewScore) || 0) * existingReviewScoreCount
  ) + newReviewScores.reduce((sum, value) => sum + value, 0)
  const consensus = {
    formed: true,
    status: 'auto_approved',
    observationStatus: seenLevel > 0 ? 'observed' : 'not_observed',
    observedLevel,
    seenLevel,
    colorIntensity,
    feedbackIds: sourceFeedbackIds,
    distinctUserCount: consensusCount
  }
  return {
    ...buildObservation({ forecastRecord, consensus, rows: newRows, reviewedAt }),
    reviewScore: reviewScoreCount ? Math.round(reviewScoreTotal / reviewScoreCount) : null,
    reviewScoreTotal,
    reviewScoreCount,
    consensusCount,
    seenLevelTotal,
    seenLevelMin: seenMin,
    seenLevelMax: seenMax,
    colorIntensityTotal,
    colorIntensityMin: colorMin,
    colorIntensityMax: colorMax,
    sourceFeedbackIds
  }
}

async function promoteConsensusBatch({ db, eventKey, forecastRecord } = {}) {
  if (!db || !eventKey || !forecastRecord || forecastRecord.forecastId !== eventKey) {
    return { promoted: false, ...provisionalResult() }
  }

  const rows = authoritativeRows(await discoverCandidates(db, eventKey), eventKey, forecastRecord)
  const consensus = buildConsensus(rows)
  if (!consensus.formed) return { promoted: false, ...consensus }

  let outcome = { promoted: false, ...provisionalResult() }
  await db.runTransaction(async (transaction) => {
    const observationId = observationKey(forecastRecord)
    const observationRef = transaction.collection('skyObservations').doc(observationId)
    const currentResult = await getOptionalDocument(observationRef)
    const existing = currentResult && currentResult.data ? currentResult.data : null
    const existingIds = new Set(existing && Array.isArray(existing.sourceFeedbackIds)
      ? existing.sourceFeedbackIds.map(String)
      : [])
    const newIds = consensus.feedbackIds
      .filter((id) => !existingIds.has(id))
      .slice(0, MAX_NEW_CONTRIBUTORS_PER_TRANSACTION)

    if (existing && !newIds.length) {
      await registerAccuracyCity(transaction, existing, db.serverDate())
      outcome = {
        promoted: true,
        formed: true,
        status: 'auto_approved',
        observationStatus: existing.observationStatus,
        observedLevel: existing.observedLevel,
        seenLevel: existing.seenLevel,
        colorIntensity: existing.colorIntensity,
        feedbackIds: [...existingIds].sort(),
        distinctUserCount: existingIds.size,
        observation: existing
      }
      return outcome
    }

    const feedbackCollection = transaction.collection('skyFeedback')
    const transactionRows = (await Promise.all(newIds.map(async (id) => {
      const result = await feedbackCollection.doc(id).get()
      return result && result.data ? result.data : null
    }))).filter(Boolean)
    const validRows = authoritativeRows(transactionRows, eventKey, forecastRecord).filter((row) => candidate(row))
    if (!existing && buildConsensus(validRows).feedbackIds.length < MIN_DISTINCT_USERS) return outcome
    if (existing && !validRows.length) return outcome

    const reviewedAt = db.serverDate()
    const observation = existing
      ? mergeObservation({ existing, forecastRecord, newRows: validRows, reviewedAt })
      : buildObservation({
        forecastRecord,
        consensus: buildConsensus(validRows),
        rows: validRows,
        reviewedAt
      })
    if (!observation) return outcome

    await Promise.all(validRows.map((row) => feedbackCollection.doc(row._id).update({
      data: {
        reviewStatus: 'auto_approved',
        reviewedAt
      }
    })))
    await observationRef.set({ data: observation })
    await registerAccuracyCity(transaction, observation, reviewedAt)
    outcome = {
      promoted: true,
      formed: true,
      status: 'auto_approved',
      observationStatus: observation.observationStatus,
      observedLevel: observation.observedLevel,
      seenLevel: observation.seenLevel,
      colorIntensity: observation.colorIntensity,
      feedbackIds: [...observation.sourceFeedbackIds],
      distinctUserCount: observation.consensusCount,
      observation
    }
    return outcome
  })
  return outcome
}

module.exports = {
  buildConsensus,
  promotableFeedbackIds,
  promoteConsensusBatch
}
