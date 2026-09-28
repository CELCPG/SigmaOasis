/**
 * v3.0: the app's own tools an agent may be offered — reads and compute only,
 * each only when enabled under Settings → Tools and only when Settings → Agent
 * lets the agent use them. Shared so the main process (which offers them) and
 * the privacy audit (which names them) cannot disagree about the list.
 */
export const AGENT_APP_TOOLS = [
  'web_search',
  'fetch_webpage',
  'deep_research',
  'reference_lookup',
  'get_current_datetime',
  'date_calculator',
  'run_python',
  'memory_search'
] as const
