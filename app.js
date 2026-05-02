const HASH_PREFIX = '#d=';
const SCHEMA_VERSION = 1;

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  (Date.now().toString(36) + Math.random().toString(36).slice(2));

function emptyCalc() {
  return { persons: [], groups: [], spends: [] };
}

function encodeCalc(calc) {
  const payload = {
    v: SCHEMA_VERSION,
    p: calc.persons.map(p => ({ i: p.id, n: p.name, g: p.groupId || null })),
    g: calc.groups.map(g => ({ i: g.id, n: g.name })),
    s: calc.spends.map(s => ({
      i: s.id,
      v: s.value,
      sp: s.sponsorId,
      c: s.consumerIds === '__all__' ? '*' : [...(s.consumerIds || [])],
      t: s.note || '',
    })),
  };
  return LZString.compressToEncodedURIComponent(JSON.stringify(payload));
}

function decodeCalc(s) {
  try {
    const json = LZString.decompressFromEncodedURIComponent(s);
    if (!json) return null;
    const parsed = JSON.parse(json);
    if (parsed.v !== SCHEMA_VERSION) return null;
    return {
      persons: (parsed.p || []).map(p => ({ id: p.i, name: p.n, groupId: p.g || '' })),
      groups: (parsed.g || []).map(g => ({ id: g.i, name: g.n })),
      spends: (parsed.s || []).map(s => ({
        id: s.i,
        value: s.v,
        sponsorId: s.sp,
        consumerIds: s.c === '*' ? '__all__' : (Array.isArray(s.c) ? s.c : []),
        note: s.t || '',
      })),
    };
  } catch {
    return null;
  }
}

function splitDebt() {
  return {
    calc: emptyCalc(),
    shareCopied: false,
    result: null,
    lastClearedSnapshot: null,
    _clearedTimer: null,

    init() {
      const hash = location.hash || '';
      if (hash.startsWith(HASH_PREFIX)) {
        const decoded = decodeCalc(hash.slice(HASH_PREFIX.length));
        if (decoded) this.calc = decoded;
      }

      this.$watch('calc', () => {
        this.recompute();
        this.syncHash();
      }, { deep: true });

      this.recompute();
    },

    addAdHocPerson() {
      this.calc.persons.push({ id: uid(), name: '', groupId: '' });
    },

    removeParticipant(i) {
      const removed = this.calc.persons.splice(i, 1)[0];
      for (const s of this.calc.spends) {
        if (s.sponsorId === removed.id) s.sponsorId = '';
        if (Array.isArray(s.consumerIds)) {
          s.consumerIds = s.consumerIds.filter(id => id !== removed.id);
        }
      }
      this.cleanupGroups();
    },

    onPersonGroupChange(person) {
      if (person.groupId === '__new__') {
        const g = { id: uid(), name: '' };
        this.calc.groups.push(g);
        person.groupId = g.id;
      }
      this.cleanupGroups();
    },

    cleanupGroups() {
      const used = new Set(this.calc.persons.map(p => p.groupId).filter(Boolean));
      this.calc.groups = this.calc.groups.filter(g => used.has(g.id));
    },

    personIssue(p) {
      if (!p.name || !p.name.trim()) return 'добавь имя — иначе участник не попадёт в расчёт';
      return null;
    },

    spendIssue(s) {
      const namedPersons = this.calc.persons.filter(p => p.name && p.name.trim());
      const personIds = new Set(namedPersons.map(p => p.id));

      if (s.value === '' || s.value == null) return 'укажи сумму';
      const v = parseFloat(s.value);
      if (!Number.isFinite(v) || v <= 0) return 'сумма должна быть больше нуля';
      if (!s.sponsorId) return 'выбери, кто заплатил';
      if (!personIds.has(s.sponsorId)) return 'у плательщика пустое имя';
      if (s.consumerIds === '__all__') {
        if (!namedPersons.length) return 'нет участников с именами';
        return null;
      }
      if (!Array.isArray(s.consumerIds) || !s.consumerIds.length) {
        return 'выбери, на кого делить трату';
      }
      if (!s.consumerIds.some(id => personIds.has(id))) {
        return 'никто из выбранных не участвует';
      }
      return null;
    },

    walletFor(person) {
      if (!person.groupId) return null;
      return this.calc.groups.find(g => g.id === person.groupId) || null;
    },

    setWalletName(person, name) {
      const w = this.walletFor(person);
      if (w) w.name = name;
    },

    addSpend() {
      this.calc.spends.push({
        id: uid(),
        note: '',
        value: '',
        sponsorId: '',
        consumerIds: '__all__',
      });
    },

    removeSpend(i) {
      this.calc.spends.splice(i, 1);
    },

    toggleAllConsumers(s) {
      s.consumerIds = s.consumerIds === '__all__'
        ? this.calc.persons.map(p => p.id)
        : '__all__';
    },

    toggleConsumer(s, pid) {
      if (!Array.isArray(s.consumerIds)) s.consumerIds = [];
      const idx = s.consumerIds.indexOf(pid);
      if (idx >= 0) s.consumerIds.splice(idx, 1);
      else s.consumerIds.push(pid);
    },

    clearCalcInPlace() {
      this.calc.persons.splice(0);
      this.calc.spends.splice(0);
      this.calc.groups.splice(0);
    },

    resetCalc() {
      if (!this.calc.persons.length && !this.calc.spends.length) return;
      this.lastClearedSnapshot = {
        persons: this.calc.persons.map(p => ({ ...p })),
        groups: this.calc.groups.map(g => ({ ...g })),
        spends: this.calc.spends.map(s => ({
          ...s,
          consumerIds: Array.isArray(s.consumerIds) ? [...s.consumerIds] : s.consumerIds,
        })),
      };
      this.clearCalcInPlace();
      if (this._clearedTimer) clearTimeout(this._clearedTimer);
      this._clearedTimer = setTimeout(() => {
        this.lastClearedSnapshot = null;
        this._clearedTimer = null;
      }, 6000);
    },

    undoClear() {
      if (!this.lastClearedSnapshot) return;
      if (this._clearedTimer) clearTimeout(this._clearedTimer);
      this._clearedTimer = null;
      this.clearCalcInPlace();
      this.calc.persons.push(...this.lastClearedSnapshot.persons);
      this.calc.groups.push(...this.lastClearedSnapshot.groups);
      this.calc.spends.push(...this.lastClearedSnapshot.spends);
      this.lastClearedSnapshot = null;
    },

    dismissClearedToast() {
      if (this._clearedTimer) clearTimeout(this._clearedTimer);
      this._clearedTimer = null;
      this.lastClearedSnapshot = null;
    },

    loadExample() {
      this.clearCalcInPlace();

      const aId = uid(), bId = uid(), cId = uid();
      this.calc.persons.push(
        { id: aId, name: 'Аня', groupId: '' },
        { id: bId, name: 'Боря', groupId: '' },
        { id: cId, name: 'Вика', groupId: '' },
      );
      this.calc.spends.push(
        { id: uid(), note: 'Ужин',   value: '3000', sponsorId: aId, consumerIds: '__all__' },
        { id: uid(), note: 'Такси',  value: '500',  sponsorId: bId, consumerIds: [aId, bId] },
        { id: uid(), note: 'Билеты', value: '1200', sponsorId: cId, consumerIds: '__all__' },
      );
    },

    syncHash() {
      const empty = !this.calc.persons.length && !this.calc.spends.length;
      const newHash = empty ? '' : HASH_PREFIX + encodeCalc(this.calc);
      if (location.hash !== newHash) {
        history.replaceState(null, '', location.pathname + location.search + newHash);
      }
    },

    async copyShareLink() {
      this.syncHash();
      try {
        await navigator.clipboard.writeText(location.href);
        this.shareCopied = true;
        setTimeout(() => { this.shareCopied = false; }, 1500);
      } catch {
        prompt('Скопируй ссылку вручную:', location.href);
      }
    },

    recompute() {
      const D = Decimal;
      const persons = this.calc.persons.filter(p => p.name && p.name.trim());
      const personById = Object.fromEntries(persons.map(p => [p.id, p]));
      const groupById = Object.fromEntries(this.calc.groups.map(g => [g.id, g]));

      const spends = this.calc.spends.filter(s => !this.spendIssue(s));

      if (!persons.length || !spends.length) {
        this.result = null;
        return;
      }

      const walletOf = pid => personById[pid]?.groupId || pid;
      const walletName = wk => groupById[wk]?.name || personById[wk]?.name || '?';

      const balances = {};
      for (const p of persons) {
        const w = walletOf(p.id);
        if (!(w in balances)) balances[w] = new D(0);
      }

      const spendsPlan = {};
      const allIds = persons.map(p => p.id);

      for (const s of spends) {
        const consumers = (s.consumerIds === '__all__' ? allIds : s.consumerIds)
          .filter(id => personById[id]);
        if (!consumers.length) continue;
        const value = new D(s.value);
        const sponsorWallet = walletOf(s.sponsorId);
        balances[sponsorWallet] = balances[sponsorWallet].minus(value);
        const perPerson = value.dividedBy(consumers.length);
        for (const cid of consumers) {
          spendsPlan[cid] = (spendsPlan[cid] || new D(0)).plus(perPerson);
        }
      }

      for (const [pid, debt] of Object.entries(spendsPlan)) {
        const w = walletOf(pid);
        if (w in balances) balances[w] = balances[w].plus(debt);
      }

      const balanceList = Object.entries(balances)
        .map(([wallet, value]) => {
          const rounded = value.toDecimalPlaces(2);
          return {
            wallet,
            name: walletName(wallet),
            value: rounded,
            sign: rounded.cmp(0),
            display: this.formatMoney(rounded),
          };
        })
        .sort((a, b) => a.value.cmp(b.value));

      const debtors = balanceList
        .filter(b => b.sign > 0)
        .map(b => ({ wallet: b.wallet, name: b.name, value: b.value }));
      const creditors = balanceList
        .filter(b => b.sign < 0)
        .map(b => ({ wallet: b.wallet, name: b.name, value: b.value.abs() }));

      const transactions = [];
      let safety = 1000;
      while (debtors.length && creditors.length && safety-- > 0) {
        debtors.sort((a, b) => a.value.cmp(b.value));
        creditors.sort((a, b) => b.value.cmp(a.value));

        const debtor = debtors.pop();
        const creditor = creditors.pop();
        const dv = debtor.value;
        const cv = creditor.value;

        const cmp = dv.cmp(cv);
        if (cmp < 0) {
          transactions.push(this.makeTx(debtor, creditor, dv));
          creditor.value = cv.minus(dv);
          creditors.push(creditor);
        } else if (cmp > 0) {
          transactions.push(this.makeTx(debtor, creditor, cv));
          debtor.value = dv.minus(cv);
          debtors.push(debtor);
        } else {
          transactions.push(this.makeTx(debtor, creditor, cv));
        }
      }

      const totalValue = spends.reduce(
        (acc, s) => acc.plus(new D(s.value)),
        new D(0)
      );

      const spendsList = spends.map(s => {
        const consumers = (s.consumerIds === '__all__' ? allIds : s.consumerIds)
          .filter(id => personById[id]);
        const v = new D(s.value).toDecimalPlaces(2);
        return {
          id: s.id,
          note: s.note || '',
          value: v,
          display: this.formatMoney(v),
          sponsorName: personById[s.sponsorId]?.name || '?',
          forAll: s.consumerIds === '__all__',
          consumerNames: consumers.map(id => personById[id].name),
        };
      });

      const summary = {
        totalDisplay: this.formatMoney(totalValue.toDecimalPlaces(2)),
        spendCount: spends.length,
        skippedSpends: this.calc.spends.length - spends.length,
        personCount: persons.length,
        skippedPersons: this.calc.persons.length - persons.length,
        avgDisplay: this.formatMoney(
          totalValue.dividedBy(persons.length).toDecimalPlaces(2)
        ),
      };

      this.result = { balances: balanceList, transactions, spendsList, summary };
    },

    makeTx(from, to, value) {
      const v = value.toDecimalPlaces(2);
      return {
        from: from.wallet, fromName: from.name,
        to: to.wallet, toName: to.name,
        value: v, display: this.formatMoney(v),
      };
    },

    formatMoney(d) {
      const n = d.toNumber();
      return new Intl.NumberFormat('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(n);
    },
  };
}

window.splitDebt = splitDebt;
