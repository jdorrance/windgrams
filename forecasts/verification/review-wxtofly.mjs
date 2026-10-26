#!/usr/bin/env node
// Public boundary: capture served bytes; compare frozen evidence offline. See wxtofly/README.md.
import { parseArgs } from 'node:util';
import { captureReview } from './wxtofly/capture.mjs';
import { compareReview } from './wxtofly/compare.mjs';
import { writeReviewHtml } from './wxtofly/report.mjs';

const help = `Scientific review (Node 24+)\n\nCapture: --site-url URL --wx-url URL --output DIR [--data-url URL] [--archive-root DIR] [--archive-days 30]\nCompare: --snapshot DIR [--output DIR] [--archive-days 30] [--inspection FILE]\n\nCapture never overwrites a completed snapshot. Compare has no network access and verifies hashes.\nOutputs: report.json and interactive index.html. No forecast calculation or deployment changes.\n`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries([
      ['help', { type: 'boolean' }],
      ...['site-url', 'wx-url', 'data-url', 'output', 'snapshot', 'archive-root', 'archive-days', 'inspection'].map(
        (k) => [k, { type: 'string' }],
      ),
    ]),
  });
  const [operation, ...extra] = positionals;
  if (values.help) {
    console.log(help);
  } else if (extra.length || !['capture', 'compare'].includes(operation)) throw new Error(help);
  else {
    const archiveDays = values['archive-days'] === undefined ? 30 : Number(values['archive-days']);
    if (!Number.isInteger(archiveDays) || archiveDays < 1 || archiveDays > 30)
      throw new Error('--archive-days must be an integer from 1 to 30');
    if (operation === 'capture') {
      if (!values.output) throw new Error('capture requires --output DIR');
      await captureReview({
        siteUrl: values['site-url'],
        wxUrl: values['wx-url'],
        dataUrl: values['data-url'],
        output: values.output,
        archiveRoot: values['archive-root'],
        archiveDays,
      });
    } else {
      if (!values.snapshot) throw new Error('compare requires --snapshot DIR');
      const options = { snapshot: values.snapshot, output: values.output, archiveDays, inspection: values.inspection };
      const report = await compareReview(options);
      const path = await writeReviewHtml(report, options);
      console.log(
        JSON.stringify(
          {
            report: path,
            matchedSites: report.siteMatches.filter((s) => s.status === 'matched').length,
            pairs: report.rows.length,
            coverage: report.coverageCounts,
            methodChecks: report.methodAuditSummary,
          },
          null,
          2,
        ),
      );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
