import { describe, expect, it } from 'vitest';
import {
  averageCents,
  parseCsv,
  parseShipmentCsv,
  statementsCsv,
  toCsv,
  type ListingStatement,
} from './payouts-report.js';

const BID_A = '6f9c1a52-0f3e-4f61-9a43-0d9b8f2e1a01';
const BID_B = '6f9c1a52-0f3e-4f61-9a43-0d9b8f2e1a02';

describe('parseCsv / toCsv', () => {
  it('round-trips quotes, commas and CRLF, and neutralises formulas', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['x, "y"', '=SUM(A1)'],
        [1, null],
      ],
    );
    expect(csv).toBe('a,b\r\n"x, ""y""",\'=SUM(A1)\r\n1,\r\n');
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['x, "y"', "'=SUM(A1)"],
      ['1', ''],
    ]);
  });
});

describe('parseShipmentCsv', () => {
  it('accepts header aliases and reports bad rows without sinking good ones', () => {
    const text = [
      'Bid_ID,Carrier,tracking_number',
      `${BID_A},UPS,1Z999AA10123456784`,
      `not-a-uuid,UPS,1Z1`,
      `${BID_B},,9400`,
      `${BID_A},USPS,9400`,
      '',
    ].join('\n');
    const { rows, errors } = parseShipmentCsv(text);
    expect(rows).toEqual([
      { row: 1, input: { bidId: BID_A, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } },
    ]);
    expect(errors.map((e) => [e.row, e.bidId])).toEqual([
      [2, 'not-a-uuid'],
      [3, BID_B],
      [4, BID_A],
    ]);
    expect(errors[2]!.message).toMatch(/more than once/);
  });

  it('rejects a file without the required header', () => {
    expect(parseShipmentCsv('foo,bar\n1,2').errors[0]).toMatchObject({ row: 0 });
    expect(parseShipmentCsv('').errors).toHaveLength(1);
  });
});

describe('statements', () => {
  it('averages half up and writes dollars as decimals', () => {
    expect(averageCents(1001, 2)).toBe(501);
    expect(averageCents(1000, 3)).toBe(333);
    expect(averageCents(0, 0)).toBeNull();
    const s: ListingStatement = {
      listingId: 'L1',
      productTitle: 'Aurel A7',
      listingStatus: 'PAID_OUT',
      clearedAt: '2026-11-12T00:00:00.000Z',
      cutoffCents: 29_800,
      units: 3,
      grossRealCents: 89_700,
      feeBps: 900,
      feeCents: 8_073,
      netCents: 81_627,
      averageCents: 29_900,
      unitsSimulated: 0,
      grossSimulatedCents: 0,
      payoutStatus: 'SUCCESS',
      payoutAttempt: 1,
    };
    const lines = statementsCsv([s]).trim().split('\r\n');
    expect(lines[1]).toBe(
      'L1,Aurel A7,PAID_OUT,2026-11-12T00:00:00.000Z,298.00,3,897.00,900,80.73,816.27,299.00,0,0.00,SUCCESS',
    );
  });
});
