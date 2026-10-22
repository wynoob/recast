export * from "@dmall/contracts";
export {
  DECK_CANVAS,
  SAMPLE_DATA_LABEL,
  TEMPLATE_SCHEMA_VERSION,
  buildBuiltinTemplatePackage,
  builtinNarratives,
  builtinTemplatePackages,
  getRegisteredLayout,
  registeredLayouts,
} from "./catalog.js";
export {
  instantiateBuiltinTemplate,
  instantiateTemplate,
  reviseTemplatePackage,
  type InstantiationResult,
} from "./instantiate.js";
export {
  changeDeckSlideLayout,
  collectUnplacedBlocks,
  instanceToDeckDraft,
  newDraftSlideId,
  placeUnplacedBlock,
  validateExportReadiness,
  type ExportReadinessResult,
  type LayoutChangeResult,
  type PlaceBlockResult,
} from "./layouts.js";
export {
  computeThemeContrast,
  contrastRatio,
  layoutSampleIds,
  renderTemplateSample,
} from "./render.js";
export {
  hashReadyReview,
  validateTemplatePackage,
} from "./validate.js";
export {
  createSyntheticSample,
  createTemplateValidationSample,
  type SyntheticSample,
  type TemplateValidationSample,
} from "./samples.js";
export { assessTemplateReadiness } from "./readiness.js";

export { canonicalHash } from "./ids.js";
