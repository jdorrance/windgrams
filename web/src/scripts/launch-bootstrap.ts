// Keep startup independent of the larger chart dependencies so a failed module
// or data load produces a useful message instead of permanent loading spinners.
const errorNotice = document.getElementById('forecast-error')!;
document.getElementById('forecast-reload')!.addEventListener('click', () => window.location.reload());

void import('./launch-page.ts').then(({ start }) => start()).catch(error => {
  console.error('Launch forecast could not start', error);
  errorNotice.hidden = false;
  for (const node of document.querySelectorAll<HTMLElement>('.is-loading')) node.classList.remove('is-loading');
  for (const node of document.querySelectorAll<HTMLElement>('.chart-status')) {
    if (node.textContent?.startsWith('Loading')) node.textContent = 'Forecast unavailable. Please reload to try again.';
  }
  const select = document.getElementById('model-select') as HTMLSelectElement;
  if (select.options[0]?.textContent === 'Loading models…') {
    select.replaceChildren(new Option('Models unavailable', ''));
  }
});

void import('./station.ts').catch(error => {
  console.error('Station could not start', error);
  const status = document.getElementById('station-status');
  if (status) status.textContent = 'Station report unavailable. Please reload to try again.';
});
