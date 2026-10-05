// Fake model for tests. Presets, the chat catalog, and provider subpaths do not include it.
export { checkAssistantStream } from "./stream.ts";
export { fauxAssistant, fauxProvider, fauxText, fauxToolCall } from "./faux.ts";
export type { FauxProviderOptions, FauxResponder, FauxState } from "./faux.ts";
