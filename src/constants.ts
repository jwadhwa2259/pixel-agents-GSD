// ── Timing (ms) ──────────────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 1000;
export const PROJECT_SCAN_INTERVAL_MS = 1000;
export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const TEXT_IDLE_DELAY_MS = 5000;

// ── Display Truncation ──────────────────────────────────────
export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 128;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_PATTERN_COUNT = 7;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_COUNT = 6;

// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;

// ── Settings Persistence ────────────────────────────────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';

// ── GSD Sub-Agent Classification ────────────────────────────

/** Maps subagent_type field to role/hueShift (checked FIRST, before prompt patterns) */
export const GSD_SUBAGENT_TYPE_MAP: Record<string, { role: string; hueShift: number }> = {
  'gsd-phase-researcher': { role: 'Researcher', hueShift: 200 },
  'gsd-project-researcher': { role: 'Researcher', hueShift: 200 },
  'gsd-planner': { role: 'Planner', hueShift: 120 },
  'gsd-plan-checker': { role: 'Checker', hueShift: 160 },
  'gsd-integration-checker': { role: 'Checker', hueShift: 160 },
  'gsd-executor': { role: 'Executor', hueShift: 30 },
  'gsd-verifier': { role: 'Verifier', hueShift: 280 },
  'gsd-debugger': { role: 'Debugger', hueShift: 0 },
  'gsd-codebase-mapper': { role: 'Mapper', hueShift: 60 },
  'gsd-roadmapper': { role: 'Roadmapper', hueShift: 120 },
  'gsd-research-synthesizer': { role: 'Synthesizer', hueShift: 240 },
  'gsd-nyquist-auditor': { role: 'Auditor', hueShift: 160 },
  Explore: { role: 'Explorer', hueShift: 200 },
  Plan: { role: 'Planner', hueShift: 120 },
};

export const GSD_AGENT_ROLES = [
  { patterns: ['research', 'investigate'], role: 'Researcher', hueShift: 200 },
  { patterns: ['plan', 'create task', 'create plans'], role: 'Planner', hueShift: 120 },
  { patterns: ['check', 'verify plan', 'plan checker'], role: 'Checker', hueShift: 160 },
  { patterns: ['execute', 'implement', 'executor'], role: 'Executor', hueShift: 30 },
  { patterns: ['verify', 'verification', 'verifier', 'uat'], role: 'Verifier', hueShift: 280 },
  { patterns: ['debug', 'diagnose'], role: 'Debugger', hueShift: 0 },
  { patterns: ['map', 'analyze codebase', 'codebase map'], role: 'Mapper', hueShift: 60 },
  { patterns: ['quick'], role: 'Quick', hueShift: 320 },
] as const;

export const GSD_DEFAULT_ROLE = { role: 'Agent', hueShift: 90 } as const;

export function classifyGsdAgent(
  prompt: string,
  subagentType?: string,
): { role: string; hueShift: number } {
  // Check subagent_type FIRST (definitive)
  if (subagentType) {
    const mapped = GSD_SUBAGENT_TYPE_MAP[subagentType];
    if (mapped) return { role: mapped.role, hueShift: mapped.hueShift };
  }
  // Fall back to prompt-based pattern matching
  const lower = prompt.toLowerCase();
  for (const entry of GSD_AGENT_ROLES) {
    if (entry.patterns.some((p) => lower.includes(p))) {
      return { role: entry.role, hueShift: entry.hueShift };
    }
  }
  return { role: GSD_DEFAULT_ROLE.role, hueShift: GSD_DEFAULT_ROLE.hueShift };
}

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const COMMAND_TEST_SUBAGENTS = 'pixel-agents.testSubagents';
export const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
export const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';
export const TERMINAL_NAME_PREFIX = 'Claude Code';
