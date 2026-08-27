// Piloto D1 — backend enxuto, só o essencial: login, cadastro de família,
// e gerenciar acessos com o modelo "só redefinir" (nunca ver o PIN de volta).
// Não é o substituto completo do Code.gs — isso é uma migração à parte.

const AUTH_FAIL_LIMIT = 30;
const AUTH_FAIL_WINDOW_SECONDS = 60;

// CORS só existe porque este piloto roda em duas portas locais diferentes
// (app em 8098, Worker em 8787) — na migração de verdade, ambos ficariam no
// mesmo domínio (como já é hoje: o site e o Apps Script são chamados de
// origens diferentes hoje também, então isso não é uma novidade de risco).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

function jsonOut(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
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

function pinValido(pin) {
  return /^\d{6}$/.test(String(pin || ''));
}

function gerarPin() {
  // 6 dígitos, sempre preenchendo a casa da esquerda (nunca "012345" virando "12345").
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
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

async function buscarGestorPorPin(db, pepper, pin) {
  const lookup = await hmacPin(pin, pepper);
  if (await isRateLimited(db, lookup)) return { limitado: true };
  const row = await db.prepare(
    'SELECT id, nome, cpf, papel, fundador, abrigo FROM gestores WHERE pin_lookup = ?'
  ).bind(lookup).first();
  if (!row) { await registrarFalha(db, lookup); return { gestor: null }; }
  return { gestor: row };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'POST') return jsonOut({ error: 'método não suportado' }, 405);
    let data;
    try { data = await request.json(); } catch (e) { return jsonOut({ error: 'corpo inválido' }, 400); }
    const db = env.DB;

    try {
      if (data.action === 'login') {
        const { gestor, limitado } = await buscarGestorPorPin(db, env.PIN_PEPPER, data.pin);
        if (limitado) return jsonOut({ error: 'Muitas tentativas seguidas com este PIN. Espere um minuto e tente de novo.', retry: true });
        if (!gestor) return jsonOut({ error: 'PIN inválido.' });
        return jsonOut({ nome: gestor.nome, cpf: gestor.cpf, papel: gestor.papel, master: gestor.papel === 'Master', fundador: !!gestor.fundador, abrigo: gestor.abrigo });
      }

      if (data.action === 'upsert') {
        const { gestor } = await buscarGestorPorPin(db, env.PIN_PEPPER, data.password);
        if (!gestor) return jsonOut({ error: 'não autorizado', authFailed: true });
        if (!data.responsavel || !data.contato) return jsonOut({ error: 'responsável e contato são obrigatórios' });
        await db.prepare(`
          INSERT INTO cadastros (id, ts, responsavel, cpf, contato, situacao, profissional_nome, profissional_cpf)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            responsavel=excluded.responsavel, cpf=excluded.cpf, contato=excluded.contato,
            situacao=excluded.situacao
        `).bind(
          data.id, new Date().toISOString(), data.responsavel, data.cpf || '',
          data.contato, data.situacao || '', gestor.nome, gestor.cpf || ''
        ).run();
        return jsonOut({ status: 'ok' });
      }

      if (data.action === 'meusCadastros') {
        const { gestor } = await buscarGestorPorPin(db, env.PIN_PEPPER, data.password);
        if (!gestor) return jsonOut({ error: 'não autorizado', authFailed: true });
        const { results } = await db.prepare('SELECT * FROM cadastros WHERE profissional_cpf = ? ORDER BY ts DESC')
          .bind(gestor.cpf || '').all();
        return jsonOut({ rows: results });
      }

      if (data.action === 'listGestores') {
        const { gestor } = await buscarGestorPorPin(db, env.PIN_PEPPER, data.password);
        if (!gestor) return jsonOut({ error: 'não autorizado', authFailed: true });
        if (gestor.papel !== 'Master') return jsonOut({ error: 'Esta ação é permitida apenas para acessos master.' });
        // O campo pin NUNCA está aqui — é a mudança estrutural do piloto.
        // Não existe "ver o PIN de alguém" porque o hash não tem volta.
        const { results } = await db.prepare('SELECT id, nome, cpf, papel, fundador, abrigo FROM gestores').all();
        return jsonOut({ gestores: results });
      }

      if (data.action === 'addGestor') {
        const { gestor } = await buscarGestorPorPin(db, env.PIN_PEPPER, data.password);
        if (!gestor) return jsonOut({ error: 'não autorizado', authFailed: true });
        if (gestor.papel !== 'Master') return jsonOut({ error: 'Esta ação é permitida apenas para acessos master.' });
        if (!data.novoNome) return jsonOut({ error: 'Nome é obrigatório.' });
        const novoPin = gerarPin();
        const lookup = await hmacPin(novoPin, env.PIN_PEPPER);
        try {
          await db.prepare('INSERT INTO gestores (pin_lookup, nome, cpf, papel, fundador, abrigo) VALUES (?, ?, ?, ?, 0, ?)')
            .bind(lookup, data.novoNome, data.novoCpf || '', data.papel || 'Profissional', data.abrigo || '').run();
        } catch (e) {
          return jsonOut({ error: 'Já existe um acesso com esse PIN. Tente de novo.' });
        }
        // O PIN só existe aqui, na resposta desta chamada — nunca mais.
        return jsonOut({ status: 'ok', novoPin });
      }

      if (data.action === 'redefinirPin') {
        const { gestor } = await buscarGestorPorPin(db, env.PIN_PEPPER, data.password);
        if (!gestor) return jsonOut({ error: 'não autorizado', authFailed: true });
        if (gestor.papel !== 'Master') return jsonOut({ error: 'Esta ação é permitida apenas para acessos master.' });
        const novoPin = gerarPin();
        const lookup = await hmacPin(novoPin, env.PIN_PEPPER);
        await db.prepare('UPDATE gestores SET pin_lookup = ? WHERE id = ?').bind(lookup, data.idAlvo).run();
        return jsonOut({ status: 'ok', novoPin });
      }

      return jsonOut({ error: 'ação desconhecida: ' + data.action });
    } catch (e) {
      return jsonOut({ error: 'Erro no servidor: ' + e.message });
    }
  }
};
