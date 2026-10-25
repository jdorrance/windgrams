// Add forecast data to the built site and measure the Pages upload.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareDataset } from './prepare-dataset.mjs';
import { checkPagesArtifact } from '../forecasts/scripts/pages-artifact.mjs';

const start = Date.now();
const dataset = prepareDataset(resolve('forecasts/data'), resolve('web/dist/data'));
const artifact = checkPagesArtifact(resolve('web/dist'));
const report = { ...artifact, byProduct: dataset.byProduct, assemblyMs: Date.now() - start };
console.log(JSON.stringify(report, null, 2));
if (report.warning) console.warn(`::warning::Pages artifact exceeds the size warning threshold (${report.bytes} bytes).`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Pages size\n\n${report.bytes.toLocaleString('en-US')} bytes; ${report.remainingBytes.toLocaleString('en-US')} bytes remaining.\n\n${Object.entries(report.byProduct).sort((a, b) => b[1] - a[1]).map(([product, bytes]) => `- ${product}: ${bytes.toLocaleString('en-US')} bytes`).join('\n')}\n`);
