// scanner/engines/index.js — engine registry, keyed by engine id.
import * as chatgpt from './chatgpt.js';
import * as gemini from './gemini.js';
import * as google_ai_mode from './google_ai_mode.js';
import * as perplexity from './perplexity.js';
import * as claude from './claude.js';

export const ENGINES = { chatgpt, gemini, google_ai_mode, perplexity, claude };
export { chatgpt, gemini, google_ai_mode, perplexity, claude };
