/**
 * Compatibility shim. The tool declarations moved to src/shared/tools (one
 * ToolMeta per tool; schemas, toggles, budgets, labels all derived) so the
 * renderer, the main process, and the Electron-free eval harness read the
 * same table. Import from '../../shared/tools' in new code; this shim keeps
 * existing main/scripts/test import paths working until they are repointed.
 */
export type { ToolSchema } from '../../shared/tools'
export { TOOL_SCHEMAS, DEFAULT_PASSAGES, MAX_PASSAGES } from '../../shared/tools'
