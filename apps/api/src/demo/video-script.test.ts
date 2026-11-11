/**
 * HF-050b: the video script linter (`scripts/check-video-script.mjs`) passes on the committed
 * script and fails each acceptance criterion it guards (under 3:00, every beat present, no
 * third-party trademarks), plus the timing and honesty-label checks. Also checks the Devpost
 * linter still applies the shared copy rules after they moved to `scripts/lib/copy-rules.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const VIDEO = readFileSync(join(root, 'docs/devpost/VIDEO.md'), 'utf8');
const DRAFT = readFileSync(join(root, 'docs/devpost/DRAFT.md'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'hf050b-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function lint(script: string, text: string, env: NodeJS.ProcessEnv = {}) {
  const file = join(dir, `case-${n++}.md`);
  writeFileSync(file, text);
  const out = spawnSync(process.execPath, [join(root, 'scripts', script), file], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: out.status, output: out.stdout + out.stderr };
}
const video = (text: string) => lint('check-video-script.mjs', text);

/** Replace the narration of beat `beat` with `text`. */
function narrate(beat: number, text: string): string {
  const re = new RegExp(
    `(### Beat ${beat} [^\\n]*\\n+<!-- narration:start -->\\n)[\\s\\S]*?(<!-- narration:end -->)`,
  );
  expect(re.test(VIDEO)).toBe(true);
  return VIDEO.replace(re, `$1${text}\n$2`);
}

describe('HF-050b video script', () => {
  it('the committed script passes: 8 beats ending at 2:58', () => {
    const r = video(VIDEO);
    expect(r.output).toContain('8 beats, ends at 2:58');
    expect(r.code).toBe(0);
  });

  it('fails a script that runs to 3:00 or past it', () => {
    const text = VIDEO.replaceAll('2:40–2:58', '2:40–3:00');
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/must be under 3:00/);
  });

  it('fails a gap or overlap between beats', () => {
    const text = VIDEO.replaceAll('1:10–1:25', '1:12–1:25');
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/beat 4 starts at 1:12, not where the previous beat ends/);
  });

  it('fails a missing beat from the shot list', () => {
    const text = VIDEO.replace(/### Beat 4 · [^\n]*Price drop/, (h) =>
      h.replace('Price drop', 'Interlude'),
    );
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/missing beat \(or out of order\): price drop/);
  });

  it('fails narration too long for its slot', () => {
    const r = video(narrate(4, 'word '.repeat(40)));
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/beat 4 "Price drop": 40 words won't fit 15 s \(max 39/);
  });

  it('fails when the shot list and the narration disagree on timing', () => {
    const text = VIDEO.replace('| 3 | 0:50–1:10 |', '| 3 | 0:50–1:05 |');
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/beat 3: shot list says 0:50–1:05, narration says 0:50–1:10/);
  });

  it('fails when the voiceover never says which bids are simulated', () => {
    const text = VIDEO.replace(/\bSIM\b/g, 'simulated');
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/narration never says it: SIM bidders named/);
  });

  it('fails when the replay and the time-lapse are not labelled', () => {
    const text = narrate(5, 'The brand opens a live round. Most bidders are SIM.').replace(
      'This is a replayed price event, labelled on screen.',
      '',
    );
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/replayed price event labelled/);
    expect(r.output).toMatch(/time-lapse labelled/);
  });

  it('fails a third-party trademark anywhere (D15), case-sensitively for common words', () => {
    expect(video(narrate(4, 'A big box store like Best Buy drops the price.')).output).toMatch(
      /third-party trademark \(D15\): Best Buy/,
    );
    const r = video(narrate(1, 'Our offer beats the liquidator; Target does not.'));
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/third-party trademark \(D15\): Target/);
    expect(r.output).not.toMatch(/Beats/);
  });

  it('fails uniform-price copy in the narration (D14) but not in the rules that quote it', () => {
    expect(VIDEO).toMatch(/one fair price/);
    const r = video(narrate(6, 'Every winner gets one fair price.'));
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/uniform-price copy \(D14\)/);
  });

  it('fails when an evidence shot is dropped', () => {
    const text = VIDEO.replace(/- \*\*A Channel3 response:\*\*[^\n]*\n/, '');
    const r = video(text);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/evidence shots miss a Channel3 response/);
  });
});

describe('Devpost draft linter with the shared copy rules', () => {
  const noEnv = { DEVPOST_CHECK_ENV: join(dir, 'missing.env') };

  it('still passes the committed draft', () => {
    expect(lint('check-devpost-draft.mjs', DRAFT, noEnv).code).toBe(0);
  });

  it('still fails a trademark and uniform-price copy', () => {
    const text = DRAFT.replace(
      '## Inspiration\n',
      '## Inspiration\n\nCheaper than Walmart, and everyone pays the same.\n',
    );
    const r = lint('check-devpost-draft.mjs', text, noEnv);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/third-party trademark \(D15\): Walmart/);
    expect(r.output).toMatch(/uniform-price copy \(D14\)/);
  });
});
