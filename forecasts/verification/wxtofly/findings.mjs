// Evidence-based interpretation and recommendations; never changes comparison values.
export function buildFindings(r, snapshot) {
  const findings = [];
  const add = (id, priority, category, title, evidence, recommendation, confidence = 'high') =>
    findings.push({ id, priority, category, title, evidence, recommendation, confidence });
  const missingInit = snapshot.wxProducts.filter((w) => w.status === 'parsed' && !w.referenceTime);
  if (missingInit.length)
    add(
      'F01',
      'P1',
      'evidence gap',
      'WxToFly initialization times are absent from numeric products',
      { products: missingInit.length, sample: missingInit.slice(0, 3).map((w) => w.entry) },
      'Recover authoritative RASP run metadata before interpreting differences as equal-lead forecast comparisons.',
    );
  const latest = r.rows.filter((x) => x.cohort === 'latest-live');
  add(
    'F02',
    latest.length ? 'P2' : 'P1',
    'delivery/coverage',
    latest.length
      ? 'Latest publications have partial exact-time overlap'
      : 'Latest publications have no scored exact-time overlap',
    {
      latestPairs: latest.length,
      latestValidTimes: [...new Set(latest.map((r) => r.validAt))],
      latestModels: [...new Set(latest.map((r) => r.model))],
      archivedPairs: r.rows.length - latest.length,
      wxDates: [...new Set(snapshot.wxProducts.map((w) => w.date).filter(Boolean))],
    },
    'Keep latest-live availability and retained-archive comparisons separate; capture simultaneous updates for a stronger next comparison.',
  );
  add(
    'F03',
    'P1',
    'confirmed semantic mismatch',
    '“Convergence” in cm/s cannot validate horizontal convergence',
    {
      wxField: 'cm/s_ Convergence',
      ourFields: ['convergence10mX1e5', 'convergence925X1e5'],
      units: ['m/s', '10⁻⁵ s⁻¹'],
    },
    'Correct the review equivalence mapping. Require matching vertical-velocity layer/extremum definitions for any future comparison; do not alter production convergence from this evidence.',
  );
  const terrain = snapshot.matches
    .filter((m) => m.status === 'matched')
    .map((m) => {
      const w = snapshot.wxProducts.find((w) => w.id === m.wxId);
      const rows = r.rows.filter((x) => x.site === m.site.slug && x.terrainDifferenceM !== null);
      return {
        site: m.site.slug,
        distanceKm: m.distanceKm,
        wxTerrainM: w.modelElevationM,
        maxAbsoluteTerrainDifferenceM: rows.length
          ? Math.max(...rows.map((x) => Math.abs(x.terrainDifferenceM)))
          : null,
      };
    });
  add(
    'F04',
    'P2',
    'explainable model difference',
    'Terrain and grid offsets confound launch-level comparisons',
    { sites: terrain },
    'Inspect both MSL and each model’s AGL profiles at the fixed cases; do not shift a model column to launch height and call it an atmospheric correction.',
  );
  const failures = r.methodAudit.filter((x) => !x.pass);
  add(
    'F05',
    failures.length ? 'P1' : 'P3',
    failures.length ? 'unresolved numerical discrepancy' : 'numerical consistency',
    failures.length
      ? 'Independent reference checks need investigation'
      : 'Published diagnostics pass the independent reference checks performed',
    { checks: r.methodAudit.length, failures: failures.length, examples: failures.slice(0, 12) },
    failures.length
      ? 'Reproduce each failure from its hashed source column and method version before proposing a correction.'
      : 'Retain these checks as reproducibility evidence; they do not establish real-world forecast accuracy.',
  );
  const regional = r.regionalAudit.filter((x) => !x.pass),
    render = r.rendererAudit.filter((x) => !x.pass),
    browser = r.browserAudit.filter((x) => !x.pass);
  add(
    'F06',
    regional.length || render.length || browser.length ? 'P1' : 'P3',
    'internal consistency',
    regional.length || render.length || browser.length
      ? 'Internal view agreement needs investigation'
      : 'Checked map/profile and renderer values agree',
    {
      regionalChecks: r.regionalAudit.length,
      regionalFailures: regional,
      renderChecks: r.rendererAudit.length,
      renderFailures: render,
      browserChecks: r.browserAudit.length,
      browserFailures: browser,
    },
    'Keep deployed-browser checks separate from checkout checks; test the specific field, hour and cell before changing chart logic.',
  );
  add(
    'F07',
    'P2',
    'evidence gap',
    'Image-only fields and incomplete history limit the scientific conclusion',
    {
      gaps: snapshot.gaps,
      observationComparisons: r.observations.comparisons.length,
      archiveRuns: snapshot.archives.length,
    },
    'Obtain native RASP columns and dated archives to evaluate upper-air differences and recurrence; expand independent observations before making skill claims.',
  );
  for (const finding of findings) {
    finding.affectedProducts =
      finding.id === 'F03'
        ? ['provider-inventory equivalence matrix', 'regional convergence maps']
        : finding.id === 'F06'
          ? ['windgrams', 'maps', 'soundings']
          : ['Blipspots', 'windgrams', 'regional maps', 'soundings'];
    finding.validationNeeded =
      finding.id === 'F03'
        ? 'Verify dimensions and exact layer/extremum definition against the frozen DrJack/WxToFly parameter documentation.'
        : finding.id === 'F06'
          ? 'Replay the same hashed profile, hour, units and native cell; compare deployed readouts with original published values.'
          : finding.id === 'F05'
            ? 'Repeat independent source-column reference calculations with rounding bounds for the issued method version.'
            : 'Collect verified initialization, exact valid time, native column and sufficient independent matched station-days; rerun offline.';
  }
  return findings.sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id));
}
