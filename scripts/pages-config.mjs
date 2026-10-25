import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function httpUrl(value, label) {
  if (/[?#\\\r\n]/.test(value)) throw new Error(`${label} must be an HTTP(S) URL without credentials, query or fragment.`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query or fragment.`);
  }
  return url;
}

export function pagesUrls(env) {
  const [owner, repo, extra] = (env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo || extra) throw new Error('GITHUB_REPOSITORY must be owner/repository.');
  const userSite = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  const site = env.WINDGRAMS_SITE?.trim() || `https://${owner}.github.io${userSite ? '' : `/${repo}`}`;
  httpUrl(site, 'Site');
  const base = env.WINDGRAMS_BASE?.trim() || (userSite ? '/' : `/${repo}`);
  if (!base.startsWith('/') || base.startsWith('//') || /[?#\\\r\n]/.test(base)) throw new Error('Base must be a root-relative URL path.');
  const configured = env.WINDGRAMS_DATA_BASE?.trim() || `${site.replace(/\/+$/, '')}/data`;
  if (configured.startsWith('//') || /[?#\\\r\n]/.test(configured)) throw new Error('Data origin must be an HTTP(S) URL or root-relative path.');
  const data = httpUrl(configured.startsWith('/') ? new URL(configured, site).href : configured, 'Data origin').href.replace(/\/+$/, '');
  return { site, base, data };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = pagesUrls(process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}
