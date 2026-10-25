import { writeFileSync } from 'node:fs';
import { regionalWireSchemas } from '../dist/regional-types.js';
import { gridWireSchema } from '../dist/regional-documents.js';
import { columnWireSchema } from '../dist/atmosphere.js';

// Structural schemas come from runtime validators. Cross-field rules remain
// in those validators and are exercised by shared valid/invalid fixtures.
const schemas = { ...regionalWireSchemas(), grid: gridWireSchema(), column: columnWireSchema() };
writeFileSync(new URL('../dist/wire-schemas.json', import.meta.url), `${JSON.stringify(schemas, null, 2)}\n`);
