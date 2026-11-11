/**
 * Render Workflows service entry (start command: `node apps/workflows/dist/main.js`).
 * Importing a module registers its tasks; the SDK starts the task server on Render
 * (RENDER_SDK_SOCKET_PATH is set there). Locally: `render workflows dev -- node apps/workflows/dist/main.js`.
 */
import './tasks.js';
