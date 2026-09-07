// Backend de produção — Cloudflare Worker + D1 no lugar do Google Apps
// Script/Sheets. Porta 1:1 cada action de apps-script/Code.gs, mantendo o
// mesmo contrato de resposta (sempre HTTP 200, corpo JSON, erro vira
// {error:'...'}) pra não exigir nenhuma mudança no restante do index.html —
// só a URL (SYNC_URL) e a tela "Gerenciar acessos" mudam (PIN nunca mais é
// visível depois de gerado; sempre gerado pelo servidor, nunca digitado).

const AUTH_FAIL_LIMIT = 30;
const AUTH_FAIL_WINDOW_SECONDS = 60;

const SITUACOES = [
  'Desabrigada — acolhida em abrigo público',
  'Desalojada — saiu de casa mas não foi para abrigo',
  'Atingida — permanece no local'
];
const ABRIGOS = ['CPS Empresa', 'Associação dos Motoristas'];

// Colunas da tabela `cadastros` (snake_case) pareadas com o rótulo de
// coluna que o index.html espera em `rows` (mesmos nomes de HEADERS do
// Code.gs) — reaproveitado tanto pra montar a resposta quanto pro diff de
// histórico em `upsert`.
const COLUNAS_CADASTRO = [
  ['id', 'ID'], ['ts', 'Data/Hora'], ['responsavel', 'Responsável familiar'], ['cpf', 'CPF'],
  ['endereco', 'Endereço'], ['gps_lat', 'Latitude'], ['gps_lng', 'Longitude'],
  ['gps_origem', 'Origem da localização'], ['bairro', 'Bairro'],
  ['integrantes', 'Integrantes'], ['nomes_integrantes', 'Nomes dos integrantes'], ['situacao', 'Situação'],
  ['observacoes', 'Observações'], ['profissional_nome', 'Profissional responsável'],
  ['profissional_cpf', 'CPF do profissional'], ['status', 'Status'],
  ['motivo_cancelamento', 'Motivo do cancelamento'], ['abrigo', 'Abrigo'], ['id_abrigo', 'ID no abrigo'],
  ['pessoas_alimentacao', 'Pessoas que se alimentam'], ['data_saida_abrigo', 'Data de saída do abrigo'],
  ['obs_abrigo', 'Observações do abrigo'], ['composicao_etaria', 'Composição etária'], ['contato', 'Contato']
];

// CORS liberado: o app (index.html) e este Worker vivem em domínios
// diferentes em produção (do mesmo jeito que hoje index.html chama
// script.google.com, uma origem diferente de onde o site está hospedado) —
// não é uma frouxidão nova desta migração, é a mesma topologia de sempre.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

function jsonOut(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Página simples (só usada pela configuração inicial, em /bootstrap).
function htmlOut(corpo, status) {
  const doc = '<!doctype html><html lang="pt-BR"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Configuração inicial</title><style>' +
    'body{font-family:system-ui,-apple-system,sans-serif;max-width:30rem;margin:0 auto;' +
    'padding:24px 18px;line-height:1.55;background:#F2F5F6;color:#12242E;}' +
    '.card{background:#fff;border:1px solid #DFE5E8;border-radius:14px;padding:20px;}' +
    'h2{margin:0 0 10px;font-size:19px;}p{font-size:14.5px;}' +
    'label{display:block;font-weight:700;font-size:13px;margin:14px 0 6px;}' +
    'input{width:100%;padding:12px;font-size:16px;border:1px solid #CDD6DA;' +
    'border-radius:9px;box-sizing:border-box;font-family:inherit;}' +
    'button{width:100%;padding:14px;font-size:16px;font-weight:700;background:#2C6E8F;' +
    'color:#fff;border:0;border-radius:9px;margin-top:16px;font-family:inherit;}' +
    '.pin{font-size:36px;font-weight:800;letter-spacing:4px;color:#2C6E8F;' +
    'text-align:center;margin:14px 0;}' +
    '.aviso{color:#8A5A06;font-size:14px;font-weight:600;}' +
    '</style>' + corpo;
  return new Response(doc, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

async function hmacPin(pin, pepper) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(pin));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// CSPRNG (crypto.getRandomValues), não Math.random — PIN de acesso não pode
// vir de um gerador previsível.
function gerarPin() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

async function isRateLimited(db, pinLookup) {
  const row = await db.prepare('SELECT contagem, inicio_janela FROM auth_falhas WHERE pin_lookup = ?')
    .bind(pinLookup).first();
  if (!row) return false;
  return row.contagem >= AUTH_FAIL_LIMIT;
}

async function registrarFalha(db, pinLookup) {
  const agora = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT contagem, inicio_janela FROM auth_falhas WHERE pin_lookup = ?')
    .bind(pinLookup).first();
  if (!row) {
    await db.prepare('INSERT INTO auth_falhas (pin_lookup, contagem, inicio_janela) VALUES (?, 1, ?)')
      .bind(pinLookup, agora).run();
    return;
  }
  const dentroDaJanela = (agora - row.inicio_janela) < AUTH_FAIL_WINDOW_SECONDS;
  if (dentroDaJanela) {
    await db.prepare('UPDATE auth_falhas SET contagem = contagem + 1 WHERE pin_lookup = ?')
      .bind(pinLookup).run();
  } else {
    await db.prepare('UPDATE auth_falhas SET contagem = 1, inicio_janela = ? WHERE pin_lookup = ?')
      .bind(agora, pinLookup).run();
  }
}

// Equivalente a getGestorInfo(pwd) do Code.gs: PIN vazio nunca conta como
// tentativa de força bruta (o app manda '' em algumas rotas antes de haver
// sessão).
async function autenticar(db, pepper, pin) {
  const pinStr = String(pin == null ? '' : pin).trim();
  if (!pinStr) return { gestor: null };
  const lookup = await hmacPin(pinStr, pepper);
  if (await isRateLimited(db, lookup)) return { limitado: true };
  const row = await db.prepare(
    'SELECT id, nome, cpf, papel, fundador, abrigo FROM gestores WHERE pin_lookup = ?'
  ).bind(lookup).first();
  if (!row) { await registrarFalha(db, lookup); return { gestor: null }; }
  return { gestor: row };
}

// Mesma distinção do Code.gs (authErrorOut): authFailed (PIN não vale mais,
// o app apaga a sessão) vs retry (bloqueio temporário, sessão continua).
function erroAutenticacao(limitado) {
  if (limitado) return jsonOut({ error: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.', retry: true });
  return jsonOut({ error: 'não autorizado', authFailed: true });
}

function erroSoMaster() {
  return jsonOut({ error: 'Esta ação é permitida apenas para acessos master.' });
}

async function logHistorico(db, gestorNome, familiaId, familiaNome, changes) {
  const now = new Date().toISOString();
  for (const c of changes) {
    await db.prepare(
      'INSERT INTO historico (ts, gestor_nome, familia_id, familia_nome, campo, alteracao) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(now, gestorNome, familiaId || '', familiaNome || '', c.campo, c.alteracao).run();
  }
}

// Migração automática do banco.
//
// O Worker se publica sozinho a cada envio para a ramificação de produção,
// mas o BANCO não muda junto: um Worker novo que grava numa coluna ainda
// inexistente derruba TODA gravação de cadastro com "no such column" — o
// pior desfecho possível num app cujo trabalho inteiro é não perder
// cadastro. Foi exatamente o que aconteceu ao publicar o mapa: entre o
// deploy do Worker e o ALTER TABLE manual, nenhum celular conseguiu
// sincronizar.
//
// Por isso o próprio Worker garante o que precisa antes de usar. É barato
// (uma verificação por isolate, não por requisição) e idempotente: rodar
// de novo não faz nada. Coluna nova daqui pra frente entra nesta lista, e
// o deploy passa a ser suficiente sozinho.
const COLUNAS_ESPERADAS = [
  ['cadastros', 'gps_origem', "ALTER TABLE cadastros ADD COLUMN gps_origem TEXT DEFAULT ''"]
];
// Tabela nova (não coluna em tabela existente): `CREATE TABLE IF NOT
// EXISTS` já é idempotente por natureza, sem precisar do vaivém do
// PRAGMA table_info usado acima para ALTER TABLE.
const TABELAS_ESPERADAS = [
  `CREATE TABLE IF NOT EXISTS atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    familia_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    gestor_nome TEXT NOT NULL,
    tipo TEXT NOT NULL,
    observacao TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pendente'
  )`,
  'CREATE INDEX IF NOT EXISTS idx_atendimentos_familia ON atendimentos(familia_id)'
];
let schemaGarantido = false;
async function garantirSchema(db) {
  if (schemaGarantido) return;
  for (const [tabela, coluna, sql] of COLUNAS_ESPERADAS) {
    const info = await db.prepare(`PRAGMA table_info(${tabela})`).all();
    if (info.results.some(c => c.name === coluna)) continue;
    try {
      await db.prepare(sql).run();
    } catch (e) {
      // Outro isolate pode ter feito o ALTER entre o PRAGMA e aqui —
      // "duplicate column" nesse caso é sucesso, não falha.
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  for (const sql of TABELAS_ESPERADAS) {
    await db.prepare(sql).run();
  }
  schemaGarantido = true;
}

async function todosCadastros(db) {
  const { results } = await db.prepare('SELECT * FROM cadastros').all();
  return results;
}

function linhaParaHeaders(row) {
  const obj = {};
  COLUNAS_CADASTRO.forEach(([col, label]) => { obj[label] = row[col]; });
  return obj;
}

function statsFor(rows) {
  let pessoas = 0, alimentam = 0;
  rows.forEach(r => {
    pessoas += parseInt(r.integrantes, 10) || 1;
    alimentam += parseInt(r.pessoas_alimentacao, 10) || 0;
  });
  return { familias: rows.length, pessoas, alimentam };
}

async function lerPicos(db) {
  const { results } = await db.prepare('SELECT chave, valor FROM picos').all();
  const obj = {};
  results.forEach(r => { obj[r.chave] = r.valor; });
  return obj;
}

async function upsertPico(db, chave, valor) {
  await db.prepare(
    'INSERT INTO picos (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'
  ).bind(chave, valor).run();
}

// Substitui PropertiesService — mesma lógica do Code.gs (updateAndGetPeaks).
async function updateAndGetPeaks(db, totalPessoas, porAbrigoPessoas) {
  const atuais = await lerPicos(db);
  const peakTotal = Math.max(atuais['peak_total'] || 0, totalPessoas);
  await upsertPico(db, 'peak_total', peakTotal);
  const porAbrigo = {};
  for (let i = 0; i < ABRIGOS.length; i++) {
    const nome = ABRIGOS[i];
    const key = 'peak_abrigo_' + i;
    const atual = porAbrigoPessoas[nome] || 0;
    const pico = Math.max(atuais[key] || 0, atual);
    await upsertPico(db, key, pico);
    porAbrigo[nome] = pico;
  }
  return { total: peakTotal, porAbrigo };
}

// Mapa por concentração, nunca por casa.
//
// As coordenadas das casas NÃO saem daqui. Elas são arredondadas para uma
// grade de ~1,1 km (0,01 grau) e só o total de cada célula é devolvido —
// então um balão com uma família sozinha aponta um quadrado de 1 km, não
// uma casa, e nenhum nome, CPF ou endereço acompanha o número.
//
// É o que permite este mapa aparecer no Acompanhamento, que qualquer
// pessoa com o link abre sem PIN.
const CELULA_GRAU = 0.01;
function agregarPorCelula(rows) {
  const celulas = {};
  rows.forEach(r => {
    const lat = parseFloat(String(r.gps_lat == null ? '' : r.gps_lat).replace(',', '.'));
    const lng = parseFloat(String(r.gps_lng == null ? '' : r.gps_lng).replace(',', '.'));
    if (isNaN(lat) || isNaN(lng)) return;
    const cLat = (Math.round(lat / CELULA_GRAU) * CELULA_GRAU).toFixed(2);
    const cLng = (Math.round(lng / CELULA_GRAU) * CELULA_GRAU).toFixed(2);
    const chave = cLat + ',' + cLng;
    if (!celulas[chave]) celulas[chave] = { lat: Number(cLat), lng: Number(cLng), familias: 0, pessoas: 0 };
    celulas[chave].familias += 1;
    celulas[chave].pessoas += parseInt(r.integrantes, 10) || 1;
  });
  return Object.keys(celulas).map(k => celulas[k]);
}

// Porta literal de computeStatsPayload (Code.gs linha 237-270).
async function computeStatsPayload(db, allRows) {
  const active = allRows.filter(r => r.status !== 'Cancelado');

  const situacao = {};
  SITUACOES.forEach(s => { situacao[s] = statsFor(active.filter(r => r.situacao === s)); });
  const total = statsFor(active);

  const desabrigadas = active.filter(r => r.situacao === SITUACOES[0]);
  const aindaAbrigadas = desabrigadas.filter(r => r.abrigo && !r.data_saida_abrigo);
  const semAbrigo = desabrigadas.filter(r => !r.abrigo);

  const porAbrigo = {};
  const porAbrigoPessoas = {};
  ABRIGOS.forEach(nome => {
    const st = statsFor(aindaAbrigadas.filter(r => r.abrigo === nome));
    porAbrigo[nome] = st;
    porAbrigoPessoas[nome] = st.pessoas;
  });
  const totalAbrigo = statsFor(aindaAbrigadas);
  const semAbrigoStats = statsFor(semAbrigo);

  const peaks = await updateAndGetPeaks(db, totalAbrigo.pessoas, porAbrigoPessoas);

  return {
    stats: {
      situacao,
      total,
      abrigos: { total: totalAbrigo, porAbrigo, semAbrigo: semAbrigoStats }
    },
    peaks,
    mapaAgregado: agregarPorCelula(active)
  };
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .substring(0, 40) || 'evento';
}

async function handleGet(env) {
  try {
    const db = env.DB;
    await garantirSchema(db);
    const todos = await todosCadastros(db);
    const payload = await computeStatsPayload(db, todos);
    return jsonOut(payload);
  } catch (e) {
    return jsonOut({ error: 'Erro no servidor: ' + e.message });
  }
}

// Configuração inicial (/bootstrap): cria o PRIMEIRO acesso Master/fundador
// pelo navegador, sem precisar de terminal nem calcular hash à mão — o
// pepper nunca sai do segredo do Worker.
//
// Só funciona enquanto a tabela `gestores` estiver completamente vazia, ou
// seja, exatamente uma vez: assim que o fundador existe, esta rota passa a
// recusar para sempre. E a tabela nunca volta a ficar vazia pelo uso normal
// do app — removeGestor se recusa a apagar o fundador e a apagar o último
// master, e archiveEvent só mexe em `cadastros`.
async function handleBootstrap(request, env) {
  const db = env.DB;
  const contagem = await db.prepare('SELECT COUNT(*) AS n FROM gestores').first();
  if (contagem.n > 0) {
    return htmlOut(
      '<div class="card"><h2>Já configurado</h2>' +
      '<p>Este backend já tem acesso cadastrado. Esta página de configuração ' +
      'inicial funciona só uma vez, e já foi usada.</p>' +
      '<p>Para criar novos acessos, entre no aplicativo com um acesso Master ' +
      'e use <b>Gerenciar acessos</b>.</p></div>', 403);
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const nome = String(form.get('nome') || '').trim();
    if (!nome) {
      return htmlOut('<div class="card"><h2>Informe o nome</h2>' +
        '<p>Volte e preencha o nome do responsável por este acesso.</p></div>', 400);
    }
    const novoPin = gerarPin();
    const lookup = await hmacPin(novoPin, env.PIN_PEPPER);
    await db.prepare(
      "INSERT INTO gestores (pin_lookup, nome, cpf, papel, fundador, abrigo) VALUES (?, ?, '', 'Master', 1, '')"
    ).bind(lookup, nome).run();
    return htmlOut(
      '<div class="card"><h2>Pronto!</h2>' +
      '<p>Acesso Master criado para <b>' + escapeHtml(nome) + '</b>. Este é o seu PIN:</p>' +
      '<div class="pin">' + novoPin + '</div>' +
      '<p class="aviso">Anote agora — ele não será mostrado de novo.</p>' +
      '<p>O servidor guarda só um código embaralhado do PIN, nunca o PIN em si. ' +
      'Se você perder, um outro Master pode gerar um novo em Gerenciar acessos.</p></div>');
  }

  return htmlOut(
    '<div class="card"><h2>Configuração inicial</h2>' +
    '<p>Nenhum acesso existe ainda neste servidor. Crie aqui o primeiro ' +
    'acesso <b>Master</b> — ele poderá criar todos os outros pelo aplicativo.</p>' +
    '<form method="POST">' +
    '<label for="nome">Seu nome</label>' +
    '<input id="nome" name="nome" required autocomplete="name" placeholder="Nome completo">' +
    '<button type="submit">Criar acesso Master</button>' +
    '</form>' +
    '<p class="aviso" style="margin-top:16px;">Faça isso agora: enquanto ' +
    'ninguém for criado, qualquer pessoa com este endereço poderia se ' +
    'cadastrar como Master.</p></div>');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    // Rota de configuração inicial, separada do endpoint do app (que fica
    // na raiz) — é HTML, feita pra ser aberta no navegador, inclusive do
    // celular. Vem antes de qualquer parse de JSON porque o corpo dela é
    // um formulário, não JSON.
    if (new URL(request.url).pathname === '/bootstrap') {
      try {
        return await handleBootstrap(request, env);
      } catch (e) {
        return htmlOut('<div class="card"><h2>Erro</h2><p>' + escapeHtml(e.message) + '</p></div>', 500);
      }
    }

    if (request.method === 'GET') return handleGet(env);
    if (request.method !== 'POST') return jsonOut({ error: 'método não suportado' }, 405);

    let data;
    try { data = await request.json(); } catch (e) { return jsonOut({ error: 'corpo inválido' }, 400); }
    const db = env.DB;

    try {
      await garantirSchema(db);

      if (data.action === 'login') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.pin);
        if (limitado) return jsonOut({ error: 'Muitas tentativas seguidas com este PIN. Espere um minuto e tente de novo.', retry: true });
        if (!gestor) return jsonOut({ error: 'PIN inválido.' });
        return jsonOut({
          id: gestor.id, nome: gestor.nome, cpf: gestor.cpf, papel: gestor.papel,
          master: gestor.papel === 'Master', fundador: !!gestor.fundador, abrigo: gestor.abrigo
        });
      }

      if (data.action === 'checkDuplicate') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        const todos = await todosCadastros(db);
        const normName = String(data.nome || '').trim().toLowerCase();
        const cpfDigits = String(data.cpf || '').replace(/\D/g, '');
        let match = null;
        for (const r of todos) {
          if (r.status === 'Cancelado') continue;
          if (data.excludeId && r.id === data.excludeId) continue;
          const rCpf = String(r.cpf || '').replace(/\D/g, '');
          const rNome = String(r.responsavel || '').trim().toLowerCase();
          if ((cpfDigits && rCpf && cpfDigits === rCpf) || (normName && rNome === normName)) {
            match = { responsavel: r.responsavel, dataHora: r.ts, profissional: r.profissional_nome };
            break;
          }
        }
        return jsonOut({ match });
      }

      if (data.action === 'meusCadastros') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        const cpfDigits = String(gestor.cpf || '').replace(/\D/g, '');
        const todos = await todosCadastros(db);
        const meus = todos.filter(r => {
          if (cpfDigits) return String(r.profissional_cpf || '').replace(/\D/g, '') === cpfDigits;
          return String(r.profissional_nome || '').trim() === gestor.nome;
        });
        return jsonOut({ rows: meus.map(linhaParaHeaders) });
      }

      if (data.action === 'gestorData') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        let todos = await todosCadastros(db);
        if (gestor.papel === 'Técnico' && gestor.abrigo) {
          todos = todos.filter(r => r.abrigo === gestor.abrigo || (r.situacao === SITUACOES[0] && !r.abrigo));
        }
        const payload = await computeStatsPayload(db, todos);
        payload.rows = todos.map(linhaParaHeaders);
        payload.nome = gestor.nome;
        payload.master = gestor.papel === 'Master';
        payload.fundador = !!gestor.fundador;
        payload.abrigo = gestor.abrigo;
        // Mesmo escopo de `todos` acima (Técnico restrito só vê do seu
        // abrigo) — filtrado em JS pelo conjunto de ids já calculado, sem
        // precisar de JOIN em SQL.
        const idsPermitidos = new Set(todos.map(r => r.id));
        const { results: todosAtendimentos } = await db.prepare(
          'SELECT * FROM atendimentos ORDER BY ts DESC'
        ).all();
        payload.atendimentos = todosAtendimentos
          .filter(a => idsPermitidos.has(a.familia_id))
          .map(a => ({
            id: a.id, familiaId: a.familia_id, ts: a.ts, gestorNome: a.gestor_nome,
            tipo: a.tipo, observacao: a.observacao, status: a.status
          }));
        return jsonOut(payload);
      }

      if (data.action === 'listGestores') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        if (gestor.papel !== 'Master') return erroSoMaster();
        // O campo pin/pin_lookup nunca sai daqui — é a mudança central desta
        // migração. Não existe mais "ver o PIN de alguém".
        const { results } = await db.prepare('SELECT id, nome, cpf, papel, fundador, abrigo FROM gestores').all();
        return jsonOut({ gestores: results });
      }

      if (data.action === 'addGestor') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        if (gestor.papel !== 'Master') return erroSoMaster();
        const novoNome = String(data.novoNome || '').trim();
        const novoCpf = String(data.novoCpf || '').trim();
        if (!novoNome) return jsonOut({ error: 'Nome é obrigatório.' });
        const papelPedido = String(data.papel || 'Profissional');
        // Só o fundador promove outro acesso a Master — senão vira Técnico.
        const papelFinal = (papelPedido === 'Master' && !gestor.fundador) ? 'Técnico' : papelPedido;
        const novoAbrigo = papelFinal === 'Técnico' ? String(data.abrigo || '') : '';
        const novoPin = gerarPin();
        const lookup = await hmacPin(novoPin, env.PIN_PEPPER);
        let novoId;
        try {
          const inserido = await db.prepare(
            'INSERT INTO gestores (pin_lookup, nome, cpf, papel, fundador, abrigo) VALUES (?, ?, ?, ?, 0, ?) RETURNING id'
          ).bind(lookup, novoNome, novoCpf, papelFinal, novoAbrigo).first();
          novoId = inserido.id;
        } catch (e) {
          return jsonOut({ error: 'Já existe um acesso com esse PIN. Tente de novo.' });
        }
        await logHistorico(db, gestor.nome, '', '', [{
          campo: 'Acesso',
          alteracao: 'PIN adicionado para ' + novoNome + ' (' + papelFinal + (novoAbrigo ? ' — ' + novoAbrigo : '') + ')'
        }]);
        // O PIN só existe aqui, na resposta desta chamada — nunca mais.
        return jsonOut({ status: 'ok', id: novoId, novoPin });
      }

      if (data.action === 'editGestor') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        if (gestor.papel !== 'Master') return erroSoMaster();
        const alvo = await db.prepare('SELECT * FROM gestores WHERE id = ?').bind(data.id).first();
        if (!alvo) return jsonOut({ error: 'Acesso não encontrado.' });
        if (alvo.fundador) return jsonOut({ error: 'O acesso fundador não pode ser editado por aqui.' });
        let papelNovo = String(data.papel || alvo.papel);
        if (papelNovo === 'Master' && !gestor.fundador) papelNovo = alvo.papel;
        const abrigoNovo = papelNovo === 'Técnico' ? String(data.abrigo != null ? data.abrigo : alvo.abrigo) : '';
        const nomeNovo = String(data.nome || alvo.nome);
        const cpfNovo = String(data.cpf != null ? data.cpf : alvo.cpf);
        await db.prepare('UPDATE gestores SET nome=?, cpf=?, papel=?, abrigo=? WHERE id=?')
          .bind(nomeNovo, cpfNovo, papelNovo, abrigoNovo, alvo.id).run();
        await logHistorico(db, gestor.nome, '', '', [{ campo: 'Acesso', alteracao: 'Acesso editado: ' + nomeNovo }]);
        return jsonOut({ status: 'ok' });
      }

      if (data.action === 'redefinirPin') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        if (gestor.papel !== 'Master') return erroSoMaster();
        const alvo = await db.prepare('SELECT id, nome, fundador FROM gestores WHERE id = ?').bind(data.idAlvo).first();
        if (!alvo) return jsonOut({ error: 'Acesso não encontrado.' });
        // Mesma trava do editGestor: o fundador não é tocável por acesso
        // administrativo comum, nem pra redefinir o próprio PIN dele.
        if (alvo.fundador) return jsonOut({ error: 'O PIN fundador não pode ser redefinido por aqui.' });
        const novoPin = gerarPin();
        const lookup = await hmacPin(novoPin, env.PIN_PEPPER);
        await db.prepare('UPDATE gestores SET pin_lookup = ? WHERE id = ?').bind(lookup, alvo.id).run();
        await logHistorico(db, gestor.nome, '', '', [{ campo: 'Acesso', alteracao: 'PIN redefinido para ' + alvo.nome }]);
        return jsonOut({ status: 'ok', novoPin });
      }

      if (data.action === 'removeGestor') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        if (gestor.papel !== 'Master') return erroSoMaster();
        const idRemover = data.id;
        if (idRemover === gestor.id) {
          return jsonOut({ error: 'Não é possível remover o próprio acesso enquanto estiver logado com ele.' });
        }
        const { results: todosGestores } = await db.prepare('SELECT * FROM gestores').all();
        const alvo = todosGestores.find(g => g.id === idRemover);
        if (!alvo) return jsonOut({ error: 'Acesso não encontrado.' });
        if (alvo.fundador) return jsonOut({ error: 'O acesso fundador não pode ser removido por aqui.' });
        const mastersRestantes = todosGestores.filter(g => g.papel === 'Master' && g.id !== idRemover).length;
        if (alvo.papel === 'Master' && mastersRestantes === 0) {
          return jsonOut({ error: 'Não é possível remover o último master.' });
        }
        await db.prepare('DELETE FROM gestores WHERE id = ?').bind(idRemover).run();
        await logHistorico(db, gestor.nome, '', '', [{ campo: 'Acesso', alteracao: 'PIN removido: ' + alvo.nome }]);
        return jsonOut({ status: 'ok' });
      }

      if (data.action === 'archiveEvent') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        if (gestor.papel !== 'Master') return erroSoMaster();

        const nomeBase = String(data.nomeEvento || 'Evento').replace(/[\[\]\*\/\\\?:]/g, '').substring(0, 80);
        const hoje = new Date();
        const dataStr = String(hoje.getDate()).padStart(2, '0') + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + hoje.getFullYear();
        const nomeArquivo = ('Arquivo - ' + nomeBase + ' - ' + dataStr).substring(0, 100);
        const tabelaBase = 'arquivo_' + slugify(nomeBase + '_' + dataStr);

        const { results: tabelasExistentes } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const nomesExistentes = tabelasExistentes.map(t => t.name);
        let tabelaFinal = tabelaBase;
        let nomeArquivoFinal = nomeArquivo;
        let suffix = 1;
        while (nomesExistentes.includes(tabelaFinal)) {
          suffix++;
          tabelaFinal = (tabelaBase + '_' + suffix).substring(0, 60);
          nomeArquivoFinal = (nomeArquivo + ' (' + suffix + ')').substring(0, 100);
        }

        const stmts = [
          db.prepare(`CREATE TABLE "${tabelaFinal}" AS SELECT * FROM cadastros`),
          db.prepare('DELETE FROM cadastros'),
          db.prepare("INSERT INTO picos (chave, valor) VALUES ('peak_total', 0) ON CONFLICT(chave) DO UPDATE SET valor = 0")
        ];
        ABRIGOS.forEach((_, i) => {
          stmts.push(db.prepare(
            `INSERT INTO picos (chave, valor) VALUES ('peak_abrigo_${i}', 0) ON CONFLICT(chave) DO UPDATE SET valor = 0`
          ));
        });
        await db.batch(stmts);

        await logHistorico(db, gestor.nome, '', '', [{
          campo: 'Evento', alteracao: 'Evento encerrado e arquivado em "' + nomeArquivoFinal + '"'
        }]);
        return jsonOut({ status: 'ok', arquivoNome: nomeArquivoFinal });
      }

      if (data.action === 'upsert') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);

        const existing = await db.prepare('SELECT * FROM cadastros WHERE id = ?').bind(data.id).first();

        if (gestor.papel === 'Técnico' && gestor.abrigo && existing) {
          const abrigoExistente = existing.abrigo || '';
          const situacaoExistente = existing.situacao || '';
          const podeEditar = abrigoExistente === gestor.abrigo || (situacaoExistente === SITUACOES[0] && !abrigoExistente);
          if (!podeEditar) return jsonOut({ error: 'Você só pode editar cadastros do seu abrigo.' });
        }

        // Campos "administrativos": só sobrescrevem se vierem explicitamente
        // no payload; senão mantêm o valor já salvo (mesma regra de
        // adminValue() no Code.gs).
        function adminValue(campoPayload, campoExisting) {
          if (Object.prototype.hasOwnProperty.call(data, campoPayload)) return data[campoPayload] || '';
          if (existing) return existing[campoExisting] || '';
          return '';
        }

        // Localização da casa: um valor vazio nunca apaga um valor já
        // gravado. Sem isso, um cadastro antigo em campo — criado offline,
        // sincronizado depois de o mapa já ter descoberto a coordenada pelo
        // endereço — reenviaria gpsLat/gpsLng/gpsOrigem vazios e apagaria o
        // que o mapa acabou de gravar. Nenhuma tela oferece "apagar a
        // localização", então isso nunca tira nada de ninguém.
        function keepIfEmpty(valorNovo, campoExisting) {
          const v = String(valorNovo == null ? '' : valorNovo);
          if (v) return v;
          return existing ? String(existing[campoExisting] || '') : '';
        }

        const novaLinha = {
          id: data.id,
          ts: new Date().toISOString(), // igual ao Code.gs: sempre "agora", inclusive numa edição
          responsavel: data.responsavel || '',
          cpf: data.cpf || '',
          endereco: data.endereco || '',
          gps_lat: keepIfEmpty(data.gpsLat, 'gps_lat'),
          gps_lng: keepIfEmpty(data.gpsLng, 'gps_lng'),
          gps_origem: keepIfEmpty(data.gpsOrigem, 'gps_origem'),
          bairro: data.bairro || '',
          integrantes: data.integrantes || '',
          nomes_integrantes: data.nomesIntegrantes || '',
          situacao: data.situacao || '',
          observacoes: data.observacoes || '',
          profissional_nome: data.profissionalNome || '',
          profissional_cpf: data.profissionalCpf || '',
          status: data.status || '',
          motivo_cancelamento: data.motivoCancelamento || '',
          abrigo: adminValue('abrigo', 'abrigo'),
          id_abrigo: adminValue('idAbrigo', 'id_abrigo'),
          pessoas_alimentacao: adminValue('pessoasAlimentacao', 'pessoas_alimentacao'),
          data_saida_abrigo: adminValue('dataSaidaAbrigo', 'data_saida_abrigo'),
          obs_abrigo: adminValue('obsAbrigo', 'obs_abrigo'),
          composicao_etaria: adminValue('composicaoEtaria', 'composicao_etaria'),
          contato: data.contato || ''
        };

        const changes = [];
        if (!existing) {
          changes.push({ campo: 'Cadastro', alteracao: 'Família criada pelo gestor' });
        } else {
          COLUNAS_CADASTRO.forEach(([col, label]) => {
            if (col === 'id' || col === 'ts') return;
            const antes = String(existing[col] || '');
            const depois = String(novaLinha[col] || '');
            if (antes !== depois) {
              changes.push({ campo: label, alteracao: (antes || '(vazio)') + ' → ' + (depois || '(vazio)') });
            }
          });
        }
        if (changes.length > 0) {
          await logHistorico(db, gestor.nome, data.id, data.responsavel || (existing ? existing.responsavel : ''), changes);
        }

        const colNames = COLUNAS_CADASTRO.map(([c]) => c);
        const placeholders = colNames.map(() => '?').join(',');
        const updateSet = colNames.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(', ');
        const sql = `INSERT INTO cadastros (${colNames.join(',')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updateSet}`;
        await db.prepare(sql).bind(...colNames.map(c => novaLinha[c])).run();

        return jsonOut({ status: 'ok' });
      }

      if (data.action === 'delete') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        const existing = await db.prepare('SELECT * FROM cadastros WHERE id = ?').bind(data.id).first();
        if (existing) {
          if (gestor.papel === 'Técnico' && gestor.abrigo && (existing.abrigo || '') !== gestor.abrigo) {
            return jsonOut({ error: 'Você só pode excluir cadastros do seu abrigo.' });
          }
          await logHistorico(db, gestor.nome, data.id, existing.responsavel, [{ campo: 'Exclusão', alteracao: 'Cadastro excluído definitivamente' }]);
          await db.prepare('DELETE FROM cadastros WHERE id = ?').bind(data.id).run();
        }
        // Idempotente: ID não encontrado também devolve ok, igual ao Code.gs.
        return jsonOut({ status: 'ok' });
      }

      if (data.action === 'definirLocalCasa') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        const existing = await db.prepare('SELECT * FROM cadastros WHERE id = ?').bind(data.id).first();
        if (!existing) return jsonOut({ error: 'Cadastro não encontrado.' });
        if (gestor.papel === 'Técnico' && gestor.abrigo) {
          const abrigoExistente = existing.abrigo || '';
          const situacaoExistente = existing.situacao || '';
          const podeEditar = abrigoExistente === gestor.abrigo || (situacaoExistente === SITUACOES[0] && !abrigoExistente);
          if (!podeEditar) return jsonOut({ error: 'Você só pode editar cadastros do seu abrigo.' });
        }
        const lat = String(data.lat == null ? '' : data.lat);
        const lng = String(data.lng == null ? '' : data.lng);
        const origem = String(data.origem || '');
        if (!lat || !lng) return jsonOut({ error: 'Latitude e longitude são obrigatórias.' });
        if (['no_local', 'endereco', 'ajustado'].indexOf(origem) === -1) {
          return jsonOut({ error: 'Origem da localização inválida.' });
        }
        // Só estas três colunas — nunca a linha inteira. Diferente do
        // upsert, que reescreve o cadastro completo, esta ação não tem como
        // danificar nome, endereço ou dados de abrigo, mesmo que o payload
        // venha incompleto ou malformado.
        await db.prepare('UPDATE cadastros SET gps_lat = ?, gps_lng = ?, gps_origem = ? WHERE id = ?')
          .bind(lat, lng, origem, data.id).run();
        const rotuloOrigem = origem === 'no_local' ? 'confirmada no local'
          : origem === 'ajustado' ? 'ajustada no mapa' : 'estimada pelo endereço';
        await logHistorico(db, gestor.nome, data.id, existing.responsavel, [{
          campo: 'Localização da casa',
          alteracao: (existing.gps_lat ? 'Atualizada' : 'Definida') + ' — ' + rotuloOrigem
        }]);
        return jsonOut({ status: 'ok' });
      }

      if (data.action === 'registrarAtendimento') {
        const { gestor, limitado } = await autenticar(db, env.PIN_PEPPER, data.password);
        if (!gestor) return erroAutenticacao(limitado);
        const existing = await db.prepare('SELECT * FROM cadastros WHERE id = ?').bind(data.familiaId).first();
        if (!existing) return jsonOut({ error: 'Cadastro não encontrado.' });
        if (gestor.papel === 'Técnico' && gestor.abrigo) {
          const abrigoExistente = existing.abrigo || '';
          const situacaoExistente = existing.situacao || '';
          const podeEditar = abrigoExistente === gestor.abrigo || (situacaoExistente === SITUACOES[0] && !abrigoExistente);
          if (!podeEditar) return jsonOut({ error: 'Você só pode registrar atendimento de famílias do seu abrigo.' });
        }
        const tipo = String(data.tipo || '');
        const status = String(data.status || '');
        const observacao = String(data.observacao || '').trim();
        if (['visita', 'ligacao', 'encaminhamento', 'entrega', 'outro'].indexOf(tipo) === -1) {
          return jsonOut({ error: 'Tipo de atendimento inválido.' });
        }
        if (['pendente', 'resolvido'].indexOf(status) === -1) {
          return jsonOut({ error: 'Status de atendimento inválido.' });
        }
        const now = new Date().toISOString();
        const inserido = await db.prepare(
          'INSERT INTO atendimentos (familia_id, ts, gestor_nome, tipo, observacao, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
        ).bind(data.familiaId, now, gestor.nome, tipo, observacao, status).first();
        await logHistorico(db, gestor.nome, data.familiaId, existing.responsavel, [{
          campo: 'Atendimento', alteracao: tipo + ' — ' + status
        }]);
        return jsonOut({ status: 'ok', id: inserido.id });
      }

      // Chão de segurança: action não reconhecida nunca cai no caminho de
      // criar/editar cadastro (mesmo motivo do Code.gs linha 541-550).
      return jsonOut({ error: 'ação desconhecida: ' + data.action });
    } catch (e) {
      return jsonOut({ error: 'Erro no servidor: ' + e.message });
    }
  }
};
