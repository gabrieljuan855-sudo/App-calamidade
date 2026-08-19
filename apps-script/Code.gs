// ---- Login unificado: todo mundo (profissional, técnico, master) tem PIN
// próprio, guardado na aba "Gestores" da própria planilha. Dá pra gerenciar
// quem tem acesso direto pelo app, por quem for "master". Na primeira vez
// que o script rodar, essa aba é criada sozinha com um PIN aleatório (nunca
// fixo no código-fonte — ele fica visível no Apps Script Editor em
// Execuções > Logs dessa primeira chamada) como fundador/master.
var NOME_FUNDADOR_INICIAL = 'Gabriel';

function gerarPinAleatorio() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// "Contato" fica sempre como a ÚLTIMA coluna — colunas novas devem ser
// sempre adicionadas no final, nunca no meio. Os índices em ADMIN_COL e
// todo o resto do código dependem da posição de cada coluna já existente
// não mudar quando a planilha se automigra pra um HEADERS mais novo.
var HEADERS = ['ID','Data/Hora','Responsável familiar','CPF','Endereço','Latitude','Longitude','Bairro','Integrantes','Nomes dos integrantes','Situação','Observações','Profissional responsável','CPF do profissional','Status','Motivo do cancelamento','Abrigo','ID no abrigo','Pessoas que se alimentam','Data de saída do abrigo','Observações do abrigo','Composição etária','Contato'];
var ADMIN_COL = { abrigo: 16, idAbrigo: 17, pessoasAlimentacao: 18, dataSaidaAbrigo: 19, obsAbrigo: 20, composicaoEtaria: 21 };

var SITUACOES = [
  'Desabrigada — acolhida em abrigo público',
  'Desalojada — saiu de casa mas não foi para abrigo',
  'Atingida — permanece no local'
];
var ABRIGOS = ['CPS Empresa', 'Associação dos Motoristas'];
var GESTORES_HEADERS = ['PIN', 'Nome', 'CPF', 'Papel', 'Fundador', 'Abrigo'];

function getGestoresSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Gestores');
  if (!sheet) {
    sheet = ss.insertSheet('Gestores');
    sheet.getRange(1, 1, 1, 6).setValues([GESTORES_HEADERS]);
    var pinFundador = gerarPinAleatorio();
    sheet.appendRow([pinFundador, NOME_FUNDADOR_INICIAL, '', 'Master', true, '']);
    Logger.log('PIN fundador gerado para "' + NOME_FUNDADOR_INICIAL + '": ' + pinFundador + ' — anote agora, ele não aparece de novo aqui.');
    return sheet;
  }
  var headerRow = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  var headers = headerRow.map(function(h){ return String(h || '').trim(); });
  if (headers[2] !== 'CPF') {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var dadosAntigos = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      var novasLinhas = dadosAntigos.map(function(row){
        var masterAntigo = row[2] === true || row[2] === 'TRUE' || row[2] === 'true';
        var fundadorAntigo = row[3] === true || row[3] === 'TRUE' || row[3] === 'true';
        return [row[0], row[1], '', masterAntigo ? 'Master' : 'Técnico', fundadorAntigo, ''];
      });
      sheet.getRange(1, 1, 1, 6).setValues([GESTORES_HEADERS]);
      sheet.getRange(2, 1, novasLinhas.length, 6).setValues(novasLinhas);
    } else {
      sheet.getRange(1, 1, 1, 6).setValues([GESTORES_HEADERS]);
    }
  } else if (headers[5] !== 'Abrigo') {
    var lastRow2 = sheet.getLastRow();
    sheet.getRange(1, 6, 1, 1).setValues([['Abrigo']]);
    if (lastRow2 > 1 && sheet.getLastColumn() < 6) {
      sheet.getRange(2, 6, lastRow2 - 1, 1).setValues(Array(lastRow2 - 1).fill(['']));
    }
  }
  return sheet;
}

// Cache válido só durante a requisição atual (cada chamada roda num contexto
// novo no Apps Script). Um único upsert chamava getGestorInfo/checkPassword
// três vezes, relendo a aba "Gestores" inteira a cada vez — com uma fila de
// cadastros sincronizando, isso multiplicava leituras à toa.
var _gestoresCache = null;
function invalidarGestoresCache() { _gestoresCache = null; }

function getGestores() {
  if (_gestoresCache) return _gestoresCache;
  _gestoresCache = lerGestores();
  return _gestoresCache;
}

function lerGestores() {
  var sheet = getGestoresSheet();
  if (sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  return values.map(function(row, i) {
    var papel = String(row[3] || 'Técnico');
    return {
      row: i + 2,
      pin: String(row[0]),
      nome: row[1],
      cpf: String(row[2] || ''),
      papel: papel,
      master: papel === 'Master',
      fundador: row[4] === true || row[4] === 'TRUE' || row[4] === 'true',
      abrigo: String(row[5] || '')
    };
  });
}

// Freio contra força bruta de PIN: conta tentativas de PIN inválido numa
// janela de 60s (via CacheService, compartilhado entre todas as execuções).
// Passado o limite, novas tentativas são recusadas sem nem consultar a
// planilha — até a janela expirar.
//
// Duas regras aqui existem pra impedir que esse freio derrube quem tem acesso
// legítimo (era o que acontecia antes):
//
// 1. A contagem é POR PIN, não global. Com um contador único pro script
//    inteiro, os erros de digitação de uma pessoa bloqueavam a equipe toda —
//    e o app, ao receber "não autorizado", apagava a sessão de todo mundo.
// 2. A janela é FIXA, não deslizante. Renovando o TTL a cada falha, o bloqueio
//    se auto-alimentava: cada nova tentativa (inclusive as automáticas do app)
//    empurrava a liberação mais 60s adiante, e o acesso nunca voltava sozinho.
var AUTH_FAIL_LIMIT = 30;
var AUTH_FAIL_WINDOW_SECONDS = 60;

function authFailKey(pwd) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pwd));
  return 'auth_fail_' + Utilities.base64EncodeWebSafe(digest);
}

function isAuthRateLimited(pwd) {
  if (!pwd) return false;
  var raw = CacheService.getScriptCache().get(authFailKey(pwd));
  if (!raw) return false;
  return parseInt(String(raw).split('|')[0], 10) >= AUTH_FAIL_LIMIT;
}

function registerAuthFailure(pwd) {
  if (!pwd) return;
  var cache = CacheService.getScriptCache();
  var key = authFailKey(pwd);
  var raw = cache.get(key);
  var now = Date.now();
  var count = 1;
  var start = now;
  if (raw) {
    var parts = String(raw).split('|');
    count = parseInt(parts[0], 10) + 1;
    start = parseInt(parts[1], 10) || now;
  }
  // Guarda o TTL restante da janela original, em vez de reiniciar 60s do zero.
  var restante = AUTH_FAIL_WINDOW_SECONDS - Math.floor((now - start) / 1000);
  if (restante <= 0) { count = 1; start = now; restante = AUTH_FAIL_WINDOW_SECONDS; }
  cache.put(key, count + '|' + start, restante);
}

function getGestorInfo(pwd) {
  var pin = String(pwd == null ? '' : pwd).trim();
  // Chamada sem PIN nenhum não é tentativa de força bruta (o app manda '' em
  // algumas rotas quando ainda não há sessão) — não pode contar como falha.
  if (!pin) return null;
  if (isAuthRateLimited(pin)) return null;
  var info = getGestores().filter(function(g) { return g.pin === pin; })[0] || null;
  if (!info) registerAuthFailure(pin);
  return info;
}

function checkPassword(pwd) {
  var info = getGestorInfo(pwd);
  return info ? info.nome : null;
}

// Erro de autenticação, já separando os dois casos que o app precisa tratar
// de formas opostas:
//   - authFailed: o PIN realmente não vale mais (removido/alterado). Só aqui
//     faz sentido o app apagar a sessão guardada no aparelho.
//   - retry: bloqueio temporário por excesso de tentativas. Passa sozinho —
//     apagar a sessão nesse caso deixava o usuário sem conseguir voltar.
function authErrorOut(pwd) {
  if (isAuthRateLimited(pwd)) {
    return jsonOut({ error: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.', retry: true });
  }
  return jsonOut({ error: 'não autorizado', authFailed: true });
}

// Ação exige master: quem chegou aqui tem PIN válido, só não tem permissão.
// Nunca é motivo pra deslogar.
function masterErrorOut() {
  return jsonOut({ error: 'Esta ação é permitida apenas para acessos master.' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function logHistorico(gestorNome, familyId, familyNome, changes) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Histórico');
  if (!sheet) {
    sheet = ss.insertSheet('Histórico');
    sheet.getRange(1, 1, 1, 6).setValues([['Data/Hora', 'Gestor', 'ID da família', 'Família', 'Campo', 'Alteração']]);
  }
  var now = new Date();
  changes.forEach(function(c){
    sheet.appendRow([now, gestorNome, familyId, familyNome, c.campo, c.alteracao]);
  });
}

function getAllRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Cadastros');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  return values.map(function(row){
    var obj = {};
    HEADERS.forEach(function(h, i){ obj[h] = row[i]; });
    return obj;
  });
}

function statsFor(list) {
  var pessoas = 0, alimentam = 0;
  list.forEach(function(r){
    pessoas += parseInt(r['Integrantes'], 10) || 1;
    alimentam += parseInt(r['Pessoas que se alimentam'], 10) || 0;
  });
  return { familias: list.length, pessoas: pessoas, alimentam: alimentam };
}

function updateAndGetPeaks(totalPessoas, porAbrigoPessoas) {
  var props = PropertiesService.getScriptProperties();
  var atuais = props.getProperties();
  var peakTotal = Math.max(parseInt(atuais['peak_total'] || '0', 10), totalPessoas);

  var porAbrigo = {};
  var atualizacoes = { peak_total: String(peakTotal) };
  ABRIGOS.forEach(function(nome, i){
    var key = 'peak_abrigo_' + i;
    var atual = porAbrigoPessoas[nome] || 0;
    var pico = Math.max(parseInt(atuais[key] || '0', 10), atual);
    atualizacoes[key] = String(pico);
    porAbrigo[nome] = pico;
  });
  props.setProperties(atualizacoes);

  return { total: peakTotal, porAbrigo: porAbrigo };
}

function computeStatsPayload(allRows) {
  var active = allRows.filter(function(r){ return r['Status'] !== 'Cancelado'; });

  var situacao = {};
  SITUACOES.forEach(function(s){
    situacao[s] = statsFor(active.filter(function(r){ return r['Situação'] === s; }));
  });
  var total = statsFor(active);

  var desabrigadas = active.filter(function(r){ return r['Situação'] === SITUACOES[0]; });
  var aindaAbrigadas = desabrigadas.filter(function(r){ return r['Abrigo'] && !r['Data de saída do abrigo']; });
  var semAbrigo = desabrigadas.filter(function(r){ return !r['Abrigo']; });

  var porAbrigo = {};
  var porAbrigoPessoas = {};
  ABRIGOS.forEach(function(nome){
    var st = statsFor(aindaAbrigadas.filter(function(r){ return r['Abrigo'] === nome; }));
    porAbrigo[nome] = st;
    porAbrigoPessoas[nome] = st.pessoas;
  });
  var totalAbrigo = statsFor(aindaAbrigadas);
  var semAbrigoStats = statsFor(semAbrigo);

  var peaks = updateAndGetPeaks(totalAbrigo.pessoas, porAbrigoPessoas);

  return {
    stats: {
      situacao: situacao,
      total: total,
      abrigos: { total: totalAbrigo, porAbrigo: porAbrigo, semAbrigo: semAbrigoStats }
    },
    peaks: peaks
  };
}

function getOrCreateBackupFolder() {
  var pastas = DriveApp.getFoldersByName('Backups - Cadastro de Famílias');
  if (pastas.hasNext()) return pastas.next();
  return DriveApp.createFolder('Backups - Cadastro de Famílias');
}

function limparBackupsAntigos(pasta) {
  var arquivos = [];
  var iter = pasta.getFiles();
  while (iter.hasNext()) arquivos.push(iter.next());
  arquivos.sort(function(a, b){ return b.getDateCreated() - a.getDateCreated(); });
  for (var i = 30; i < arquivos.length; i++) {
    arquivos[i].setTrashed(true);
  }
}

function backupDiario() {
  var arquivoAtual = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  var pastaBackup = getOrCreateBackupFolder();
  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT-3', 'yyyy-MM-dd_HHmm');
  arquivoAtual.makeCopy('Backup - Cadastro de Famílias - ' + timestamp, pastaBackup);
  limparBackupsAntigos(pastaBackup);
}

function configurarBackupDiario() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t){
    if (t.getHandlerFunction() === 'backupDiario') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupDiario')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
}

function doGet(e) {
  var allRows = getAllRows();
  return jsonOut(computeStatsPayload(allRows));
}

// Serializa as operações que ESCREVEM na planilha. Sem isso, dois aparelhos
// sincronizando ao mesmo tempo liam o mesmo getLastRow() e gravavam os dois na
// mesma linha — o segundo cadastro apagava o primeiro, sem erro nenhum. O mesmo
// valia para deleteRow, que desloca as linhas e fazia uma requisição paralela
// escrever por cima da família errada. Só os caminhos de escrita entram na
// trava; leituras (gestorData, meusCadastros) seguem em paralelo.
function comTrava(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return jsonOut({ error: 'Servidor ocupado agora. Tente de novo em instantes.', retry: true });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  // Sem esse try/catch, qualquer exceção faz o Apps Script devolver uma página
  // HTML de erro em vez de JSON. O app não consegue ler o motivo e trata tudo
  // como falha genérica de rede — erros reais ficam invisíveis.
  try {
    return rotearPost(JSON.parse(e.postData.contents));
  } catch (err) {
    return jsonOut({ error: 'Erro no servidor: ' + ((err && err.message) ? err.message : String(err)) });
  }
}

function rotearPost(data) {
  if (data.action === 'checkDuplicate') {
    if (!checkPassword(data.password)) return authErrorOut(data.password);
    var allRows = getAllRows();
    var normName = String(data.nome || '').trim().toLowerCase();
    var cpfDigits = String(data.cpf || '').replace(/\D/g, '');
    var match = null;
    for (var i = 0; i < allRows.length; i++) {
      var r = allRows[i];
      if (r['Status'] === 'Cancelado') continue;
      if (data.excludeId && r['ID'] === data.excludeId) continue;
      var rCpf = String(r['CPF'] || '').replace(/\D/g, '');
      var rNome = String(r['Responsável familiar'] || '').trim().toLowerCase();
      if ((cpfDigits && rCpf && cpfDigits === rCpf) || (normName && rNome === normName)) {
        match = { responsavel: r['Responsável familiar'], dataHora: r['Data/Hora'], profissional: r['Profissional responsável'] };
        break;
      }
    }
    return jsonOut({ match: match });
  }

  if (data.action === 'login') {
    var infoLogin = getGestorInfo(data.pin);
    if (!infoLogin) {
      if (isAuthRateLimited(data.pin)) {
        return jsonOut({ error: 'Muitas tentativas seguidas com este PIN. Espere um minuto e tente de novo.', retry: true });
      }
      return jsonOut({ error: 'PIN inválido.' });
    }
    return jsonOut({ nome: infoLogin.nome, cpf: infoLogin.cpf, papel: infoLogin.papel, master: infoLogin.master, fundador: infoLogin.fundador, abrigo: infoLogin.abrigo });
  }

  if (data.action === 'meusCadastros') {
    var infoMeus = getGestorInfo(data.password);
    if (!infoMeus) return authErrorOut(data.password);
    var cpfMeusDigits = String(infoMeus.cpf || '').replace(/\D/g, '');
    var meus = getAllRows().filter(function(r){
      if (cpfMeusDigits) {
        return String(r['CPF do profissional'] || '').replace(/\D/g, '') === cpfMeusDigits;
      }
      return String(r['Profissional responsável'] || '').trim() === infoMeus.nome;
    });
    return jsonOut({ rows: meus });
  }

  if (data.action === 'gestorData') {
    var info = getGestorInfo(data.password);
    if (!info) return authErrorOut(data.password);
    var allRows = getAllRows();
    if (info.papel === 'Técnico' && info.abrigo) {
      allRows = allRows.filter(function(r){
        return r['Abrigo'] === info.abrigo || (r['Situação'] === SITUACOES[0] && !r['Abrigo']);
      });
    }
    var payload = computeStatsPayload(allRows);
    payload.rows = allRows;
    payload.nome = info.nome;
    payload.master = info.master;
    payload.fundador = info.fundador;
    payload.abrigo = info.abrigo;
    return jsonOut(payload);
  }

  if (data.action === 'listGestores') {
    var infoL = getGestorInfo(data.password);
    if (!infoL) return authErrorOut(data.password);
    if (!infoL.master) return masterErrorOut();
    var lista = getGestores().map(function(g){ return { pin: g.pin, nome: g.nome, cpf: g.cpf, papel: g.papel, master: g.master, fundador: g.fundador, abrigo: g.abrigo }; });
    return jsonOut({ gestores: lista });
  }

  if (data.action === 'addGestor') {
    var infoA = getGestorInfo(data.password);
    if (!infoA) return authErrorOut(data.password);
    if (!infoA.master) return masterErrorOut();
    var novoPin = String(data.novoPin || '').trim();
    var novoNome = String(data.novoNome || '').trim();
    var novoCpf = String(data.novoCpf || '').trim();
    if (!novoPin || !novoNome) return jsonOut({ error: 'PIN e nome são obrigatórios.' });
    if (!/^\d{4,}$/.test(novoPin)) {
      return jsonOut({ error: 'O PIN precisa ter só números, com pelo menos 4 dígitos.' });
    }
    if (getGestores().some(function(g){ return g.pin === novoPin; })) {
      return jsonOut({ error: 'Já existe um acesso com esse PIN.' });
    }
    var papelPedido = String(data.papel || 'Profissional');
    var papelFinal = papelPedido === 'Master' && !infoA.fundador ? 'Técnico' : papelPedido;
    var novoAbrigo = papelFinal === 'Técnico' ? String(data.abrigo || '') : '';
    return comTrava(function(){
      getGestoresSheet().appendRow([novoPin, novoNome, novoCpf, papelFinal, false, novoAbrigo]);
      invalidarGestoresCache();
      logHistorico(infoA.nome, '', '', [{ campo: 'Acesso', alteracao: 'PIN adicionado para ' + novoNome + ' (' + papelFinal + (novoAbrigo ? ' — ' + novoAbrigo : '') + ')' }]);
      return jsonOut({ status: 'ok' });
    });
  }

  if (data.action === 'editGestor') {
    var infoE = getGestorInfo(data.password);
    if (!infoE) return authErrorOut(data.password);
    if (!infoE.master) return masterErrorOut();
    var pinAlvo = String(data.pinAlvo || '').trim();
    var gestoresEdit = getGestores();
    var alvoEdit = gestoresEdit.filter(function(g){ return g.pin === pinAlvo; })[0];
    if (!alvoEdit) return jsonOut({ error: 'PIN não encontrado.' });
    if (alvoEdit.fundador) return jsonOut({ error: 'O acesso fundador não pode ser editado por aqui.' });
    var papelNovo = String(data.papel || alvoEdit.papel);
    if (papelNovo === 'Master' && !infoE.fundador) papelNovo = alvoEdit.papel;
    var abrigoNovo = papelNovo === 'Técnico' ? String(data.abrigo != null ? data.abrigo : alvoEdit.abrigo) : '';

    // Troca de PIN pelo master: só acontece se um novoPin diferente do atual
    // for enviado — permite ao master editar nome/papel sem mexer no PIN.
    var pinNovo = alvoEdit.pin;
    var novoPinEdit = data.novoPin != null ? String(data.novoPin).trim() : '';
    if (novoPinEdit && novoPinEdit !== alvoEdit.pin) {
      if (!/^\d{4,}$/.test(novoPinEdit)) {
        return jsonOut({ error: 'O PIN precisa ter só números, com pelo menos 4 dígitos.' });
      }
      if (gestoresEdit.some(function(g){ return g.pin === novoPinEdit; })) {
        return jsonOut({ error: 'Já existe um acesso com esse PIN.' });
      }
      pinNovo = novoPinEdit;
    }

    return comTrava(function(){
      getGestoresSheet().getRange(alvoEdit.row, 1, 1, 6).setValues([[
        pinNovo, String(data.nome || alvoEdit.nome), String(data.cpf != null ? data.cpf : alvoEdit.cpf), papelNovo, alvoEdit.fundador, abrigoNovo
      ]]);
      invalidarGestoresCache();
      var changesEdit = [{ campo: 'Acesso', alteracao: 'Acesso editado: ' + (data.nome || alvoEdit.nome) }];
    if (pinNovo !== alvoEdit.pin) {
      changesEdit.push({ campo: 'Acesso', alteracao: 'PIN alterado pelo master para ' + (data.nome || alvoEdit.nome) });
    }
      logHistorico(infoE.nome, '', '', changesEdit);
      return jsonOut({ status: 'ok' });
    });
  }

  if (data.action === 'removeGestor') {
    var infoR = getGestorInfo(data.password);
    if (!infoR) return authErrorOut(data.password);
    if (!infoR.master) return masterErrorOut();
    var pinRemover = String(data.pinRemover || '').trim();
    if (pinRemover === String(data.password)) {
      return jsonOut({ error: 'Não é possível remover o próprio PIN enquanto estiver logado com ele.' });
    }
    var gestoresAtuais = getGestores();
    var alvo = gestoresAtuais.filter(function(g){ return g.pin === pinRemover; })[0];
    if (!alvo) return jsonOut({ error: 'PIN não encontrado.' });
    if (alvo.fundador) return jsonOut({ error: 'O PIN fundador não pode ser removido por aqui.' });
    var mastersRestantes = gestoresAtuais.filter(function(g){ return g.master && g.pin !== pinRemover; }).length;
    if (alvo.master && mastersRestantes === 0) {
      return jsonOut({ error: 'Não é possível remover o último master.' });
    }
    return comTrava(function(){
      getGestoresSheet().deleteRow(alvo.row);
      invalidarGestoresCache();
      logHistorico(infoR.nome, '', '', [{ campo: 'Acesso', alteracao: 'PIN removido: ' + alvo.nome }]);
      return jsonOut({ status: 'ok' });
    });
  }

  if (data.action === 'archiveEvent') {
    var infoArq = getGestorInfo(data.password);
    if (!infoArq) return authErrorOut(data.password);
    if (!infoArq.master) return masterErrorOut();
    return comTrava(function(){
      var gestorNomeArq = infoArq.nome;
      var ssArq = SpreadsheetApp.getActiveSpreadsheet();
      var sheetArq = ssArq.getSheetByName('Cadastros');
      var safeName = String(data.nomeEvento || 'Evento').replace(/[\[\]\*\/\\\?:]/g, '').substring(0, 80);
      var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT-3', 'dd-MM-yyyy');
      var arquivoNome = ('Arquivo - ' + safeName + ' - ' + timestamp).substring(0, 100);
      var arquivoNomeFinal = arquivoNome;
      var suffix = 1;
      while (ssArq.getSheetByName(arquivoNomeFinal)) {
        suffix++;
        arquivoNomeFinal = (arquivoNome + ' (' + suffix + ')').substring(0, 100);
      }
      var sheetNova = ssArq.insertSheet(arquivoNomeFinal);
      if (sheetArq && sheetArq.getLastRow() > 0) {
        var todosDados = sheetArq.getRange(1, 1, sheetArq.getLastRow(), HEADERS.length).getValues();
        sheetNova.getRange(1, 1, todosDados.length, HEADERS.length).setValues(todosDados);
        if (sheetArq.getLastRow() > 1) {
          sheetArq.deleteRows(2, sheetArq.getLastRow() - 1);
        }
      } else {
        sheetNova.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      }
      var propsArq = PropertiesService.getScriptProperties();
      var zerarProps = { peak_total: '0' };
      ABRIGOS.forEach(function(nome, i){ zerarProps['peak_abrigo_' + i] = '0'; });
      propsArq.setProperties(zerarProps);
      logHistorico(gestorNomeArq, '', '', [{ campo: 'Evento', alteracao: 'Evento encerrado e arquivado em "' + arquivoNomeFinal + '"' }]);
      return jsonOut({ status: 'ok', arquivoNome: arquivoNomeFinal });
    });
  }

  // Chão de segurança: tudo que chega até aqui embaixo é tratado como
  // criação/edição de cadastro (ou exclusão, no bloco logo abaixo). Sem essa
  // trava, qualquer ação não reconhecida (ex.: nome de ação novo no cliente
  // que um backend desatualizado ainda não conhece) cairia direto nesse
  // fallback e criaria uma linha em branco na planilha a cada chamada — foi
  // exatamente isso que aconteceu quando o cliente ganhou a ação
  // "meusCadastros" antes do backend ser atualizado.
  if (data.action !== 'upsert' && data.action !== 'delete') {
    return jsonOut({ error: 'ação desconhecida: ' + data.action });
  }

  return comTrava(function(){ return salvarOuExcluir(data); });
}

function salvarOuExcluir(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Cadastros') || ss.insertSheet('Cadastros');

  var currentHeaders = sheet.getLastRow() > 0 ? sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0] : [];
  if (JSON.stringify(currentHeaders) !== JSON.stringify(HEADERS)) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }

  var lastRow = sheet.getLastRow();
  var rowFound = -1;
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === data.id) { rowFound = i + 2; break; }
    }
  }

  if (data.action === 'delete') {
    var infoDel = getGestorInfo(data.password);
    if (!infoDel) return authErrorOut(data.password);
    if (rowFound > -1) {
      var deletedRow = sheet.getRange(rowFound, 1, 1, HEADERS.length).getValues()[0];
      if (infoDel.papel === 'Técnico' && infoDel.abrigo && (deletedRow[ADMIN_COL.abrigo] || '') !== infoDel.abrigo) {
        return jsonOut({ error: 'Você só pode excluir cadastros do seu abrigo.' });
      }
      logHistorico(infoDel.nome, data.id, deletedRow[2], [{ campo: 'Exclusão', alteracao: 'Cadastro excluído definitivamente' }]);
      sheet.deleteRow(rowFound);
    }
    return jsonOut({ status: 'ok' });
  }

  // Todo cadastro/edição exige um PIN válido — sem isso, qualquer POST direto
  // pra essa URL (ela não é secreta, aparece no código-fonte do cliente)
  // conseguiria criar ou sobrescrever cadastros sem autenticação nenhuma.
  if (!checkPassword(data.password)) {
    return authErrorOut(data.password);
  }

  var existing = rowFound > -1 ? sheet.getRange(rowFound, 1, 1, HEADERS.length).getValues()[0] : null;

  if (data.password) {
    var infoUpsert = getGestorInfo(data.password);
    if (infoUpsert && infoUpsert.papel === 'Técnico' && infoUpsert.abrigo && existing) {
      var abrigoExistente = existing[ADMIN_COL.abrigo] || '';
      var situacaoExistente = existing[10] || '';
      var podeEditar = abrigoExistente === infoUpsert.abrigo || (situacaoExistente === SITUACOES[0] && !abrigoExistente);
      if (!podeEditar) {
        return jsonOut({ error: 'Você só pode editar cadastros do seu abrigo.' });
      }
    }
  }

  function adminValue(field){
    if (data.hasOwnProperty(field)) return data[field] || '';
    if (existing) return existing[ADMIN_COL[field]] || '';
    return '';
  }

  var rowValues = [
    data.id, new Date(), data.responsavel || '', data.cpf || '', data.endereco || '',
    data.gpsLat || '', data.gpsLng || '',
    data.bairro || '', data.integrantes || '', data.nomesIntegrantes || '',
    data.situacao || '', data.observacoes || '',
    data.profissionalNome || '', data.profissionalCpf || '',
    data.status || '', data.motivoCancelamento || '',
    adminValue('abrigo'), adminValue('idAbrigo'), adminValue('pessoasAlimentacao'),
    adminValue('dataSaidaAbrigo'), adminValue('obsAbrigo'), adminValue('composicaoEtaria'),
    data.contato || ''
  ];

  var gestorNomeLog = data.password ? checkPassword(data.password) : null;
  if (gestorNomeLog) {
    var changes = [];
    if (!existing) {
      changes.push({ campo: 'Cadastro', alteracao: 'Família criada pelo gestor' });
    } else {
      HEADERS.forEach(function(h, idx) {
        if (h === 'ID' || h === 'Data/Hora') return;
        var antes = String(existing[idx] || '');
        var depois = String(rowValues[idx] || '');
        if (antes !== depois) {
          changes.push({ campo: h, alteracao: (antes || '(vazio)') + ' → ' + (depois || '(vazio)') });
        }
      });
    }
    if (changes.length > 0) {
      logHistorico(gestorNomeLog, data.id, data.responsavel || (existing ? existing[2] : ''), changes);
    }
  }

  // Trava toda a linha (menos a Data/Hora) como texto puro ANTES de escrever.
  // Isso evita duas coisas: (1) o Sheets "interpretar" CPF/coordenadas
  // conforme o idioma da planilha, embaralhando o valor silenciosamente —
  // era isso que quebrava o "Ver no mapa" salvo pelo gestor; e (2) qualquer
  // campo de texto livre (nome, endereço, observações...) virar fórmula
  // executável se alguém digitar algo começando com =, +, - ou @.
  var targetRow = rowFound > -1 ? rowFound : sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1, 1, 1).setNumberFormat('@');
  sheet.getRange(targetRow, 3, 1, HEADERS.length - 2).setNumberFormat('@');
  sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  return jsonOut({ status: 'ok' });
}
