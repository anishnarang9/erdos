// Domain oracle. It reads file bytes and challenge.spec. It does not evaluate plan.rules.
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

const sha = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const decoder = new TextDecoder('utf-8', {fatal: true});
const minimum = -(1n << 63n);
const maximum = (1n << 63n) - 1n;

class Rejected extends Error {
  constructor(requirement, message) {
    super(message);
    this.requirement = requirement;
  }
}

const reject = (requirement, message) => {
  throw new Rejected(requirement, message);
};

function integer(value) {
  if (typeof value !== 'string' || !/^(-?(?:0|[1-9][0-9]*))$/.test(value)) {
    reject('input-types', 'Expected a normalized decimal i64 string');
  }
  const number = BigInt(value);
  if (number < minimum || number > maximum) reject('input-types', 'Integer exceeds i64 range');
  return number;
}

function scalar(value, type) {
  if (type === 'i64') return integer(value);
  if (type === 'bool') {
    if (typeof value !== 'boolean') reject('input-types', 'Expected a Boolean');
    return value;
  }
  if (typeof value !== 'string') reject('input-types', 'Expected a string');
  return value;
}

function strictParse(bytes) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    reject('input-types', 'Expected UTF-8 JSON');
  }
  let index = 0;
  const fail = () => reject('input-types', 'Expected strict JSON');
  const skip = () => {
    while (text[index] === ' ' || text[index] === '\n' || text[index] === '\r' || text[index] === '\t') index += 1;
  };
  const parseString = () => {
    if (text[index] !== '"') fail();
    index += 1;
    let value = '';
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (char === '"') return value;
      if (char === '\\') {
        const next = text[index];
        index += 1;
        if (next === '"' || next === '\\' || next === '/') value += next;
        else if (next === 'b') value += '\b';
        else if (next === 'f') value += '\f';
        else if (next === 'n') value += '\n';
        else if (next === 'r') value += '\r';
        else if (next === 't') value += '\t';
        else if (next === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else fail();
      } else if (char >= '\u0000' && char <= '\u001f') fail();
      else value += char;
    }
    fail();
  };
  const parseNumber = () => {
    const start = index;
    if (text[index] === '-') index += 1;
    if (text[index] === '0') index += 1;
    else if (text[index] >= '1' && text[index] <= '9') {
      while (text[index] >= '0' && text[index] <= '9') index += 1;
    } else fail();
    if (text[index] === '.') {
      index += 1;
      if (!(text[index] >= '0' && text[index] <= '9')) fail();
      while (text[index] >= '0' && text[index] <= '9') index += 1;
    }
    if (text[index] === 'e' || text[index] === 'E') {
      index += 1;
      if (text[index] === '+' || text[index] === '-') index += 1;
      if (!(text[index] >= '0' && text[index] <= '9')) fail();
      while (text[index] >= '0' && text[index] <= '9') index += 1;
    }
    return Number(text.slice(start, index));
  };
  const parseValue = () => {
    skip();
    const char = text[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    fail();
  };
  const parseObject = () => {
    index += 1;
    skip();
    const object = {};
    if (text[index] === '}') {
      index += 1;
      return object;
    }
    while (index < text.length) {
      skip();
      const key = parseString();
      if (Object.hasOwn(object, key)) reject('duplicate-key', `Duplicate object key ${key}`);
      skip();
      if (text[index] !== ':') fail();
      index += 1;
      object[key] = parseValue();
      skip();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return object;
      }
      fail();
    }
    fail();
  };
  const parseArray = () => {
    index += 1;
    skip();
    const values = [];
    if (text[index] === ']') {
      index += 1;
      return values;
    }
    while (index < text.length) {
      values.push(parseValue());
      skip();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return values;
      }
      fail();
    }
    fail();
  };
  const value = parseValue();
  skip();
  if (index !== text.length) fail();
  return value;
}

function checkDepth(value, depth = 1) {
  if (depth > 32) reject('input-types', 'JSON nesting exceeds 32');
  if (Array.isArray(value)) {
    if (value.length > 256) reject('input-types', 'Array exceeds 256 items');
    for (const child of value) checkDepth(child, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) checkDepth(child, depth + 1);
  }
}

function parseFile(declaration, bytes) {
  if (declaration.parser === 'opaque/v1') return bytes;
  if (declaration.parser === 'text/v1') {
    try {
      return decoder.decode(bytes);
    } catch {
      reject('input-types', 'Expected UTF-8 text');
    }
  }
  const value = strictParse(bytes);
  checkDepth(value);
  if (!value || Array.isArray(value) || typeof value !== 'object') reject('input-types', 'Expected a JSON object');
  const parsed = {};
  for (const field of declaration.fields ?? []) {
    if (!Object.hasOwn(value, field.name)) reject('input-types', `Missing ${field.name}`);
    parsed[field.name] = scalar(value[field.name], field.type);
  }
  for (const collection of declaration.collections ?? []) {
    const rows = value[collection.name];
    if (!Array.isArray(rows) || rows.length > 256) reject('input-types', 'Expected at most 256 records');
    parsed[collection.name] = rows.map((row) => {
      if (!row || Array.isArray(row) || typeof row !== 'object') reject('input-types', 'Expected a record');
      return Object.fromEntries(collection.fields.map((field) => {
        if (!Object.hasOwn(row, field.name)) reject('input-types', `Missing ${field.name}`);
        return [field.name, scalar(row[field.name], field.type)];
      }));
    });
  }
  return parsed;
}

async function readDeclared(directory, declarations, maxBytes) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    reject('file-set', 'The candidate directory is missing');
  }
  if (names.length !== declarations.length || declarations.some((item) => !names.includes(item.name))) {
    reject('file-set', 'The actual files differ from the declared file set');
  }
  const values = {};
  const raw = {};
  let size = 3;
  for (const declaration of declarations) {
    const bytes = await readFile(join(directory, declaration.name));
    size += 6 + Buffer.byteLength(declaration.name) + bytes.length;
    if (size > maxBytes) reject('input-types', 'Bundle exceeds its byte limit');
    raw[declaration.name] = bytes;
    values[declaration.name] = parseFile(declaration, bytes);
  }
  return {values, raw};
}

function keyed(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (map.has(row[key])) reject('reference-membership', 'Reference keys must be unique');
    map.set(row[key], row);
  }
  return map;
}

function member(map, key) {
  const found = map.get(key);
  if (!found) reject('reference-membership', 'Candidate key has no reference row');
  return found;
}

const distinct = (rows, key) => new Set(rows.map((row) => row[key])).size === rows.length;
const violations = (pairs) => pairs.filter(([, ok]) => !ok).map(([id]) => id);

function checked(op, left, right) {
  const value = op === 'add' ? left + right : op === 'sub' ? left - right : left * right;
  if (value < minimum || value > maximum) reject('arithmetic-overflow', 'Arithmetic exceeds i64');
  return value;
}

function checkedSum(values) {
  return values.reduce((total, value) => checked('add', total, value), 0n);
}

function drawerExact(delivery, reference, spec) {
  const rows = delivery.values['drawers.json'].rows;
  const floats = keyed(reference.values['floats.json'].rows, 'drawerId');
  const matched = rows.map((row) => row.countedCents === member(floats, row.drawerId).expectedCents);
  return violations([
    ['unique-drawer', distinct(rows, 'drawerId')],
    ['drawer-count', rows.length === reference.values['floats.json'].rows.length],
    ['exact-count', matched.every(Boolean)],
    ['closeout-text', delivery.values['closeout.txt'] === spec.text],
  ]);
}

/** Read the candidate files and return pass, fail, or rejection. */
export async function evaluateCandidate(challenge, candidateDirectory, {referenceDirectory, contextHex} = {}) {
  if (challenge.classification !== 'supported') throw Error('The oracle accepts only supported challenges');
  try {
    const schema = challenge.schema;
    const delivery = await readDeclared(join(candidateDirectory, 'delivery'), schema.deliverables, 16384);
    const reference = await readDeclared(
      referenceDirectory ?? join(candidateDirectory, '..', '..', 'reference'),
      schema.references,
      32768,
    );
    let violated;
    switch (challenge.spec.kind) {
      case 'drawer-exact':
        violated = drawerExact(delivery, reference, challenge.spec);
        break;
      default:
        throw Error(`No independent domain oracle for ${challenge.spec.kind}`);
    }
    return {status: violated.length ? 'fail' : 'pass', verdict: violated.length ? 0 : 1, violatedRequirements: violated};
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    return {status: 'reject', verdict: null, violatedRequirements: [error.requirement], reason: error.message};
  }
}
