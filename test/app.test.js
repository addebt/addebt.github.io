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
      { id: 's1', value: '100', sponsorId: 'p1', consumerIds: '__all__', note: 'ужин' },
      { id: 's2', value: '50', sponsorId: 'p2', consumerIds: ['p1'], note: '' },
    ],
  };
  const decoded = decodeCalc(encodeCalc(calc));
  assert.deepEqual(decoded, calc);
});

test('decodeCalc fills missing note as empty string (backward compat)', () => {
  const { decodeCalc } = loadApp();
  // hand-crafted v1 payload without `t` key (pre-note schema)
  const payload = {
    v: 1,
    p: [{ i: 'A', n: 'A', g: null }],
    g: [],
    s: [{ i: 's1', v: '10', sp: 'A', c: '*' }],
  };
  const encoded = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
  const decoded = decodeCalc(encoded);
  assert.equal(decoded.spends[0].note, '');
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
  assert.equal(inst.calc.spends[0].note, '');
});

test('onPersonGroupChange creates an empty-named wallet (no prompt)', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons = [{ id: 'A', name: 'A', groupId: '__new__' }];
  inst.onPersonGroupChange(inst.calc.persons[0]);
  assert.equal(inst.calc.groups.length, 1);
  assert.equal(inst.calc.groups[0].name, '');
  assert.equal(inst.calc.persons[0].groupId, inst.calc.groups[0].id);
});

test('walletFor returns the wallet object or null', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  const g = { id: 'g1', name: 'Family' };
  inst.calc.groups = [g];
  inst.calc.persons = [
    { id: 'A', name: 'A', groupId: 'g1' },
    { id: 'B', name: 'B', groupId: '' },
  ];
  assert.equal(inst.walletFor(inst.calc.persons[0]), g);
  assert.equal(inst.walletFor(inst.calc.persons[1]), null);
});

test('setWalletName updates the wallet referenced by person', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  const g = { id: 'g1', name: '' };
  inst.calc.groups = [g];
  inst.calc.persons = [{ id: 'A', name: 'A', groupId: 'g1' }];
  inst.setWalletName(inst.calc.persons[0], 'Семья');
  assert.equal(g.name, 'Семья');
});

test('loadExample builds calc through the regular flow with no issues', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.loadExample();
  assert.equal(inst.calc.persons.length, 3);
  assert.equal(inst.calc.spends.length, 3);
  for (const p of inst.calc.persons) {
    assert.equal(inst.personIssue(p), null, `person ${p.name} should be valid`);
  }
  for (const s of inst.calc.spends) {
    assert.equal(inst.spendIssue(s), null, `spend ${s.note} should be valid`);
  }
  inst.recompute();
  assert.notEqual(inst.result, null);
  assert.ok(inst.result.transactions.length > 0);
  assert.equal(inst.result.summary.skippedSpends, 0);
  assert.equal(inst.result.summary.skippedPersons, 0);
});

test('loadExample over an existing calc clears persons/spends/groups in place (no reassignment)', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);

  // pre-populate with junk + a wallet
  inst.addAdHocPerson();
  inst.calc.persons[0].name = 'Old';
  inst.calc.persons[0].groupId = '__new__';
  inst.onPersonGroupChange(inst.calc.persons[0]);
  inst.addSpend();

  const calcRef = inst.calc;
  const personsRef = inst.calc.persons;
  const spendsRef = inst.calc.spends;
  const groupsRef = inst.calc.groups;

  inst.loadExample();

  // same array/object identities (so Alpine $watch keeps tracking)
  assert.equal(inst.calc, calcRef);
  assert.equal(inst.calc.persons, personsRef);
  assert.equal(inst.calc.spends, spendsRef);
  assert.equal(inst.calc.groups, groupsRef);

  assert.equal(inst.calc.persons.length, 3);
  assert.equal(inst.calc.spends.length, 3);
  assert.equal(inst.calc.groups.length, 0);
});

test('personIssue: empty/whitespace name flagged, valid name passes', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  assert.ok(inst.personIssue({ name: '' }));
  assert.ok(inst.personIssue({ name: '   ' }));
  assert.ok(inst.personIssue({}));
  assert.equal(inst.personIssue({ name: 'A' }), null);
});

test('spendIssue: each invalid state returns a reason, valid returns null', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons = [
    { id: 'A', name: 'A', groupId: '' },
    { id: 'B', name: 'B', groupId: '' },
    { id: 'X', name: '', groupId: '' },
  ];

  // valid
  assert.equal(inst.spendIssue({
    value: '10', sponsorId: 'A', consumerIds: '__all__',
  }), null);

  // empty value
  assert.match(inst.spendIssue({
    value: '', sponsorId: 'A', consumerIds: '__all__',
  }), /сумм/);

  // non-positive
  assert.match(inst.spendIssue({
    value: '-1', sponsorId: 'A', consumerIds: '__all__',
  }), /больше нуля/);
  assert.match(inst.spendIssue({
    value: '0', sponsorId: 'A', consumerIds: '__all__',
  }), /больше нуля/);

  // missing sponsor
  assert.match(inst.spendIssue({
    value: '10', sponsorId: '', consumerIds: '__all__',
  }), /кто заплатил/);

  // sponsor without name
  assert.match(inst.spendIssue({
    value: '10', sponsorId: 'X', consumerIds: '__all__',
  }), /пустое имя/);

  // empty consumers list
  assert.match(inst.spendIssue({
    value: '10', sponsorId: 'A', consumerIds: [],
  }), /на кого делить/);

  // consumers reference only unnamed/unknown
  assert.match(inst.spendIssue({
    value: '10', sponsorId: 'A', consumerIds: ['X', 'GHOST'],
  }), /никто/i);
});

test('spendIssue: __all__ with no named persons reports issue', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons = [{ id: 'X', name: '', groupId: '' }];
  assert.match(inst.spendIssue({
    value: '10', sponsorId: 'X', consumerIds: '__all__',
  }), /пустое имя|нет участников/);
});

test('summary reports skippedSpends and skippedPersons', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
      { id: 'X', name: '', groupId: '' },  // skipped: no name
    ],
    groups: [],
    spends: [
      { id: 's1', value: '10', sponsorId: 'A', consumerIds: '__all__', note: '' },
      { id: 's2', value: '', sponsorId: 'A', consumerIds: '__all__', note: '' },  // skipped: no value
      { id: 's3', value: '5', sponsorId: '', consumerIds: '__all__', note: '' },  // skipped: no sponsor
    ],
  });
  inst.recompute();
  assert.equal(inst.result.summary.spendCount, 1);
  assert.equal(inst.result.summary.skippedSpends, 2);
  assert.equal(inst.result.summary.personCount, 2);
  assert.equal(inst.result.summary.skippedPersons, 1);
});

test('result includes summary and spendsList', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt, {
    persons: [
      { id: 'A', name: 'A', groupId: '' },
      { id: 'B', name: 'B', groupId: '' },
    ],
    groups: [],
    spends: [
      { id: 's1', value: '40', sponsorId: 'A', consumerIds: '__all__', note: 'ужин' },
      { id: 's2', value: '20', sponsorId: 'B', consumerIds: ['A'], note: '' },
    ],
  });
  inst.recompute();
  assert.equal(inst.result.summary.spendCount, 2);
  assert.equal(inst.result.summary.personCount, 2);
  assert.equal(inst.result.spendsList.length, 2);
  const ужин = inst.result.spendsList.find(s => s.note === 'ужин');
  assert.ok(ужин);
  assert.equal(ужин.sponsorName, 'A');
  assert.equal(ужин.forAll, true);
  const другая = inst.result.spendsList.find(s => s.id === 's2');
  assert.equal(другая.forAll, false);
  assert.deepEqual(другая.consumerNames, ['A']);
});

test('resetCalc snapshots and clears the calc (no confirm)', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons.push({ id: 'A', name: 'A', groupId: '' });
  inst.calc.spends.push({
    id: 's1', value: '10', sponsorId: 'A', consumerIds: ['A'], note: 'x',
  });

  inst.resetCalc();

  assert.equal(inst.calc.persons.length, 0);
  assert.equal(inst.calc.spends.length, 0);
  assert.notEqual(inst.lastClearedSnapshot, null);
  assert.equal(inst.lastClearedSnapshot.persons.length, 1);
  assert.equal(inst.lastClearedSnapshot.spends.length, 1);
  inst.dismissClearedToast();  // cancel pending timer to keep test process clean
});

test('resetCalc on empty calc takes no snapshot', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.resetCalc();
  assert.equal(inst.lastClearedSnapshot, null);
});

test('undoClear restores persons/spends/groups in place', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons.push({ id: 'A', name: 'A', groupId: 'g1' });
  inst.calc.groups.push({ id: 'g1', name: 'Family' });
  inst.calc.spends.push({
    id: 's1', value: '10', sponsorId: 'A', consumerIds: ['A'], note: 'ужин',
  });
  const personsRef = inst.calc.persons;
  const spendsRef = inst.calc.spends;
  const groupsRef = inst.calc.groups;

  inst.resetCalc();
  inst.undoClear();

  assert.equal(inst.calc.persons.length, 1);
  assert.equal(inst.calc.persons[0].name, 'A');
  assert.equal(inst.calc.groups.length, 1);
  assert.equal(inst.calc.groups[0].name, 'Family');
  assert.equal(inst.calc.spends.length, 1);
  assert.equal(inst.calc.spends[0].note, 'ужин');
  assert.deepEqual(inst.calc.spends[0].consumerIds, ['A']);
  assert.equal(inst.calc.persons, personsRef);
  assert.equal(inst.calc.spends, spendsRef);
  assert.equal(inst.calc.groups, groupsRef);
  assert.equal(inst.lastClearedSnapshot, null);
});

test('undoClear after user mutation drops the user changes and restores snapshot', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons.push({ id: 'A', name: 'A', groupId: '' });

  inst.resetCalc();
  inst.calc.persons.push({ id: 'NEW', name: 'New', groupId: '' });
  inst.undoClear();

  assert.equal(inst.calc.persons.length, 1);
  assert.equal(inst.calc.persons[0].id, 'A');
  inst.dismissClearedToast();
});

test('undoClear is a no-op without a snapshot', () => {
  const { splitDebt } = loadApp();
  const inst = makeInstance(splitDebt);
  inst.calc.persons.push({ id: 'A', name: 'A', groupId: '' });
  inst.undoClear();
  assert.equal(inst.calc.persons.length, 1);
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
