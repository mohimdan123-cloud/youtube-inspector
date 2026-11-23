// Cloudflare Worker entry point. All logic lives in core.js.
import { handleRequest } from './core.js';

export default { fetch: handleRequest };
