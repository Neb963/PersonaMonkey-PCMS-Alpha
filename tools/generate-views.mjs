import { generateViews } from './alpha/views.mjs';
await generateViews({ check: process.argv.includes('--check') });
