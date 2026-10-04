// A URI scheme must start with a letter. Keep accepting references already
// returned by 0.14.0, but emit only valid URIs in MCP embedded resources.
export const businessReference = (kind, ...parts) =>
  'lab110://' + kind + '/' + parts.map(value => encodeURIComponent(value)).join('/');

export function parseBusinessReference(value) {
  const url = new URL(value.replace(/^110lab:\/\//, 'lab110://'));
  if (url.protocol !== 'lab110:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Invalid private attachment reference');
  }
  return url;
}
