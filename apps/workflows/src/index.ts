/**
 * Render Workflows entry point. HF-030b registers the settlement tasks from `@holdfast/core`
 * here; the default runner stays in-process (`SETTLEMENT_RUNNER=inprocess`, D9/M17).
 */
import type { Config } from '@holdfast/core';

export function workflowsEnabled(config: Pick<Config, 'SETTLEMENT_RUNNER'>): boolean {
  return config.SETTLEMENT_RUNNER === 'workflows';
}
