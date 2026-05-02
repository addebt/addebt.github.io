const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Decimal = require('decimal.js');
const LZString = require('lz-string');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function loadApp() {
  let counter = 0;
  const cryptoShim = { randomUUID: () => `id-${++counter}` };
  const windowShim = {};
  const wrapped = `
    (function(window, crypto, Decimal, LZString) {
      ${SOURCE}
      return { splitDebt, emptyCalc, encodeCalc, decodeCalc };
    })
  `;
  const factory = vm.runInThisContext(wrapped, { filename: 'app.js' });
  const exports = factory(windowShim, cryptoShim, Decimal, LZString);
  return { ...exports, windowShim };
}

function makeInstance(splitDebt, calc) {
  const inst = splitDebt();
  if (calc) inst.calc = calc;
  return inst;
}

test('emptyCalc has expected shape', () => {
  const { emptyCalc } = loadApp();
  assert.deepEqual(emptyCalc(), { persons: [], groups: [], spends: [] });
});

test('encode/decode round trip preserves all fields', () => {
  const { encodeCalc, decodeCalc } = loadApp();
  const calc = {
    persons: [
      { id: 'p1', name: 'Alice', groupId: 'g1' },
      { id: 'p2', name: 'Bob', groupId: '' },
    ],
    groups: [{ id: 'g1', name: 'Family' }],
    spends: [
      { id: 's1', value: '100', sponsorId: 'p1', consumerIds: '__all__' },
      { id: 's2', value: '50', sponsorId: 'p2', consumerIds: ['p1'] },
    ],
  };
  const decoded = decodeCalc(encodeCalc(calc));
  assert.deepEqual(decoded, calc);
});

test('decodeCalc returns null on garbage input', () => {
  const { decodeCalc } = loadApp();
  assert.equal(decodeCalc('not-a-real-payload'), null);
  assert.equal(decodeCalc(''), null);
});

test('decodeCalc rejects payloads with mismatched schema version', () => {
  const { decodeCalc } = loadApp();
  const json = JSON.stringify({ v: 999, p: [], g: [], s: [] });
  const encoded = LZString.compressToEncodedURIComponent(json);
  assert.equal(decodeCalc(encoded), null);
});

test('recompute on empty calc yields null result', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.recompute();
  assert.equal(inst.result, null);
});

test('recompute: simple two-person split', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'Alice', groupId: '' },
      { id: 'B', name: 'Bob', groupId: '' },
    ],
    groups: [],
    spends: [{ id: 's1', value: '100', sponsorId: 'A', consumerIds: '__all__' }],
  });
  inst.recompute();
  assert.equal(inst.result.transactions.length, 1);
  const tx = inst.result.transactions[0];
  assert.equal(tx.from, 'B');
  assert.equal(tx.to, 'A');
  assert.equal(tx.value.toString(), '50');
});

test('recompute: 100/3 produces two 33.33 transactions (1 kopek residue is dropped)', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
      { id: 'C', name: 'C', groupId: '' },
    ],
    groups: [],
    spends: [{ id: 's1', value: '100', sponsorId: 'A', consumerIds: '__all__' }],
  });
  inst.recompute();
  assert.equal(inst.result.transactions.length, 2);
  for (const tx of inst.result.transactions) {
    assert.equal(tx.to, 'A');
    assert.equal(tx.value.toString(), '33.33');
  }
});

test('recompute: aggregates persons sharing a wallet (group)', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: 'W' },
      { id: 'B', name: 'B', groupId: 'W' },
      { id: 'C', name: 'C', groupId: '' },
    ],
    groups: [{ id: 'W', name: 'Family' }],
    spends: [{ id: 's1', value: '60', sponsorId: 'A', consumerIds: '__all__' }],
  });
  inst.recompute();
  // wallet W consumes 40 (A+B), paid 60 → -20 ; C consumes 20 → +20
  assert.equal(inst.result.transactions.length, 1);
  const tx = inst.result.transactions[0];
  assert.equal(tx.from, 'C');
  assert.equal(tx.to, 'W');
  assert.equal(tx.fromName, 'C');
  assert.equal(tx.toName, 'Family');
  assert.equal(tx.value.toString(), '20');
});

test('recompute: ignores spends with invalid sponsor or non-positive value', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
    ],
    groups: [],
    spends: [
      { id: 's1', value: '100', sponsorId: 'GHOST', consumerIds: '__all__' },
      { id: 's2', value: '0', sponsorId: 'A', consumerIds: '__all__' },
      { id: 's3', value: '', sponsorId: 'A', consumerIds: '__all__' },
      { id: 's4', value: '-10', sponsorId: 'A', consumerIds: '__all__' },
    ],
  });
  inst.recompute();
  assert.equal(inst.result, null);
});

test('recompute: filters consumer ids to existing persons', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
    ],
    groups: [],
    spends: [{ id: 's1', value: '100', sponsorId: 'A', consumerIds: ['A', 'B', 'GHOST'] }],
  });
  inst.recompute();
  assert.equal(inst.result.transactions.length, 1);
  assert.equal(inst.result.transactions[0].value.toString(), '50');
});

test('recompute: subset consumers (sponsor not among them)', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
      { id: 'C', name: 'C', groupId: '' },
    ],
    groups: [],
    spends: [{ id: 's1', value: '40', sponsorId: 'A', consumerIds: ['B', 'C'] }],
  });
  inst.recompute();
  assert.equal(inst.result.transactions.length, 2);
  for (const tx of inst.result.transactions) {
    assert.equal(tx.to, 'A');
    assert.equal(tx.value.toString(), '20');
  }
});

test('recompute: balance signs reflect debt direction', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
    ],
    groups: [],
    spends: [{ id: 's1', value: '100', sponsorId: 'A', consumerIds: '__all__' }],
  });
  inst.recompute();
  const a = inst.result.balances.find(b => b.wallet === 'A');
  const b = inst.result.balances.find(b => b.wallet === 'B');
  assert.equal(a.sign, -1, 'creditor balance is negative');
  assert.equal(b.sign, 1, 'debtor balance is positive');
});

test('recompute: zero-sum scenario produces no transactions', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
    ],
    groups: [],
    spends: [
      { id: 's1', value: '50', sponsorId: 'A', consumerIds: '__all__' },
      { id: 's2', value: '50', sponsorId: 'B', consumerIds: '__all__' },
    ],
  });
  inst.recompute();
  assert.equal(inst.result.transactions.length, 0);
});

test('addAdHocPerson appends an entry with empty fields', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.addAdHocPerson();
  assert.equal(inst.calc.persons.length, 1);
  assert.equal(inst.calc.persons[0].name, '');
  assert.equal(inst.calc.persons[0].groupId, '');
});

test('removeParticipant clears sponsor and consumer references', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.addAdHocPerson();
  inst.addAdHocPerson();
  inst.calc.persons[0].name = 'A';
  inst.calc.persons[1].name = 'B';
  const aId = inst.calc.persons[0].id;
  const bId = inst.calc.persons[1].id;
  inst.calc.spends.push({
    id: 'S', value: '10', sponsorId: aId, consumerIds: [aId, bId],
  });
  inst.removeParticipant(0);
  assert.equal(inst.calc.persons.length, 1);
  assert.equal(inst.calc.spends[0].sponsorId, '');
  assert.deepEqual(inst.calc.spends[0].consumerIds, [bId]);
});

test('cleanupGroups drops unused wallets', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [{ id: 'A', name: 'A', groupId: 'g1' }],
    groups: [
      { id: 'g1', name: 'Used' },
      { id: 'g2', name: 'Orphan' },
    ],
    spends: [],
  });
  inst.cleanupGroups();
  assert.deepEqual(inst.calc.groups, [{ id: 'g1', name: 'Used' }]);
});

test('toggleAllConsumers flips between __all__ and explicit list', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons = [
    { id: 'A', name: 'A', groupId: '' },
    { id: 'B', name: 'B', groupId: '' },
  ];
  const s = { id: 's', value: '10', sponsorId: 'A', consumerIds: '__all__' };
  inst.toggleAllConsumers(s);
  assert.deepEqual(s.consumerIds, ['A', 'B']);
  inst.toggleAllConsumers(s);
  assert.equal(s.consumerIds, '__all__');
});

test('toggleConsumer adds and removes ids', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  const s = { consumerIds: [] };
  inst.toggleConsumer(s, 'A');
  assert.deepEqual(s.consumerIds, ['A']);
  inst.toggleConsumer(s, 'B');
  assert.deepEqual(s.consumerIds, ['A', 'B']);
  inst.toggleConsumer(s, 'A');
  assert.deepEqual(s.consumerIds, ['B']);
});

test('addSpend appends a default __all__ spend', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.addSpend();
  assert.equal(inst.calc.spends.length, 1);
  assert.equal(inst.calc.spends[0].consumerIds, '__all__');
  assert.equal(inst.calc.spends[0].sponsorId, '');
});

test('removeSpend removes by index', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.spends = [
    { id: 's1', value: '1', sponsorId: '', consumerIds: '__all__' },
    { id: 's2', value: '2', sponsorId: '', consumerIds: '__all__' },
  ];
  inst.removeSpend(0);
  assert.equal(inst.calc.spends.length, 1);
  assert.equal(inst.calc.spends[0].id, 's2');
});
