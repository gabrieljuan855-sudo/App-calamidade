// ---- Login unificado: todo mundo (profissional, técnico, master) tem PIN
// próprio, guardado na aba "Gestores" da própria planilha. Dá pra gerenciar
// quem tem acesso direto pelo app, por quem for "master". Na primeira vez
// que o script rodar, essa aba é criada sozinha com o PIN abaixo como
// fundador/master.
var PIN_FUNDADOR_INICIAL = '209491';
var NOME_FUNDADOR_INICIAL = 'Gabriel';

var HEADERS = ['ID','Data/Hora','Responsável familiar','CPF','Endereço','Latitude','Longitude','Bairro','Integrantes','Nomes dos integrantes','Situação','Observações','Profissional responsável','CPF do profissional','Status','Motivo do cancelamento','Abrigo','ID no abrigo','Pessoas que se alimentam','Data de saída do abrigo','Observações do abrigo','Composição etária'];
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
    sheet.appendRow([PIN_FUNDADOR_INICIAL, NOME_FUNDADOR_INICIAL, '', 'Master', true, '']);
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

function getGestores() {
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

function getGestorInfo(pwd) {
  return getGestores().filter(function(g) { return g.pin === String(pwd); })[0] || null;
}

function checkPassword(pwd) {
  var info = getGestorInfo(pwd);
  return info ? info.nome : null;
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

function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  if (data.action === 'checkDuplicate') {
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
    if (!infoLogin) return jsonOut({ error: 'PIN inválido.' });
    return jsonOut({ nome: infoLogin.nome, cpf: infoLogin.cpf, papel: infoLogin.papel, master: infoLogin.master, fundador: infoLogin.fundador, abrigo: infoLogin.abrigo });
  }

  if (data.action === 'gestorData') {
    var info = getGestorInfo(data.password);
    if (!info) {
      return jsonOut({ error: 'não autorizado' });
    }
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
    if (!infoL || !infoL.master) return jsonOut({ error: 'não autorizado' });
    var lista = getGestores().map(function(g){ return { pin: g.pin, nome: g.nome, cpf: g.cpf, papel: g.papel, master: g.master, fundador: g.fundador, abrigo: g.abrigo }; });
    return jsonOut({ gestores: lista });
  }

  if (data.action === 'addGestor') {
    var infoA = getGestorInfo(data.password);
    if (!infoA || !infoA.master) return jsonOut({ error: 'não autorizado' });
    var novoPin = String(data.novoPin || '').trim();
    var novoNome = String(data.novoNome || '').trim();
    var novoCpf = String(data.novoCpf || '').trim();
    if (!novoPin || !novoNome) return jsonOut({ error: 'PIN e nome são obrigatórios.' });
    if (getGestores().some(function(g){ return g.pin === novoPin; })) {
      return jsonOut({ error: 'Já existe um acesso com esse PIN.' });
    }
    var papelPedido = String(data.papel || 'Profissional');
    var papelFinal = papelPedido === 'Master' && !infoA.fundador ? 'Técnico' : papelPedido;
    var novoAbrigo = papelFinal === 'Técnico' ? String(data.abrigo || '') : '';
    getGestoresSheet().appendRow([novoPin, novoNome, novoCpf, papelFinal, false, novoAbrigo]);
    logHistorico(infoA.nome, '', '', [{ campo: 'Acesso', alteracao: 'PIN adicionado para ' + novoNome + ' (' + papelFinal + (novoAbrigo ? ' — ' + novoAbrigo : '') + ')' }]);
    return jsonOut({ status: 'ok' });
  }

  if (data.action === 'editGestor') {
    var infoE = getGestorInfo(data.password);
    if (!infoE || !infoE.master) return jsonOut({ error: 'não autorizado' });
    var pinAlvo = String(data.pinAlvo || '').trim();
    var gestoresEdit = getGestores();
    var alvoEdit = gestoresEdit.filter(function(g){ return g.pin === pinAlvo; })[0];
    if (!alvoEdit) return jsonOut({ error: 'PIN não encontrado.' });
    if (alvoEdit.fundador) return jsonOut({ error: 'O acesso fundador não pode ser editado por aqui.' });
    var papelNovo = String(data.papel || alvoEdit.papel);
    if (papelNovo === 'Master' && !infoE.fundador) papelNovo = alvoEdit.papel;
    var abrigoNovo = papelNovo === 'Técnico' ? String(data.abrigo != null ? data.abrigo : alvoEdit.abrigo) : '';
    getGestoresSheet().getRange(alvoEdit.row, 2, 1, 5).setValues([[
      String(data.nome || alvoEdit.nome), String(data.cpf != null ? data.cpf : alvoEdit.cpf), papelNovo, alvoEdit.fundador, abrigoNovo
    ]]);
    logHistorico(infoE.nome, '', '', [{ campo: 'Acesso', alteracao: 'Acesso editado: ' + (data.nome || alvoEdit.nome) }]);
    return jsonOut({ status: 'ok' });
  }

  if (data.action === 'removeGestor') {
    var infoR = getGestorInfo(data.password);
    if (!infoR || !infoR.master) return jsonOut({ error: 'não autorizado' });
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
    getGestoresSheet().deleteRow(alvo.row);
    logHistorico(infoR.nome, '', '', [{ campo: 'Acesso', alteracao: 'PIN removido: ' + alvo.nome }]);
    return jsonOut({ status: 'ok' });
  }

  if (data.action === 'archiveEvent') {
    var gestorNomeArq = checkPassword(data.password);
    if (!gestorNomeArq) {
      return jsonOut({ error: 'não autorizado' });
    }
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
  }

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
    if (!infoDel) {
      return jsonOut({ error: 'não autorizado' });
    }
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
    return jsonOut({ error: 'não autorizado' });
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
    adminValue('dataSaidaAbrigo'), adminValue('obsAbrigo'), adminValue('composicaoEtaria')
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
