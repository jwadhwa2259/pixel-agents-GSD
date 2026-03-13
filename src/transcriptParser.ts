import * as path from 'path';
import type * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  classifyGsdAgent,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return `Editing notebook`;
    default:
      return `Using ${toolName}`;
  }
}

/** Deactivate sub-agents for background tools and clear tracking */
function clearBackgroundTools(
  agent: AgentState,
  agentId: number,
  webview: vscode.Webview | undefined,
): void {
  if (agent.backgroundToolIds.size === 0) return;
  console.log(
    `[Pixel Agents] Agent ${agentId}: clearing ${agent.backgroundToolIds.size} background tool(s)`,
  );
  for (const toolId of agent.backgroundToolIds) {
    agent.gsdToolMeta.delete(toolId);
    webview?.postMessage({
      type: 'subagentClear',
      id: agentId,
      parentToolId: toolId,
    });
  }
  agent.backgroundToolIds.clear();
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const record = JSON.parse(line);

    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      const blocks = record.message.content as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            console.log(`[Pixel Agents] Agent ${agentId} tool start: ${block.id} ${status}`);
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
              hasNonExemptTool = true;
            }
            const isSubagentTool = SUBAGENT_TOOLS.has(toolName);
            const subagentType =
              typeof block.input?.subagent_type === 'string'
                ? block.input.subagent_type
                : undefined;
            const gsdMeta = isSubagentTool
              ? classifyGsdAgent(
                  typeof block.input?.prompt === 'string' ? block.input.prompt : '',
                  subagentType,
                )
              : null;
            if (isSubagentTool) {
              const isBackground = !!block.input?.run_in_background;
              console.log(
                `[Pixel Agents] Agent ${agentId} SUBAGENT detected: tool=${toolName} id=${block.id} status="${status}" gsdRole=${gsdMeta?.role} gsdHueShift=${gsdMeta?.hueShift} background=${isBackground}`,
              );
              if (gsdMeta) {
                agent.gsdToolMeta.set(block.id, gsdMeta);
              }
              if (isBackground) {
                agent.backgroundToolIds.add(block.id);
              }
            }
            webview?.postMessage({
              type: 'agentToolStart',
              id: agentId,
              toolId: block.id,
              status,
              ...(gsdMeta ? { gsdRole: gsdMeta.role, gsdHueShift: gsdMeta.hueShift } : {}),
            });
          }
        }
        if (hasNonExemptTool) {
          startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        // Text-only response in a turn that hasn't used any tools.
        // turn_duration handles tool-using turns reliably but is never
        // emitted for text-only turns, so we use a silence-based timer:
        // if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
      }
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, webview);
    } else if (record.type === 'user') {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
              const completedToolId = block.tool_use_id;
              const isBackgroundTool = agent.backgroundToolIds.has(completedToolId);
              // If the completed tool was a Task/Agent, clear its subagent tools
              if (SUBAGENT_TOOLS.has(agent.activeToolNames.get(completedToolId) || '')) {
                agent.activeSubagentToolIds.delete(completedToolId);
                agent.activeSubagentToolNames.delete(completedToolId);
                if (isBackgroundTool) {
                  // Background agent — keep sub-agent active (it's still running)
                  // Keep gsdToolMeta for status display
                  console.log(
                    `[Pixel Agents] Agent ${agentId} background tool done (agent still running): ${completedToolId}`,
                  );
                } else {
                  // Foreground agent completed — deactivate sub-agent
                  agent.gsdToolMeta.delete(completedToolId);
                  webview?.postMessage({
                    type: 'subagentClear',
                    id: agentId,
                    parentToolId: completedToolId,
                  });
                }
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              const toolId = completedToolId;
              setTimeout(() => {
                webview?.postMessage({
                  type: 'agentToolDone',
                  id: agentId,
                  toolId,
                });
              }, TOOL_DONE_DELAY_MS);
            }
          }
          // Note: hadToolsInTurn is NOT reset here. It stays true until
          // turn_duration or a new user prompt, preventing the text-idle
          // timer from firing prematurely between sequential Agent tool calls.
        } else {
          // New user text prompt — new turn starting
          cancelWaitingTimer(agentId, waitingTimers);
          clearBackgroundTools(agent, agentId, webview);
          clearAgentActivity(agent, agentId, permissionTimers, webview);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        // New user text prompt — new turn starting
        cancelWaitingTimer(agentId, waitingTimers);
        clearBackgroundTools(agent, agentId, webview);
        clearAgentActivity(agent, agentId, permissionTimers, webview);
        agent.hadToolsInTurn = false;
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      // Definitive turn-end: clean up any stale tool state
      if (agent.activeToolIds.size > 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        agent.activeSubagentToolIds.clear();
        agent.activeSubagentToolNames.clear();
        // Only clear gsdToolMeta for non-background tools
        for (const toolId of agent.gsdToolMeta.keys()) {
          if (!agent.backgroundToolIds.has(toolId)) {
            agent.gsdToolMeta.delete(toolId);
          }
        }
        webview?.postMessage({ type: 'agentToolsClear', id: agentId, clearSubagents: false });
      }

      agent.hadToolsInTurn = false;

      if (agent.backgroundToolIds.size > 0) {
        // Background agents still running — keep main agent and sub-agents active
        console.log(
          `[Pixel Agents] Agent ${agentId} turn ended with ${agent.backgroundToolIds.size} background agent(s) still running`,
        );
        agent.isWaiting = false;
        agent.permissionSent = false;
        webview?.postMessage({
          type: 'agentStatus',
          id: agentId,
          status: 'active',
        });
      } else {
        agent.isWaiting = true;
        agent.permissionSent = false;
        webview?.postMessage({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
        });
      }
    }
  } catch {
    // Ignore malformed lines
  }
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  // bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
  // Restart the permission timer to give the running tool another window.
  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId)) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
    return;
  }

  // Verify parent is an active Task/Agent tool (agent_progress handling)
  if (!SUBAGENT_TOOLS.has(agent.activeToolNames.get(parentToolId) || '')) return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`,
        );

        // Track sub-tool IDs
        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(block.id);

        // Track sub-tool names (for permission checking)
        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(block.id, toolName);

        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }

        webview?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: block.id,
          status,
        });
      }
    }
    if (hasNonExemptSubTool) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`,
        );

        // Remove from tracking
        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) {
          subTools.delete(block.tool_use_id);
        }
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) {
          subNames.delete(block.tool_use_id);
        }

        const toolId = block.tool_use_id;
        setTimeout(() => {
          webview?.postMessage({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId,
          });
        }, 300);
      }
    }
    // If there are still active non-exempt sub-agent tools, restart the permission timer
    // (handles the case where one sub-agent completes but another is still stuck)
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  }
}
