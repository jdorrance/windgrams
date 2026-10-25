// GitHub Actions API requests for refresh artifacts and workflow dispatches.
export function githubApi({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid GitHub repository');
  return async (path, body) => {
    if (!path.startsWith('/actions/')) throw new Error('Expected an Actions API path');
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub Actions ${response.status}: ${path}`);
    return response.status === 204 ? null : response.json();
  };
}
