export function testEq(lt, rt) {
  if (lt === rt) return true;
  if (lt[0] === ':') return true;
  if (rt[0] === ':') return true;
  return false;
}

export function testURIs(a, b) {
  a = parseMangledUri(a);
  b = parseMangledUri(b);
  if (a.method !== b.method) return false;
  if (a.uri === b.uri) return true;
  if (a.tokens.length !== b.tokens.length) return false;
  const notEquivalent: boolean = a.tokens.some((v, i) => {
    const rhs = b.tokens[i];
    return !testEq(v, rhs);
  });
  return !notEquivalent;
}

export function parseMangledUri(a) {
  const [method, uri] = a.split('@');
  const tokens = uri.split('|').filter(Boolean);
  return { method, uri, tokens };
}
