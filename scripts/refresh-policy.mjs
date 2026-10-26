// Provider groups and aliases accepted by the refresh workflows.
export const modelRefreshGroups = ['noaa-cloud', 'rrfs', 'dwd', 'eccc'];
export const refreshGroups = [...modelRefreshGroups, 'observations', 'terrain'];
export const refreshWorkflow = group => {
  if (!refreshGroups.includes(group)) throw new Error(`Unknown refresh group: ${group}`);
  return `refresh-${group}.yml`;
};
export function refreshSelection(selection) {
  if (selection === 'all') return refreshGroups;
  if (selection === 'models') return modelRefreshGroups;
  const group = selection === 'icon-eu' ? 'dwd' : selection;
  if (!refreshGroups.includes(group)) throw new Error(`Unknown refresh selection: ${selection}`);
  return [group];
}
