import type { Db, PayPalClient } from '@holdfast/core';

/**
 * `seed:demo --reset` calls this before seeding. HF-046 owns `demo:reset` (sweep →
 * `reconcile:holds` → verify no live authorization is left → truncate, keeping
 * `is_demo_foreground` actors) and replaces this placeholder, keeping the signature.
 * Until then `--reset` refuses instead of deleting anything.
 */
export interface DemoResetDeps {
  db: Db;
  paypal: PayPalClient;
}

export class DemoResetUnavailableError extends Error {
  constructor() {
    super(
      'demo:reset (HF-046) is not available yet, so --reset cannot clear the existing demo data. ' +
        'Seed a fresh database instead.',
    );
    this.name = 'DemoResetUnavailableError';
  }
}

export async function demoReset(_deps: DemoResetDeps): Promise<void> {
  throw new DemoResetUnavailableError();
}
