export function replaceUri(uri) {
  return uri.split('|').filter(s => !(s.indexOf(':') !== -1 || s.indexOf('(') !== -1)).join('|');
}