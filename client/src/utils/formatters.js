export const pluralize = (count, singular) => {
  const plural = singular.endsWith('y')
    ? `${singular.slice(0, -1)}ies`
    : `${singular}s`;

  if (count === 0) return `No ${plural}`;
  return `${count} ${count === 1 ? singular : plural}`;
};

export const shortSha = (sha) => (
  typeof sha === 'string' ? sha.slice(0, 7) : ''
);

export const timeAgo = (value, now = Date.now()) => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Date unavailable';

  const differenceSeconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(differenceSeconds);
  const future = differenceSeconds > 0;
  let amount;
  let unit;

  if (absoluteSeconds < 60) return future ? 'in less than a minute' : 'just now';
  if (absoluteSeconds < 3600) {
    amount = Math.round(absoluteSeconds / 60);
    unit = 'm';
  } else if (absoluteSeconds < 86_400) {
    amount = Math.round(absoluteSeconds / 3600);
    unit = 'h';
  } else if (absoluteSeconds < 2_592_000) {
    amount = Math.round(absoluteSeconds / 86_400);
    unit = 'd';
  } else if (absoluteSeconds < 31_536_000) {
    amount = Math.round(absoluteSeconds / 2_592_000);
    unit = 'mo';
  } else {
    amount = Math.round(absoluteSeconds / 31_536_000);
    unit = 'y';
  }

  return future ? `in ${amount}${unit}` : `${amount}${unit} ago`;
};
