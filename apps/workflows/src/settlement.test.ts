/**
 * HF-030b: the Render Workflows settlement adapter on real Postgres with `FakePayPal` (HF-004).
 * `FakeRender` stands in for the Workflows control plane: `startTask` honours idempotency keys,
 * each run executes the real parent task body (`runSettleListing`) and every `ctx.run` child the
 * real `runSettleBid`, with inputs and results round-tripped through JSON as Render does.
 *
 * Covers the ticket's acceptance criteria locally (the Render runs themselves are manual steps):
 * 10-bid smoke with the in-process capture-id pattern, 50 bids with one decline matching the
 * in-process runner, kill-and-resume without duplicate captures, and the races (concurrent kicks,
 * duplicate parent runs, a hung run, a failed child run).
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run --maxWorkers=2 apps/workflows/src/settlement
 */
import {
  settleListing,
  startSettlementWorkflow,
  workflowIdempotencyKey,
  workflowsSettlementRunner,
  type Db,
  type PayPalClient,
  type SettleListingDeps,
  type WorkflowRunClient,
} from '@holdfast/core';
import { TaskRegistry } from '@renderinc/sdk/workflows';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../../../packages/core/src/money/test-harness.js';
import { FakePayPal } from '../../../packages/core/src/paypal/fake.js';
import { kickSettlementOutbox } from '../../../packages/core/src/settlement/outbox.js';
import {
  seedClearedListing,
  type ClearedListing,
  type ClearedListingOptions,
} from '../../../packages/core/src/settlement/test-fixtures.js';
import { runSettleBid, runSettleListing, type OpenSettlement } from './settlement.js';
import { TASKS } from './tasks.js';

const never = () => new Promise<never>(() => {});
const json = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

describe('task registration', () => {
  it('registers settleListing and settleBid with Render-level retries off (D11)', () => {
    const registry = TaskRegistry.getInstance();
    for (const name of [TASKS.settleListing, TASKS.settleBid]) {
      // Stored in the wire format Render registers.
      expect(registry.get(name)?.options?.retry).toMatchObject({ max_retries: 0 });
    }
  });

  it('first run is keyed by the listing id; resumes get a new key', () => {
    expect(workflowIdempotencyKey('L1', 1)).toBe('L1');
    expect(workflowIdempotencyKey('L1', 2)).toBe('L1:2');
  });
});

interface FakeRun {
  id: string;
  key: string;
  listingId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  result?: unknown;
  error?: string;
  children: string[];
  done: Promise<void>;
  kill: AbortController;
}

/**
 * The Workflows control plane: keyed starts, a run per parent with its child runs, kill/cancel.
 * `exec` runs the parent body; tests choose its deps (and so the PayPal client per run).
 */
class FakeRender implements WorkflowRunClient {
  runs: FakeRun[] = [];
  starts = 0;
  private n = 0;
  constructor(
    private exec: (
      run: FakeRun,
      runChild: (settlementId: string) => Promise<unknown>,
    ) => Promise<unknown>,
    private runChildBody: (run: FakeRun, settlementId: string) => Promise<unknown>,
  ) {}

  async startTask(slug: string, input: unknown[], o: { idempotencyKey: string }) {
    this.starts++;
    expect(slug).toBe('holdfast-workflows/settleListing');
    const prior = this.runs.find((r) => r.key === o.idempotencyKey);
    if (prior) return { taskRunId: prior.id };
    const [listingId] = json(input) as [string];
    const run = {
      id: `trn-${++this.n}`,
      key: o.idempotencyKey,
      listingId,
      status: 'running',
      children: [],
      kill: new AbortController(),
    } as unknown as FakeRun;
    const runChild = async (settlementId: string) => {
      run.children.push(settlementId);
      return json(await this.runChildBody(run, json(settlementId)));
    };
    run.done = (async () => {
      try {
        run.result = json(await this.exec(run, runChild));
        if (run.status === 'running') run.status = 'succeeded';
      } catch (err) {
        if (run.status === 'running') run.status = 'failed';
        run.error = (err as Error).message;
      }
    })();
    this.runs.push(run);
    return { taskRunId: run.id };
  }
  async getTaskRun(id: string) {
    return { status: this.run(id).status };
  }
  async cancelTaskRun(id: string) {
    const run = this.run(id);
    run.status = 'canceled';
    run.kill.abort();
  }
  run(id: string): FakeRun {
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new Error(`no run ${id}`);
    return r;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('HF-030b settlement on Workflows', { timeout: 90_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let fake: FakePayPal;
  let client: PayPalClient;
  let payouts: Array<{ listingId: string; status: string }>;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  function deps(extra: Partial<SettleListingDeps> = {}): SettleListingDeps {
    return {
      db,
      paypal: client,
      sleep: async () => {},
      allowMockDecline: true,
      pollMs: 50,
      retryDelaySeconds: 0,
      payoutBrand: async (listingId) => {
        const l = await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
          listingId,
        ]);
        payouts.push({ listingId, status: l.status });
      },
      ...extra,
    };
  }
  /** Task deps the way a run opens them; the shared test pool is never closed by a run. */
  const opener =
    (extra: Partial<SettleListingDeps> = {}): OpenSettlement =>
    () => ({ deps: deps(extra), close: async () => {} });

  /** A Render whose runs use `perRun(run)` deps for both the parent and its children. */
  function render(perRun: (run: FakeRun) => Partial<SettleListingDeps> = () => ({})) {
    return new FakeRender(
      (run, runChild) =>
        runSettleListing(
          opener({ ...perRun(run), signal: run.kill.signal }),
          runChild,
          run.listingId,
        ),
      (run, id) => runSettleBid(opener(perRun(run)), id),
    );
  }
  const runnerFor = (r: WorkflowRunClient) =>
    workflowsSettlementRunner({ db, client: r, taskSlug: 'holdfast-workflows/settleListing' });

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake ??= new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    fake.clearFaults();
    fake.calls.length = 0;
    client = fake.client({ timeoutMs: 2_000 });
    payouts = [];
  });

  const seed = (opts: ClearedListingOptions) => seedClearedListing(db, client, opts);
  const runRow = (listingId: string) =>
    one<{ status: string; workflow_run_id: string | null; workflow_starts: number }>(
      `SELECT status, workflow_run_id, workflow_starts FROM settlement_runs WHERE listing_id = $1`,
      [listingId],
    );
  const listingStatus = async (id: string) =>
    (await one<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [id])).status;

  /**
   * The in-process capture-id pattern: every charged authorization has exactly one PayPal capture
   * at its bid, made with `PayPal-Request-Id = settlement id`, and `settlements.paypal_id` holds
   * that capture's id; every other hold is voided with `void-<bidId>` and never captured.
   */
  async function expectCapturePattern(s: ClearedListing) {
    const bids = await q<{
      id: string;
      status: string;
      amount_cents: number;
      paypal_authorization_id: string;
    }>(`SELECT id, status, amount_cents, paypal_authorization_id FROM bids WHERE listing_id = $1`, [
      s.listingId,
    ]);
    for (const b of bids) {
      const caps = fake.capturesOf(b.paypal_authorization_id);
      if (b.status === 'CAPTURED') {
        expect(caps).toHaveLength(1);
        expect(caps[0]!.amountCents).toBe(b.amount_cents);
        const row = await one<{ id: string; paypal_id: string }>(
          `SELECT id, paypal_id FROM settlements
            WHERE bid_id = $1 AND action = 'CAPTURE' AND status = 'SUCCEEDED'`,
          [b.id],
        );
        expect(row.paypal_id).toBe(caps[0]!.id);
        const requestIds = new Set(
          fake.calls
            .filter((c) => c.op === 'capture' && c.path.includes(b.paypal_authorization_id))
            .map((c) => c.requestId),
        );
        expect([...requestIds]).toEqual([row.id]);
      } else {
        expect(b.status).toBe('VOIDED');
        expect(caps).toHaveLength(0);
        expect(fake.authorization(b.paypal_authorization_id)!.status).toBe('VOIDED');
      }
    }
  }

  /** What a runner's result looks like, independent of ids: compared across runners. */
  async function summary(s: ClearedListing) {
    const counts = await one(
      `SELECT count(*) FILTER (WHERE action = 'CAPTURE' AND status = 'SUCCEEDED')::int AS captured,
              coalesce(sum(amount_cents) FILTER (WHERE action = 'CAPTURE' AND status = 'SUCCEEDED'), 0)::int AS captured_cents,
              count(*) FILTER (WHERE action = 'VOID' AND status = 'SUCCEEDED')::int AS voided,
              count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
         FROM settlements WHERE listing_id = $1`,
      [s.listingId],
    );
    const rank = (bidId: string) => {
      const w = s.winners.findIndex((b) => b.bidId === bidId);
      if (w >= 0) return `winner#${w + 1}`;
      const r = s.reserve.findIndex((b) => b.bidId === bidId);
      return r >= 0
        ? `reserve#${r + 1}`
        : `belowFloor#${s.belowFloor.findIndex((b) => b.bidId === bidId) + 1}`;
    };
    const promoted = await q<{ id: string; unit_root_bid_id: string; status: string }>(
      `SELECT id, unit_root_bid_id, status FROM bids
        WHERE listing_id = $1 AND unit_root_bid_id IS NOT NULL AND unit_root_bid_id <> id`,
      [s.listingId],
    );
    const audits = await q<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit_events
        WHERE listing_id = $1 AND action IN ('PROMOTED', 'UNFILLED_UNIT', 'LISTING_SETTLED')
        GROUP BY action ORDER BY action`,
      [s.listingId],
    );
    return {
      listing: await listingStatus(s.listingId),
      counts,
      promotions: promoted
        .map((p) => `${rank(p.id)}→${rank(p.unit_root_bid_id)}:${p.status}`)
        .sort(),
      audits,
      payouts: payouts.filter((p) => p.listingId === s.listingId).map((p) => p.status),
    };
  }

  // ----------------------------------------------------------------------------------------------

  it('10-bid smoke: one keyed run, every row a child run, same capture-id pattern as in-process', async () => {
    const s = await seed({ winners: 6, reserve: 2, belowFloor: 2 });
    const r = render();
    const kicked = await runnerFor(r).start({ runId: s.runId, listingId: s.listingId });
    expect(kicked).toMatchObject({ outcome: 'STARTED', idempotencyKey: s.listingId, start: 1 });
    const run = r.runs[0]!;
    await run.done;
    expect(run.status).toBe('succeeded');
    expect(run.result).toMatchObject({ outcome: 'SETTLED', payout: 'CALLED' });

    // The fan-out: every settlement row ran as its own child task run.
    const rows = await q<{ id: string }>(`SELECT id FROM settlements WHERE listing_id = $1`, [
      s.listingId,
    ]);
    expect(rows).toHaveLength(10);
    expect([...run.children].sort()).toEqual(rows.map((x) => x.id).sort());

    expect(await runRow(s.listingId)).toEqual({
      status: 'DONE',
      workflow_run_id: run.id,
      workflow_starts: 1,
    });
    expect(await listingStatus(s.listingId)).toBe('SETTLED');
    expect(payouts).toEqual([{ listingId: s.listingId, status: 'SETTLED' }]);
    await expectCapturePattern(s);
    expect(
      await q(
        `SELECT data->>'workflowRunId' AS id FROM audit_events
          WHERE listing_id = $1 AND action = 'SETTLEMENT_WORKFLOW_STARTED'`,
        [s.listingId],
      ),
    ).toEqual([{ id: run.id }]);

    // A late kick after DONE starts nothing.
    expect(await runnerFor(r).start({ runId: s.runId, listingId: s.listingId })).toEqual({
      outcome: 'DONE',
      workflowRunId: run.id,
    });
    expect(r.runs).toHaveLength(1);
  });

  it('50 bids with one decline: same results as the in-process runner', async () => {
    const shape: ClearedListingOptions = {
      winners: 20,
      reserve: 25,
      belowFloor: 5,
      declineWinners: [3],
    };
    const a = await seed(shape);
    const b = await seed(shape);

    expect(await settleListing(deps(), a.listingId)).toMatchObject({ outcome: 'SETTLED' });

    const r = render();
    await runnerFor(r).start({ runId: b.runId, listingId: b.listingId });
    await r.runs[0]!.done;
    expect(r.runs[0]!.result).toMatchObject({ outcome: 'SETTLED', payout: 'CALLED' });

    const inProcess = await summary(a);
    const onWorkflows = await summary(b);
    expect(onWorkflows).toEqual(inProcess);
    expect(onWorkflows).toMatchObject({
      listing: 'SETTLED',
      counts: { captured: 20, voided: 29, failed: 1, cancelled: 1 },
      promotions: ['reserve#1→winner#3:CAPTURED'],
      payouts: ['SETTLED'],
    });
    // The promoted bidder is charged their own bid.
    expect(fake.capturesOf(b.reserve[0]!.authorizationId).map((c) => c.amountCents)).toEqual([
      b.reserve[0]!.amountCents,
    ]);
    await expectCapturePattern(a);
    await expectCapturePattern(b);
  });

  it('a killed run resumes under a new key without duplicate captures; one payout', async () => {
    const s = await seed({ winners: 20, reserve: 10, belowFloor: 5, declineWinners: [7] });
    let captures = 0;
    // Run 1's process dies after its 8th capture call starts: PayPal does the work, but no
    // response is handled again (children included), and the coordinator stops.
    const dying = (run: FakeRun): Pick<PayPalClient, 'capture' | 'void'> => ({
      capture: async (input) => {
        if (run.kill.signal.aborted) return never();
        if (++captures === 8) run.kill.abort();
        const res = await client.capture(input);
        return run.kill.signal.aborted ? never() : res;
      },
      void: async (authId, requestId) => {
        if (run.kill.signal.aborted) return never();
        const res = await client.void(authId, requestId);
        return run.kill.signal.aborted ? never() : res;
      },
    });
    const r = render((run) => (run.key === s.listingId ? { paypal: dying(run) } : {}));
    const runner = runnerFor(r);
    await runner.start({ runId: s.runId, listingId: s.listingId });
    const first = r.runs[0]!;
    await expect.poll(() => first.kill.signal.aborted, { timeout: 10_000 }).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    // Render reports the killed run as failed; its rows and the run lease are still RUNNING.
    first.status = 'failed';
    expect(await listingStatus(s.listingId)).toBe('CLEARING');
    const capturedBefore = new Map(
      s.winners
        .filter((w) => fake.capturesOf(w.authorizationId).length > 0)
        .map((w) => [w.authorizationId, fake.capturesOf(w.authorizationId)[0]!.id]),
    );
    expect(capturedBefore.size).toBeGreaterThan(0);

    // Leases expire; HF-034's outbox tick kicks the Workflows runner, which starts run 2.
    await db.pool.query(
      `UPDATE settlements SET lease_until = now() - interval '1 second'
        WHERE listing_id = $1 AND status = 'RUNNING'`,
      [s.listingId],
    );
    await db.pool.query(
      `UPDATE settlement_runs SET lease_until = now() - interval '1 second' WHERE listing_id = $1`,
      [s.listingId],
    );
    expect(await kickSettlementOutbox(db, runner.kick)).toBeGreaterThanOrEqual(1);
    const second = r.runs.find((x) => x.key === `${s.listingId}:2`)!;
    expect(second).toBeDefined();
    await second.done;
    expect(second.result).toMatchObject({ outcome: 'SETTLED' });

    expect(await runRow(s.listingId)).toEqual({
      status: 'DONE',
      workflow_run_id: second.id,
      workflow_starts: 2,
    });
    await expectCapturePattern(s);
    for (const [authId, captureId] of capturedBefore) {
      expect(fake.capturesOf(authId).map((c) => c.id)).toEqual([captureId]);
    }
    expect(payouts).toEqual([{ listingId: s.listingId, status: 'SETTLED' }]);
  });

  describe('races', () => {
    it('concurrent kicks (Clear + outbox + admin) start one run', async () => {
      const s = await seed({ winners: 3, reserve: 1, belowFloor: 1 });
      const r = render();
      const runner = runnerFor(r);
      const ref = { runId: s.runId, listingId: s.listingId };
      const results = await Promise.all([runner.start(ref), runner.start(ref), runner.start(ref)]);
      expect(results.filter((x) => x.outcome === 'STARTED')).toHaveLength(1);
      expect(r.runs).toHaveLength(1);
      // While the run is live, a further kick is a no-op.
      expect(await runner.start(ref)).toMatchObject({ outcome: 'LIVE' });
      await r.runs[0]!.done;
      expect(await listingStatus(s.listingId)).toBe('SETTLED');
      expect(payouts).toHaveLength(1);
    });

    it('a repeated start with the same key (lost response) returns the same run', async () => {
      const s = await seed({ winners: 2, reserve: 0, belowFloor: 1 });
      const r = render();
      // The first start reached Render but its response was lost before the id was stored.
      await r.startTask('holdfast-workflows/settleListing', [s.listingId], {
        idempotencyKey: s.listingId,
      });
      const res = await startSettlementWorkflow(
        { db, client: r, taskSlug: 'holdfast-workflows/settleListing' },
        { runId: s.runId, listingId: s.listingId },
      );
      expect(res).toMatchObject({ outcome: 'STARTED', workflowRunId: r.runs[0]!.id });
      expect(r.runs).toHaveLength(1);
      await r.runs[0]!.done;
      expect(payouts).toHaveLength(1);
    });

    it('two parent runs for one listing: one settles, the other is BUSY; one payout', async () => {
      const s = await seed({ winners: 10, reserve: 5, belowFloor: 5, declineWinners: [2] });
      const r = render();
      await Promise.all([
        r.startTask('holdfast-workflows/settleListing', [s.listingId], { idempotencyKey: 'a' }),
        r.startTask('holdfast-workflows/settleListing', [s.listingId], { idempotencyKey: 'b' }),
      ]);
      await Promise.all(r.runs.map((x) => x.done));
      expect(r.runs.map((x) => (x.result as { outcome: string }).outcome).sort()).toEqual([
        'BUSY',
        'SETTLED',
      ]);
      expect(fake.calls.filter((c) => c.op === 'capture')).toHaveLength(11);
      expect(payouts).toHaveLength(1);
      await expectCapturePattern(s);
    });

    it('a hung run (still "running", lease expired) is cancelled and replaced', async () => {
      const s = await seed({ winners: 2, reserve: 1, belowFloor: 1 });
      // Run 1 claims the run and then hangs forever.
      const r = new FakeRender(
        async (run, runChild) => {
          if (run.key === s.listingId) {
            await db.pool.query(
              `UPDATE settlement_runs SET status = 'RUNNING', lease_until = now() - interval '1 second'
                WHERE listing_id = $1`,
              [s.listingId],
            );
            return never();
          }
          return runSettleListing(opener({ signal: run.kill.signal }), runChild, run.listingId);
        },
        (_run, id) => runSettleBid(opener(), id),
      );
      const runner = runnerFor(r);
      await runner.start({ runId: s.runId, listingId: s.listingId });
      await expect.poll(async () => (await runRow(s.listingId)).status).toBe('RUNNING');
      const res = await runner.start({ runId: s.runId, listingId: s.listingId });
      expect(res).toMatchObject({ outcome: 'STARTED', idempotencyKey: `${s.listingId}:2` });
      expect(r.runs[0]!.status).toBe('canceled');
      await r.runs[1]!.done;
      expect(await listingStatus(s.listingId)).toBe('SETTLED');
      expect(payouts).toHaveLength(1);
    });

    it('a child run that fails at the Render level is retried by the coordinator', async () => {
      const s = await seed({ winners: 3, reserve: 1, belowFloor: 1 });
      let failed = 0;
      const r = new FakeRender(
        (run, runChild) =>
          runSettleListing(opener({ signal: run.kill.signal }), runChild, run.listingId),
        async (_run, id) => {
          // Render could not start the first two child runs (no compute): no row was claimed.
          if (failed++ < 2) throw new Error('Subtask failed: no capacity');
          return runSettleBid(opener(), id);
        },
      );
      await runnerFor(r).start({ runId: s.runId, listingId: s.listingId });
      await r.runs[0]!.done;
      expect(r.runs[0]!.result).toMatchObject({ outcome: 'SETTLED' });
      expect(r.runs[0]!.children.length).toBe(5 + 2);
      await expectCapturePattern(s);
      expect(payouts).toHaveLength(1);
    });
  });
});
