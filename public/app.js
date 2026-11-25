// natsel control panel. Sign-in: POST /api/login sets an HttpOnly session cookie.
// Screens (hash routes): #populations, #pool, #species.

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h('div', { class: 'x', onclick }, child, 'text', [more]). Text is never parsed as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') show(null);
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, detail: data.detail });
  return data;
}
const send = (path, method, body) => api(path, { method, body: JSON.stringify(body) });

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}
const fail = (err) => toast(err.detail ? `${err.message}: ${JSON.stringify(err.detail)}` : err.message, 'err');

// ---------- data ----------

const speciesLabel = (s) => s.name || s.id;
const isDraft = (s) => s && !s.extinct_at && !s.approved_at;
const draftBadge = (s) => isDraft(s) && h('span', { class: 'badge' }, 'draft');
const ALLELE_COLORS = 6;
const alleleChip = (idx, title) => h('span', { class: `allele a${idx % ALLELE_COLORS}`, title }, idx);

async function load() {
  const [pool, species] = await Promise.all([api('pool'), api('species?all=1')]);
  const live = species.filter((s) => !s.extinct_at);
  return { pool, species, live, byId: new Map(species.map((s) => [s.id, s])) };
}

// ---------- populations ----------

async function populationsView() {
  const [{ live, byId }, list] = await Promise.all([load(), api('populations')]);
  const pops = await Promise.all(list.map((p) => api(`populations/${encodeURIComponent(p.id)}`)));
  return [
    h('div', { class: 'head' }, h('h2', {}, 'Populations'), h('p', { class: 'muted' }, 'Traffic shares go live on the site as soon as you save.')),
    pops.length ? pops.map((p) => populationCard(p, live, byId)) : h('p', { class: 'muted' }, 'No populations yet.')
  ];
}

function populationCard(p, live, byId) {
  const current = new Map(p.distribution.map((d) => [d.species_id, d.share_bp / 100]));
  // Live species plus any species that still holds a share.
  const rows = [...new Set([...current.keys(), ...live.map((s) => s.id)])].map((id) => ({ id, s: byId.get(id), pct: current.get(id) ?? 0 }));
  const inputs = new Map();
  const bar = h('div', { class: 'stack' });
  const sum = h('span', { class: 'sum' });
  const save = h('button', { type: 'submit' }, 'Save');

  const values = () => rows.map((r) => [r.id, Math.round(Number(inputs.get(r.id).number.value || 0) * 100) / 100]);
  function refresh() {
    const v = values();
    const total = Math.round(v.reduce((a, [, x]) => a + x, 0) * 100) / 100;
    sum.textContent = `${total}%`;
    sum.classList.toggle('bad', total !== 100);
    save.disabled = total !== 100;
    bar.replaceChildren(
      ...v.map(([id, x], i) => [id, x, i]).filter(([, x]) => x > 0).map(([id, x, i]) => h('div', { class: `seg c${(i + 1) % ALLELE_COLORS}`, style: `flex-basis:${x}%`, title: `${speciesLabel(byId.get(id) ?? { id })}: ${x}%` }, x >= 8 ? `${x}%` : '')),
    );
  }

  const table = h(
    'table',
    { class: 'shares' },
    rows.map((r) => {
      const locked = isDraft(r.s) && r.pct === 0;
      const title = locked ? 'Approve this species first' : null;
      const range = h('input', { type: 'range', min: 0, max: 100, step: 1, value: r.pct, disabled: locked, title });
      const number = h('input', { type: 'number', min: 0, max: 100, step: 0.01, value: r.pct, disabled: locked, title });
      range.oninput = () => ((number.value = range.value), refresh());
      number.oninput = () => ((range.value = number.value), refresh());
      inputs.set(r.id, { range, number });
      return h(
        'tr',
        { class: r.s?.extinct_at ? 'extinct' : '' },
        h('td', {}, h('span', { class: `dot c${(rows.indexOf(r) + 1) % ALLELE_COLORS}` }), h('strong', {}, speciesLabel(r.s ?? r)), ' ', draftBadge(r.s), h('div', { class: 'muted small' }, r.id)),
        h('td', { class: 'grow' }, range),
        h('td', {}, number, ' %'),
      );
    }),
  );
  refresh();

  return h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const snap = await send(`populations/${encodeURIComponent(p.id)}/distribution`, 'PUT', Object.fromEntries(values()));
          toast(`${p.id}: published version ${snap.version}`);
          render();
        } catch (err) {
          fail(err);
        }
      },
    },
    h('div', { class: 'row' }, h('h3', {}, p.name || p.id), h('span', { class: 'muted' }, `${p.id} · version ${p.version}`), h('span', { class: 'spacer' }), sum, save),
    bar,
    table,
  );
}

// ---------- gene pool ----------

async function poolView() {
  const { pool, live } = await load();
  const orphan = new Set(pool.orphans.map((o) => `${o.gene}=${o.allele}`));
  return [
    h(
      'div',
      { class: 'head' },
      h('h2', {}, 'Gene pool'),
      h('p', { class: 'muted' }, `${pool.genes.length} genes · ${pool.species} live species · ${pool.orphans.length} orphan alleles`),
    ),
    h(
      'div',
      { class: 'grid' },
      pool.genes.map((g) => {
        const [locus, name] = g.name.split('.');
        return h(
          'div',
          { class: 'card gene' },
          h('div', { class: 'row' }, h('span', { class: 'locus' }, locus), h('h3', {}, name)),
          g.description && h('p', { class: 'muted' }, g.description),
          h(
            'ul',
            { class: 'alleles' },
            g.labels.map((label, idx) => {
              const carriers = live.filter((s) => (s.genotype[g.name] ?? 0) === idx);
              return h(
                'li',
                { class: orphan.has(`${g.name}=${idx}`) ? 'orphan' : '' },
                alleleChip(idx, idx === 0 ? 'default allele' : ''),
                h('span', { class: 'label' }, label || h('em', { class: 'muted' }, 'no label')),
                h('span', { class: 'carriers' }, carriers.length ? carriers.map((s) => h('span', { class: 'pill' }, speciesLabel(s))) : h('span', { class: 'warn' }, 'no carrier')),
              );
            }),
          ),
        );
      }),
    ),
    !pool.genes.length && h('p', { class: 'muted' }, 'No genes yet. They are registered by the site’s deploy pipeline.'),
  ];
}

// ---------- species ----------

async function speciesView() {
  const { pool, species, live, byId } = await load();
  const genes = pool.genes;
  const showExtinct = location.hash.includes('extinct');
  const shown = showExtinct ? species : live;

  const grid = h(
    'table',
    { class: 'genotypes' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Species'), genes.map((g) => h('th', { title: g.description }, g.name)), h('th', {}, ''))),
    h(
      'tbody',
      {},
      shown.map((s) =>
        h(
          'tr',
          { class: s.extinct_at ? 'extinct' : '' },
          h('td', {}, h('strong', {}, speciesLabel(s)), ' ', draftBadge(s), h('div', { class: 'muted small' }, s.id, s.extinct_at ? ' · extinct' : '')),
          genes.map((g) => {
            const a = s.genotype[g.name] ?? 0;
            return h('td', { class: 'cell' }, alleleChip(a, g.labels[a]));
          }),
          h(
            'td',
            { class: 'actions' },
            isDraft(s) &&
              h(
                'button',
                {
                  class: 'small',
                  onclick: async () => {
                    try {
                      await send(`species/${s.id}/approve`, 'POST', {});
                      toast(`${speciesLabel(s)} approved. Give it traffic in Populations.`);
                      render();
                    } catch (err) {
                      fail(err);
                    }
                  },
                },
                'Approve',
              ),
            !s.extinct_at &&
              h(
                'button',
                {
                  class: 'ghost small',
                  onclick: async () => {
                    if (!confirm(`Make ${speciesLabel(s)} extinct?`)) return;
                    try {
                      await send(`species/${s.id}/extinct`, 'POST', {});
                      toast(`${speciesLabel(s)} is extinct`);
                      render();
                    } catch (err) {
                      fail(err);
                    }
                  },
                },
                'Extinct',
              ),
          ),
        ),
      ),
    ),
  );

  return [
    h(
      'div',
      { class: 'head row' },
      h('h2', {}, 'Species'),
      h('span', { class: 'spacer' }),
      h('a', { href: showExtinct ? '#species' : '#species/extinct', class: 'muted' }, showExtinct ? 'Hide extinct' : 'Show extinct'),
    ),
    h('div', { class: 'card scroll' }, genes.length ? grid : h('p', { class: 'muted' }, 'No genes yet.')),
    h('div', { class: 'cols' }, h('div', { class: 'card' }, h('h3', {}, 'Lineage'), lineage(species, byId)), newSpeciesForm(genes, live)),
  ];
}

function lineage(species, byId) {
  const kids = new Map();
  for (const s of species) {
    const p = s.parent_id && byId.has(s.parent_id) ? s.parent_id : null;
    (kids.get(p) ?? kids.set(p, []).get(p)).push(s);
  }
  const branch = (parent) =>
    kids.has(parent) &&
    h(
      'ul',
      { class: 'tree' },
      kids.get(parent).map((s) => {
        const p = byId.get(s.parent_id);
        const diff = p ? Object.entries(s.genotype).filter(([g, a]) => (p.genotype[g] ?? 0) !== a) : [];
        return h(
          'li',
          { class: s.extinct_at ? 'extinct' : '' },
          h('strong', {}, speciesLabel(s)),
          ' ',
          draftBadge(s),
          ' ',
          h('span', { class: 'muted small' }, s.created_at?.slice(0, 10)),
          diff.length > 0 && h('div', { class: 'small' }, diff.map(([g, a]) => h('span', { class: 'mut' }, `${g} → `, alleleChip(a)))),
          branch(s.id),
        );
      }),
    );
  return branch(null) || h('p', { class: 'muted' }, 'No species yet.');
}

function newSpeciesForm(genes, live) {
  const selects = new Map();
  const parent = h('select', { name: 'parent_id' }, h('option', { value: '' }, '— none —'), live.map((s) => h('option', { value: s.id }, speciesLabel(s))));
  parent.onchange = () => {
    const p = live.find((s) => s.id === parent.value);
    for (const [g, sel] of selects) sel.value = String(p?.genotype[g] ?? 0);
  };
  return h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const alleles = Object.fromEntries([...selects].map(([g, sel]) => [g, Number(sel.value)]));
        try {
          const s = await send('species', 'POST', { name: f.get('name'), parent_id: f.get('parent_id') || null, alleles });
          toast(`Draft ${speciesLabel(s)} created. Approve it to give it traffic.`);
          render();
        } catch (err) {
          fail(err);
        }
      },
    },
    h('h3', {}, 'New species'),
    h('p', { class: 'muted small' }, 'A combination of alleles. Start from a parent and change a few genes. It starts as a draft until approved.'),
    h('label', {}, 'Name', h('input', { name: 'name', placeholder: 'e.g. landing-c' })),
    h('label', {}, 'Parent', parent),
    genes.map((g) => {
      const sel = h('select', {}, g.labels.map((l, i) => h('option', { value: i }, `${i} · ${l || '—'}`)));
      selects.set(g.name, sel);
      return h('label', {}, g.name, sel);
    }),
    h('button', { type: 'submit', disabled: !genes.length }, 'Create species'),
  );
}

// ---------- shell ----------

const VIEWS = { populations: populationsView, pool: poolView, species: speciesView };

async function render() {
  const key = location.hash.slice(1).split('/')[0] || 'populations';
  const view = VIEWS[key] ?? populationsView;
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('href') === `#${key}`);
  try {
    $('view').replaceChildren(...[await view()].flat(Infinity).filter(Boolean));
  } catch (err) {
    if (err.status !== 401) $('view').replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

function show(user) {
  $('login').hidden = Boolean(user);
  $('app').hidden = !user;
  $('who').textContent = user ?? '';
  if (user) render();
}

window.addEventListener('hashchange', () => !$('app').hidden && render());

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    const { login } = await api('login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    show(login);
  } catch (err) {
    $('login-error').textContent = err.status === 401 ? 'Wrong login or password.' : err.message;
  } finally {
    button.disabled = false;
  }
});

// Enter in the login field moves to the password instead of stopping on the empty-field warning.
$('login-form').login.addEventListener('keydown', (e) => {
  const pw = $('login-form').password;
  if (e.key === 'Enter' && !pw.value) {
    e.preventDefault();
    pw.focus();
  }
});

$('logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST' }).catch(() => {});
  show(null);
});

api('me').then(({ login }) => show(login), () => show(null));
