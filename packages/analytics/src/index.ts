/**
 * @parcae/analytics — public surface
 *
 * Event-stream + snapshot rollups, contracts, detectors, story
 * projection. Apps import from here only.
 */

export { Period, type Grain } from "./period.js";

export {
  metric,
  setEventEmitter,
  getEventEmitter,
  type AnalyticsEvent,
  type EventCaptureSpec,
  type EventEmitter,
  type EventSource,
} from "./event.js";

export {
  ensureAnalyticsTables,
  installAnalytics,
  createKnexEmitter,
  canonicalDimensions,
  ANALYTICS_EVENT_TABLE,
  ANALYTICS_SNAPSHOT_TABLE,
} from "./schema.js";

export {
  Metric,
  registerMetric,
  getMetric,
  listMetrics,
  clearMetrics,
  runMetric,
  runMetrics,
  readLatestSnapshot,
  readSnapshotSeries,
  setMaxMetadataBytes,
  getMaxMetadataBytes,
  type MetricContext,
  type MetricSnapshot,
  type PersistedSnapshot,
} from "./metric.js";

export {
  ActivityEvent,
  type ActivityEventQuery,
} from "./activity-event.js";

export {
  Contract,
  ContractError,
  mountContract,
  type ContractContext,
  type ContractRequest,
  type ContractResponse,
  type ContractGuard,
  type MountOptions,
} from "./contract.js";

export {
  defineMatview,
  listMatviews,
  clearMatviews,
  ensureMatview,
  ensureAllMatviews,
  refreshMatview,
  refreshAll,
  type MatviewSpec,
  type RefreshOutcome,
} from "./matview.js";

export {
  Detector,
  registerDetector,
  listDetectors,
  clearDetectors,
  runDetectors,
  type DetectorContext,
  type DetectorInput,
  type Finding,
  type Severity,
} from "./finding.js";

export {
  StoryComposer,
  validateAgainstFinding,
  type ComposedStory,
  type ComposeRequest,
  type CompletionFn,
  type CompletionInput,
  type ComposerOptions,
} from "./composer.js";

export {
  ensureStoryTable,
  runProjection,
  STORY_TABLE,
  type ProjectionContext,
  type StoryRow,
  type StoryStatus,
} from "./story.js";

export {
  ANALYTICS_STATE_CHANGE_TABLE,
  diffCohorts,
  ensureStateChangeTable,
  persistStateChangeRows,
  type DiffArgs,
  type ReasonShape,
  type StateChangeRow,
  type Transition,
} from "./state-change.js";

export { WauMetric, AnomalyDetector } from "./examples.js";

export { generateId } from "./id.js";
