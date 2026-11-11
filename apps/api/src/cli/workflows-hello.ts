/**
 * `npm run workflows:hello`: run from the web service's Render Shell (HF-048a). Triggers the
 * hello-world task on the workflow service and prints the run id, status and result. The
 * result carries key presence only, never values.
 */
import { ConfigError, MissingFeatureConfigError, loadConfig, loadDotenv } from '@holdfast/core';
import { triggerHello } from '../workflows-hello.js';

loadDotenv();

try {
  const run = await triggerHello(loadConfig(process.env));
  console.log(JSON.stringify(run, null, 2));
  process.exit(run.succeeded ? 0 : 1);
} catch (err) {
  if (err instanceof ConfigError || err instanceof MissingFeatureConfigError) {
    console.error(err.message);
  } else {
    // SDK errors carry the HTTP status and task slug, never the API key.
    console.error(`workflows:hello failed: ${(err as Error).message}`);
  }
  process.exit(1);
}
