// A small JSON Schema validator for exactly the keywords the Huntaway contract uses (no dependencies).
export function makeValidator(schema) {
  const KNOWN = new Set(["$schema", "$id", "title", "description", "type", "additionalProperties", "required", "properties",
    "$defs", "$ref", "const", "enum", "pattern", "items", "oneOf", "allOf", "if", "then"]);

  function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v === "number" ? "number" : typeof v;
  }

  // Returns a list of error strings (empty = valid).
  function validate(s, v, at = "$") {
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema keyword not supported by the test validator: ${k}`);
    if (s.$ref) {
      const name = s.$ref.replace("#/$defs/", "");
      if (!schema.$defs[name]) throw new Error(`unknown $ref ${s.$ref}`);
      return validate(schema.$defs[name], v, at);
    }
    const errs = [];
    if (s.type && typeOf(v) !== s.type) return [`${at}: expected ${s.type}, got ${typeOf(v)}`];
    if ("const" in s && v !== s.const) errs.push(`${at}: expected ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (s.pattern && (typeof v !== "string" || !new RegExp(s.pattern, "u").test(v))) errs.push(`${at}: does not match ${s.pattern}`);
    if (typeOf(v) === "object") {
      for (const r of s.required ?? []) if (!(r in v)) errs.push(`${at}: missing ${r}`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) errs.push(...validate(sub, v[k], `${at}.${k}`));
      if (s.additionalProperties === false) {
        for (const k of Object.keys(v)) if (!(k in (s.properties ?? {}))) errs.push(`${at}: unexpected field ${k}`);
      }
    }
    if (s.items && Array.isArray(v)) v.forEach((x, i) => errs.push(...validate(s.items, x, `${at}[${i}]`)));
    if (s.oneOf) {
      const ok = s.oneOf.filter((alt) => validate(alt, v, at).length === 0).length;
      if (ok !== 1) errs.push(`${at}: matches ${ok} of oneOf, expected exactly 1`);
    }
    for (const part of s.allOf ?? []) {
      if (part.if) {
        if (validate(part.if, v, at).length === 0 && part.then) errs.push(...validate(part.then, v, at));
      } else {
        errs.push(...validate(part, v, at));
      }
    }
    return errs;
  }
  return (value, sub = schema) => validate(sub, value);
}
