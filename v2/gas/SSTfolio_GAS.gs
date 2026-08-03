// SSTfolio v2.0 - 가격 KV 단일 작성자(Python) 구조
// ============================================================
// 주식 포트폴리오 관리 시스템 — Google Apps Script v5
// ============================================================
// 투자현황:  A=account_id B=ticker C=name D=market E=sector F=quantity G=avg_price H=asset_region I=current_value(펀드용)
// 현재가:    A=ticker B=market C=name D=price E=change_rate F=updated_at
// KRX종목코드온라인: A=종목명 B=종목코드 C=시장구분 (매일 6시 자동갱신)
// ============================================================

// SSTfolio v2: 독립 GAS 프로젝트에서는 Script Property SPREADSHEET_ID를 사용한다.
// 테스트용 bound script에서는 SPREADSHEET_ID가 없을 때 현재 시트를 사용한다.
function getSpreadsheet_() {
  var id = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '').trim();
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (!active) throw new Error('SPREADSHEET_ID Script Property가 필요합니다.');
  return active;
}

const SS = getSpreadsheet_();

// v2 연결값은 Script Properties를 우선 사용한다. 기존 config 시트 값은 마이그레이션 호환용 fallback이다.
function getV2ConnectionConfig_() {
  var props = PropertiesService.getScriptProperties();
  var cfg = {};
  try { cfg = getConfig() || {}; } catch(e) {}
  return {
    workerUrl: String(props.getProperty('WORKER_URL') || cfg.SSTFOLIO_WORKER_URL || '').trim().replace(/\/$/, ''),
    secret: String(props.getProperty('SSTFOLIO_SECRET') || cfg.SSTFOLIO_SECRET || '').trim()
  };
}

const SHEET = {
  ACCOUNTS:       '계좌',
  HOLDINGS:       '투자현황',
  PRICES:         '현재가',
  CONFIG:         'config',
  TICKER_MASTER:  '종목코드',
  KRX_ONLINE:     'KRX종목코드온라인',
  SNAPSHOT:       '스냅샷',
  DIVIDEND:       '배당내역',
  SALE:           '실현수익',
  CASHFLOW:       '입출금',
  EXTERNAL_ASSET: '외부자산',
};

// ============================================================
// 1. 웹앱 진입점
// ============================================================
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'portfolio';
  const q      = (e && e.parameter && e.parameter.q)      || '';
  let result;
  try {
    switch (action) {
      case 'accounts':      result = getAccounts();     break;
      case 'holdings':      result = getHoldings();     break;
      case 'prices':        result = getPricesData();   break;
      case 'config':        result = getConfig();       break;
      case 'ticker_master': result = getTickerMaster(); break;
      case 'portfolio':     result = getPortfolio();    break;
      case 'plan':           result = getPlan();          break;
      case 'search_ticker': result = searchTicker(q);   break;
      case 'snapshot':      result = getSnapshot(e);    break;
      case 'dividend':      result = getDividend(e);    break;
      case 'sale':          result = getSale(e);        break;
      case 'cashflow':      result = getCashflow(e);    break;
      case 'external_asset': result = getExternalAsset(e); break;
      case 'trigger_actions':
        var requestedMode = (e.parameter && e.parameter.mode) || '';
        if (!requestedMode) {
          requestedMode = (e.parameter && e.parameter.force === 'true') ? 'emergency_full' : 'auto';
        }
        result = triggerGithubActions(requestedMode);
        break;
      default:              result = getPortfolio();
    }
  } catch (err) {
    result = { error: err.message };
  }
  return jsonOut(result);
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); }
  catch(err) { return jsonOut({ error: '잘못된 JSON' }); }
  let result;
  try {
    switch (data.action) {
      case 'add_holding':    result = addHolding(data);    break;
      case 'update_holding': result = updateHolding(data); break;
      case 'delete_holding': result = deleteHolding(data); break;
      case 'add_account':          result = addAccount(data);             break;
      case 'save_account_group':   result = saveAccountGroup(data);       break;
      case 'delete_account_group': result = deleteAccountGroup(data);     break;
      case 'save_snapshot':         result = saveSnapshot();               break;
      case 'add_plan':              result = addPlan(data);                break;
      case 'update_plan':           result = updatePlan(data);             break;
      case 'update_plan_monthly':   result = updatePlanMonthly(data);      break;
      case 'update_plan_active':    result = updatePlanActive(data);       break;
      case 'delete_plan':           result = deletePlan(data);             break;
      case 'add_dividend':          result = addDividend(data);            break;
      case 'delete_dividend':       result = deleteDividend(data);         break;
      case 'add_sale':              result = addSale(data);                break;
      case 'update_sale':           result = updateSale(data);             break;
      case 'delete_sale':           result = deleteSale(data);             break;
      case 'add_cashflow':          result = addCashflow(data);            break;
      case 'delete_cashflow':       result = deleteCashflow(data);         break;
      case 'update_cashflow':       result = updateCashflow(data);         break;
      case 'add_external_asset':    result = addExternalAsset(data);       break;
      case 'delete_external_asset': result = deleteExternalAsset(data);    break;
      case 'update_external_asset': result = updateExternalAsset(data);    break;
      default: result = { error: 'Unknown action: ' + data.action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return jsonOut(result);
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 2. 데이터 읽기
// ============================================================
function sheetToJson(sheetName) {
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) return [];
  // 투자현황은 current_value(I=9열)까지 반드시 포함
  const isHoldings = (sheetName === SHEET.HOLDINGS);
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), isHoldings ? 9 : 1);
  if (lastRow < 2) return [];
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(function(h) { return String(h).trim(); });
  return data.slice(1)
    .map(function(r, idx) {
      const obj = {};
      headers.forEach(function(h, i) { if (h) obj[h] = r[i] !== undefined ? r[i] : ''; });
      if (isHoldings) obj['id'] = String(idx + 1);
      return obj;
    })
    .filter(function(obj) {
      if (isHoldings) {
        // ticker 또는 name 중 하나라도 있으면 포함 (펀드 등 ticker 없는 상품 지원)
        var tickerVal = String(obj['ticker'] || '').trim();
        var nameVal   = String(obj['name']   || '').trim();
        return tickerVal.length > 0 || nameVal.length > 0;
      }
      const val = Object.values(obj)[0];
      return val !== '' && val !== null && val !== undefined;
    });
}

function getAccounts()     { return sheetToJson(SHEET.ACCOUNTS); }
function getHoldings() {
  // 투자현황 시트에 current_value 컬럼(I=9열) 없으면 자동 추가
  var sheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (sheet) {
    var lastCol = sheet.getLastColumn();
    var headerRange = sheet.getRange(1, 1, 1, Math.max(lastCol, 9));
    var headers = headerRange.getValues()[0].map(function(h) { return String(h).trim().toLowerCase(); });
    if (headers.indexOf('current_value') === -1) {
      // I열(9번째)에 헤더 추가
      sheet.getRange(1, 9).setValue('current_value');
      sheet.getRange(1, 9).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setColumnWidth(9, 130);
      Logger.log('투자현황 I열 current_value 컬럼 추가');
    }
  }
  return sheetToJson(SHEET.HOLDINGS);
}
function getPricesData()   { return sheetToJson(SHEET.PRICES); }
function getTickerMaster() { return sheetToJson(SHEET.TICKER_MASTER); }

function getConfig() {
  const cfg = {};
  sheetToJson(SHEET.CONFIG).forEach(function(r) { cfg[r.key] = r.value; });
  return cfg;
}

// 현재가 시트를 Map으로 반환: { '005930': { price, change_rate, name } }
// 헤더: A=ticker B=market C=name D=price E=change_rate F=updated_at
function buildPriceMap() {
  const map   = {};
  const sheet = SS.getSheetByName(SHEET.PRICES);
  if (!sheet) return map;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return map;
  const header = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  // 컬럼 인덱스 동적 탐색
  const iPrice  = header.indexOf('price');
  const iRate   = header.indexOf('change_rate');
  const iName   = header.indexOf('name');
  const iUpd    = header.indexOf('updated_at');
  if (iPrice < 0) return map;
  for (var i = 1; i < data.length; i++) {
    const ticker = normalizeTicker(String(data[i][0] || '').trim(), String(data[i][1] || '').trim());
    if (!ticker) continue;
    map[ticker] = {
      price:       parseFloat(String(data[i][iPrice] || '0').replace(/[^0-9.]/g, '')) || 0,
      change_rate: iRate >= 0 ? String(data[i][iRate] || '') : '',
      name:        iName >= 0 ? String(data[i][iName] || '') : '',
      updated_at:  iUpd  >= 0 ? String(data[i][iUpd]  || '') : '',
    };
  }
  return map;
}

// ============================================================
// 3. 통합 포트폴리오
// ============================================================
function getPortfolio() {
  const accounts = getAccounts();
  const holdings = getHoldings();
  const config   = getConfig();
  const masters  = getTickerMaster();
  const priceMap = buildPriceMap();   // 헤더 기반으로 안전하게 읽기

  const masterMap = {};
  masters.forEach(function(m) { masterMap[normalizeTicker(String(m.ticker).trim(), String(m.market || 'KR').trim())] = m; });

  const accountMap = {};
  accounts.forEach(function(a) { accountMap[String(a.account_id)] = a; });

  const usdKrw = parseFloat(config.USD_KRW) || 1450;

  const enriched = holdings.map(function(h) {
    const ticker = normalizeTicker(String(h.ticker || '').trim(), String(h.market || 'KR').trim());
    const p      = priceMap[ticker]  || {};
    const m      = masterMap[ticker] || {};

    const rawAcctId = String(h.account_id || '');
    const acctId    = rawAcctId.includes('id=')
      ? (rawAcctId.match(/id=(\d+)/) || [])[1] || rawAcctId
      : rawAcctId;
    const account = accountMap[acctId] || {};

    const market       = (h.market || m.market || 'KR').toUpperCase();
    const assetRegion  = (h.asset_region || market).toUpperCase();
    const currentPrice = p.price || 0;
    const changeRate   = p.change_rate || '';
    const avgPrice     = parseFloat(String(h.avg_price || 0).replace(/,/g, '')) || 0;
    const quantity     = parseFloat(h.quantity) || 0;

    // ticker 없는 펀드 여부 (ticker가 비어있고 name이 있는 경우)
    const isFund = String(h.ticker || '').trim().length === 0 && String(h.name || '').trim().length > 0;

    // 펀드용 현재평가액 (I열 current_value, 수동 입력)
    const currentValue = parseFloat(String(h.current_value || '').replace(/[^0-9.-]/g, '')) || 0;

    // 예수금 처리
    const isCash = ticker === 'CASH_KR' || ticker === 'CASH_US'
                || String(h.name || '').trim() === '예수금';

    var evalAmt, costAmt, profitAmt, profitPct;
    if (isCash) {
      const cashKrw = market === 'US' ? avgPrice * quantity * usdKrw : avgPrice * quantity;
      evalAmt = Math.round(cashKrw);
      costAmt = Math.round(cashKrw);
      profitAmt = 0;
      profitPct = 0;
    } else if (isFund) {
      // ticker 없는 펀드: current_value(현재평가액)가 있으면 사용, 없으면 avg_price×quantity
      costAmt   = Math.round(avgPrice * quantity);
      evalAmt   = currentValue > 0 ? Math.round(currentValue) : costAmt;
      profitAmt = evalAmt - costAmt;
      profitPct = costAmt > 0 ? (profitAmt / costAmt) * 100 : 0;
    } else {
      const priceKrw = market === 'US' ? currentPrice * usdKrw : currentPrice;
      const avgKrw   = market === 'US' ? avgPrice * usdKrw     : avgPrice;
      evalAmt   = Math.round(priceKrw * quantity);
      costAmt   = Math.round(avgKrw   * quantity);
      profitAmt = evalAmt - costAmt;
      profitPct = costAmt > 0 ? (profitAmt / costAmt) * 100 : 0;
    }

    return {
      id:            String(h.id),
      account_id:    acctId,
      ticker:        isFund ? (String(h.name || '').trim().slice(0, 20) || '펀드') : ticker,
      name:          String(h.name || '').trim() || m.name || ticker,
      market:        market,
      asset_region:  assetRegion,
      sector:        h.sector || m.sector || '기타',
      quantity:      quantity,
      avg_price:     avgPrice,
      current_price: (isCash || isFund) ? 0 : currentPrice,
      change_rate:   (isCash || isFund) ? '' : changeRate,
      change_amount: (function() {
        if (isCash || isFund || !changeRate) return 0;
        var pct = parseFloat(String(changeRate).replace('%',''));
        if (isNaN(pct)) return 0;
        return Math.round(currentPrice * quantity * pct / 100);
      })(),
      is_cash:       isCash,
      is_fund:       isFund,
      current_value: isFund ? (currentValue > 0 ? currentValue : 0) : 0,
      eval_amount:   evalAmt,
      cost_amount:   costAmt,
      profit_amount: Math.round(profitAmt),
      profit_pct:    Math.round(profitPct * 10) / 10,
      usd_krw:       usdKrw,
      price_updated: isCash ? '' : (p.updated_at || '미조회'),
      exchange:      market === 'KR' ? 'KR' : (m.exchange || 'NASDAQ'),
      owner:         String(account.owner        || ''),
      broker:        String(account.broker       || ''),
      account_type:  String(account.account_type || ''),
    };
  });

  // config에서 ACCOUNT_GROUP_ 접두어 항목 추출
  // 저장 형식: "accountId1|소유자·broker type,accountId2|소유자·broker type,..."
  const accountGroups = [];
  Object.keys(config).forEach(function(key) {
    if (key.indexOf('ACCOUNT_GROUP_') === 0) {
      const groupName    = key.replace('ACCOUNT_GROUP_', '');
      const entries      = String(config[key]).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      const accountIds   = [];
      const displayLabels = [];
      entries.forEach(function(entry) {
        const sep = entry.indexOf('|');
        if (sep > -1) {
          accountIds.push(entry.substring(0, sep).trim());
          displayLabels.push(entry.substring(sep + 1).trim());
        } else {
          // 구형 형식(label만) 호환
          displayLabels.push(entry);
        }
      });
      accountGroups.push({ name: groupName, accountIds: accountIds, displayLabels: displayLabels });
    }
  });

  return {
    accounts:      accounts,
    holdings:      enriched,
    config:        config,
    accountGroups: accountGroups,
    generated_at:  new Date().toISOString(),
    prices:        (function() {
      // 현재가 시트 전체를 배열로 변환 (완전매도 종목 현재가 조회용)
      var arr = [];
      Object.keys(priceMap).forEach(function(ticker) {
        var p = priceMap[ticker];
        arr.push({
          ticker:      ticker,
          price:       p.price,
          change_rate: p.change_rate,
          name:        p.name,
        });
      });
      return arr;
    })(),
  };
}

// ============================================================
// 배당 내역 관리
// ============================================================

// ============================================================
// 적립 관리 (적립계획 시트)
// ============================================================
// 적립계획 시트 구조: A=id B=ticker C=name D=account_id E=account_name F=market G=target H=memo I=active J~=YYYY-MM 컬럼

var PLAN_SHEET = '적립계획';

function getPlanSheet() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(PLAN_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PLAN_SHEET);
    var headers = ['id','ticker','name','account_id','account_name','market','target','memo','active'];
    sheet.appendRow(headers);
    sheet.getRange(1,1,1,headers.length).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  }
  return sheet;
}

function getPlan() {
  var sheet = getPlanSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows: [] };

  // 헤더를 YYYY-MM 문자열로 정규화
  var headers = data[0].map(function(v) {
    if (!v && v !== 0) return '';
    if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth()+1).padStart(2,'0');
    return String(v).trim();
  });

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = {};
    headers.forEach(function(h, j) { if (h) obj[h] = row[j]; });
    if (!obj.id) continue;

    // ticker KR 종목 6자리 패딩
    var ticker = String(obj.ticker || '').trim();
    var market = String(obj.market || 'KR').toUpperCase();
    if (market === 'KR' && /^\d+$/.test(ticker) && ticker.length < 6) {
      ticker = ticker.padStart(6, '0');
    }

    var monthly = {};
    for (var j = 0; j < headers.length; j++) {
      var h = headers[j];
      if (/^\d{4}-\d{2}$/.test(h)) {
        var v = Number(row[j] || 0);
        if (v > 0) monthly[h] = v;
      }
    }
    rows.push({
      id:           String(obj.id),
      ticker:       ticker,
      name:         String(obj.name   || ''),
      account_id:   String(obj.account_id || ''),
      account_name: String(obj.account_name || ''),
      market:       market,
      target:       Number(obj.target || 0),
      memo:         String(obj.memo   || ''),
      active:       String(obj.active || 'Y') !== 'N',
      monthly:      monthly,
    });
  }
  return { rows: rows };
}

function addPlan(data) {
  var sheet   = getPlanSheet();
  var id      = 'plan_' + new Date().getTime();
  var market  = String(data.market || 'KR').toUpperCase();
  // ticker 정규화: KR 숫자 종목 6자리 패딩, US는 대문자
  var ticker  = normalizeTicker(String(data.ticker || '').trim(), market);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row     = [id, ticker, data.name||'', data.account_id||'', data.account_name||'',
                 market, Number(data.target||0), data.memo||'', 'Y'];
  // 헤더 개수만큼 빈 값 채우기
  while (row.length < headers.length) row.push('');
  // B열(ticker)을 텍스트 서식으로 저장 (숫자 자동변환 방지)
  sheet.appendRow(row);
  var newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@').setValue(ticker);
  return { success: true, id: id };
}

function updatePlan(data) {
  var sheet   = getPlanSheet();
  var vals    = sheet.getDataRange().getValues();
  var headers = vals[0].map(function(h) { return String(h).trim(); });
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(data.id)) {
      var r = i + 1;
      var ti = headers.indexOf('target');
      var mi = headers.indexOf('memo');
      if (ti >= 0) sheet.getRange(r, ti+1).setValue(Number(data.target||0));
      if (mi >= 0) sheet.getRange(r, mi+1).setValue(data.memo||'');
      return { success: true };
    }
  }
  return { error: '항목을 찾을 수 없습니다' };
}

function updatePlanMonthly(data) {
  var sheet  = getPlanSheet();
  var month  = String(data.month || ''); // 'YYYY-MM' 형식

  // 헤더를 YYYY-MM 문자열로 정규화해서 읽기
  var lastCol    = sheet.getLastColumn();
  var headerVals = sheet.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0];
  var headers    = headerVals.map(function(v) {
    if (!v && v !== 0) return '';
    if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth()+1).padStart(2,'0');
    return String(v).trim();
  });

  var colIdx = headers.indexOf(month);
  if (colIdx < 0) {
    // 신규 컬럼 추가 — 헤더를 문자열로 명시 저장 (날짜 자동변환 방지)
    colIdx = sheet.getLastColumn(); // 0-indexed
    var newCell = sheet.getRange(1, colIdx + 1);
    newCell.setNumberFormat('@');   // 텍스트 서식으로 강제
    newCell.setValue(month);
    newCell.setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  }

  // id로 행 찾기
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: '데이터 없음' };
  var idVals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < idVals.length; i++) {
    if (String(idVals[i][0]) === String(data.id)) {
      sheet.getRange(i + 2, colIdx + 1).setValue(Number(data.amount || 0));
      return { success: true };
    }
  }
  return { error: '항목을 찾을 수 없습니다' };
}

function updatePlanActive(data) {
  var sheet   = getPlanSheet();
  var vals    = sheet.getDataRange().getValues();
  var headers = vals[0].map(function(h) { return String(h).trim(); });
  var ai      = headers.indexOf('active');
  if (ai < 0) return { error: 'active 컬럼 없음' };
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(data.id)) {
      sheet.getRange(i+1, ai+1).setValue(data.active ? 'Y' : 'N');
      return { success: true };
    }
  }
  return { error: '항목을 찾을 수 없습니다' };
}

function deletePlan(data) {
  var sheet = getPlanSheet();
  var vals  = sheet.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]) === String(data.id)) {
      sheet.deleteRow(i+1);
      return { success: true };
    }
  }
  return { error: '항목을 찾을 수 없습니다' };
}

// 적립계획 시트 중복 월 컬럼 정리 (수동 실행용)
// 적립계획 시트 ticker 정규화 (기존 데이터 일괄 수정)
function fixPlanTickers() {
  var sheet   = getPlanSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('데이터 없음'); return; }
  var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  var fixed = 0;
  for (var i = 0; i < data.length; i++) {
    var ticker = String(data[i][1] || '').trim();
    var market = String(data[i][5] || 'KR').toUpperCase();
    var normalized = normalizeTicker(ticker, market);
    if (normalized !== ticker) {
      var cell = sheet.getRange(i + 2, 2);
      cell.setNumberFormat('@');
      cell.setValue(normalized);
      Logger.log('적립계획 ticker 정규화: ' + ticker + ' → ' + normalized);
      fixed++;
    }
  }
  SpreadsheetApp.getUi().alert('✅ ticker 정규화 완료: ' + fixed + '개 수정\n(예: 5387 → 005387)');
}

function cleanupPlanSheet() {
  var sheet   = getPlanSheet();
  var lastCol = sheet.getLastColumn();
  var headerVals = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // 날짜 객체 또는 문자열 모두 YYYY-MM 형식으로 변환
  function toYYYYMM(v) {
    if (!v && v !== 0) return '';
    if (v instanceof Date) {
      return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0');
    }
    var s = String(v).trim();
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    return '';
  }

  var headers = headerVals.map(toYYYYMM);
  var seen = {}, delCols = [];
  for (var i = headers.length - 1; i >= 0; i--) {
    var h = headers[i];
    if (h) {
      if (seen[h] !== undefined) {
        delCols.push(i + 1);
      } else {
        seen[h] = i + 1;
      }
    }
  }

  // 헤더가 날짜 객체면 문자열로 교체
  for (var col in seen) {
    var ci = seen[col] - 1;
    if (headerVals[ci] instanceof Date) {
      sheet.getRange(1, seen[col]).setValue(col);
    }
  }

  // 중복 컬럼 삭제 (뒤에서부터)
  delCols.sort(function(a,b){return b-a;});
  delCols.forEach(function(col) { sheet.deleteColumn(col); });

  SpreadsheetApp.getUi().alert('✅ 정리 완료\n중복 컬럼: ' + delCols.length + '개 삭제\n날짜→문자열 변환: 완료\n\n⚡ 지금 즉시 현재가 갱신을 실행하세요.');
}

function getDividendSheet() {
  var sheet = SS.getSheetByName(SHEET.DIVIDEND);
  if (!sheet) {
    sheet = SS.insertSheet(SHEET.DIVIDEND);
    sheet.appendRow(['id','date','account_id','owner','account_name','ticker','name','amount','memo']);
    sheet.getRange(1,1,1,8).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setColumnWidth(1, 50);
    sheet.setColumnWidth(2, 100);
    sheet.setColumnWidth(3, 80);
    sheet.setColumnWidth(4, 80);
    sheet.setColumnWidth(5, 120);
    sheet.setColumnWidth(6, 100);
    sheet.setColumnWidth(7, 200);
    sheet.setColumnWidth(8, 100);
    sheet.setColumnWidth(9, 150);
  }
  return sheet;
}

function getDividend(e) {
  const params     = (e && e.parameter) || {};
  const fromDate   = params.from || '';
  const toDate     = params.to   || '';
  const accountId  = params.account_id || '';

  const sheet = getDividendSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows: [] };

  const headers = data[0].map(function(h) { return String(h).trim(); });
  const rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    headers.forEach(function(h, j) { row[h] = data[i][j]; });
    var dateStr = row.date ? Utilities.formatDate(new Date(row.date), 'Asia/Seoul', 'yyyy-MM-dd') : '';
    if (fromDate && dateStr < fromDate) continue;
    if (toDate   && dateStr > toDate)   continue;
    if (accountId && String(row.account_id) !== accountId) continue;
    row.date   = dateStr;
    row.amount = Number(row.amount) || 0;
    rows.push(row);
  }
  return { rows: rows };
}

function addDividend(data) {
  if (!data.date || !data.account_id || !data.amount) {
    return { error: '날짜, 계좌, 금액은 필수입니다' };
  }
  const sheet = getDividendSheet();
  const rows  = sheet.getDataRange().getValues();

  // id 자동 생성
  var maxId = 0;
  for (var i = 1; i < rows.length; i++) {
    var id = parseInt(rows[i][0]) || 0;
    if (id > maxId) maxId = id;
  }
  const newId = maxId + 1;

  // 날짜 포맷
  var dateStr = String(data.date || '').trim();

  sheet.appendRow([
    newId,
    dateStr,
    String(data.account_id   || ''),
    String(data.owner        || ''),
    String(data.account_name || ''),
    String(data.ticker       || ''),
    String(data.name         || ''),
    Number(data.amount)      || 0,
    String(data.memo         || ''),
  ]);
  return { ok: true, id: newId };
}

function deleteDividend(data) {
  const targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };

  const sheet = getDividendSheet();
  const rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === targetId) {
      sheet.deleteRow(i + 1);
      return { ok: true, id: targetId };
    }
  }
  return { error: '해당 배당 내역 없음: ' + targetId };
}

// ============================================================
// 실현수익 관리
// ============================================================
// 실현수익 시트 컬럼 (16개):
//   1=id, 2=date, 3=account_id, 4=owner, 5=account_name,
//   6=ticker, 7=name, 8=market, 9=qty,
//   10=sell_price, 11=buy_price, 12=profit, 13=profit_rate,
//   14=memo, 15=holding_snapshot (복원용 JSON), 16=tags

function getSaleSheet() {
  var sheet = SS.getSheetByName(SHEET.SALE);
  if (!sheet) {
    sheet = SS.insertSheet(SHEET.SALE);
    sheet.appendRow([
      'id','date','account_id','owner','account_name',
      'ticker','name','market','qty',
      'sell_price','buy_price','profit','profit_rate','memo','holding_snapshot','tags'
    ]);
    sheet.getRange(1,1,1,16).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
    var widths = [50,100,80,80,130,100,200,60,70,100,100,110,90,160,40,150];
    widths.forEach(function(w,i){sheet.setColumnWidth(i+1,w);});
    sheet.hideColumns(15); // holding_snapshot 숨김
  } else {
    // ── 기존 시트 마이그레이션: 누락된 컬럼 자동 추가 ──────────
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h){ return String(h).trim(); });

    // holding_snapshot 없으면 추가
    if (headers.indexOf('holding_snapshot') === -1) {
      var col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue('holding_snapshot');
      sheet.setColumnWidth(col, 40);
      sheet.hideColumns(col);
      headers.push('holding_snapshot');
    }
    // tags 없으면 추가
    if (headers.indexOf('tags') === -1) {
      var tagCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, tagCol).setValue('tags');
      sheet.setColumnWidth(tagCol, 150);
      // 헤더 스타일 통일
      sheet.getRange(1, tagCol).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
    }
    // 빈 헤더 컬럼 감지 (헤더가 비어있는 중간 컬럼 → tags 저장 오류 방지용 경고 로그)
    headers.forEach(function(h, i) {
      if (!h) Logger.log('[WARN] 실현수익 시트 ' + (i+1) + '열 헤더가 비어있습니다. 수동으로 확인하세요.');
    });
  }
  return sheet;
}

function getSale(e) {
  var params    = (e && e.parameter) || {};
  var fromDate  = params.from || '';
  var toDate    = params.to   || '';
  var accountId = params.account_id || '';

  var sheet = getSaleSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows: [] };

  var headers = data[0].map(function(h){ return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    headers.forEach(function(h,j){ row[h] = data[i][j]; });
    var dateStr = row.date ? Utilities.formatDate(new Date(row.date),'Asia/Seoul','yyyy-MM-dd') : '';
    if (fromDate && dateStr < fromDate) continue;
    if (toDate   && dateStr > toDate)   continue;
    if (accountId && String(row.account_id) !== accountId) continue;
    row.date        = dateStr;
    row.qty         = Number(row.qty)         || 0;
    row.sell_price  = Number(row.sell_price)  || 0;
    row.buy_price   = Number(row.buy_price)   || 0;
    row.profit      = Number(row.profit)      || 0;
    row.profit_rate = Number(row.profit_rate) || 0;
    // holding_snapshot은 프론트에 전달 (수정 모달에서 활용)
    row.holding_snapshot = row.holding_snapshot ? String(row.holding_snapshot) : '';
    // tags: 쉼표 구분 문자열 → 배열로 변환
    var rawTags = String(row.tags || '').trim();
    row.tags = rawTags ? rawTags.split(',').map(function(t){ return t.trim(); }).filter(Boolean) : [];
    rows.push(row);
  }
  return { rows: rows };
}

// ── 투자현황에서 account_id + ticker 매칭 행 찾기 ───────────
// 반환: { rowIndex(1-based 시트행), rowData(배열) } or null
function findHoldingRow(accountId, ticker) {
  var sheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  var targetAcctId = String(accountId).trim();
  // 검색 ticker도 normalizeTicker 적용 (대소문자·패딩 통일)
  // market을 모르므로 일단 KR로 시도, 안되면 raw 비교
  var targetTicker = String(ticker).trim().toUpperCase();

  for (var i = 1; i < values.length; i++) {
    // A열: "본인 · 미래에셋 ISA (id=2)" 형태에서 숫자 id 추출
    var rawAcctId  = String(values[i][0]).trim();
    var cellAcctId = rawAcctId;
    if (rawAcctId.indexOf('id=') !== -1) {
      var m = rawAcctId.match(/id=(\d+)/);
      if (m) cellAcctId = m[1];
    }
    // B열 ticker도 normalizeTicker와 동일하게 대문자 변환
    var cellTicker = String(values[i][1]).trim().toUpperCase();
    // KR 숫자 ticker는 6자리 패딩
    if (/^\d+$/.test(cellTicker) && cellTicker.length < 6) {
      cellTicker = cellTicker.padStart(6, '0');
    }

    if (cellAcctId === targetAcctId && cellTicker === targetTicker) {
      return { rowIndex: i + 1, rowData: values[i] };
    }
  }
  return null;
}

// ── 투자현황 행 복원 (holding_snapshot JSON → 시트에 추가) ──
function restoreHoldingFromSnapshot(snapshotJson) {
  if (!snapshotJson) return { error: '스냅샷 없음' };
  var snap;
  try { snap = JSON.parse(snapshotJson); } catch(e) { return { error: '스냅샷 파싱 실패' }; }
  // 이미 해당 행이 존재하면 복원 불필요
  var existing = findHoldingRow(snap.account_id, snap.ticker);
  if (existing) {
    // 이미 있으면 수량만 업데이트
    SS.getSheetByName(SHEET.HOLDINGS).getRange(existing.rowIndex, 6).setValue(snap.quantity);
    return { ok: true, restored: false, updated: true };
  }
  // 행 복원: A=account_id, B=ticker, C=name, D=market, E=sector, F=quantity, G=avg_price, H=asset_region
  var sheet = SS.getSheetByName(SHEET.HOLDINGS);
  sheet.appendRow([
    snap.account_id,
    snap.ticker,
    snap.name,
    snap.market,
    snap.sector,
    snap.quantity,
    snap.avg_price,
    snap.asset_region,
  ]);
  return { ok: true, restored: true };
}

function addSale(data) {
  if (!data.date || !data.account_id || !data.profit) {
    return { error: '날짜, 계좌, 실현수익금은 필수입니다' };
  }

  var saleQty = Number(data.qty) || 0;
  var snapshotJson = '';

  // ── 투자현황 수량 차감 (qty 입력된 경우만, skip_holding 아닌 경우만) ──
  if (saleQty > 0 && data.ticker && !data.skip_holding) {
    var found = findHoldingRow(data.account_id, data.ticker);
    if (!found) {
      return { error: '투자현황에서 해당 종목을 찾을 수 없습니다: ' + data.ticker + ' (계좌 ' + data.account_id + ')' };
    }
    var rowData    = found.rowData;
    var currentQty = parseFloat(rowData[5]) || 0; // F열 = index 5
    if (saleQty > currentQty) {
      return { error: '매도 수량(' + saleQty + ')이 보유 수량(' + currentQty + ')을 초과합니다' };
    }

    // 복원용 스냅샷 저장 (매도 전 원본 상태)
    var snap = {
      account_id:   String(rowData[0]),
      ticker:       String(rowData[1]),
      name:         String(rowData[2]),
      market:       String(rowData[3]),
      sector:       String(rowData[4]),
      quantity:     currentQty,          // 매도 전 원본 수량
      avg_price:    parseFloat(rowData[6]) || 0,
      asset_region: String(rowData[7] || ''),
    };
    snapshotJson = JSON.stringify(snap);

    var remaining = currentQty - saleQty;
    var hSheet = SS.getSheetByName(SHEET.HOLDINGS);
    if (remaining === 0) {
      // 완전매도 → 행 삭제
      hSheet.deleteRow(found.rowIndex);
    } else {
      // 부분매도 → 수량 차감
      hSheet.getRange(found.rowIndex, 6).setValue(remaining);
    }
  }

  // ── 실현수익 시트에 기록 ────────────────────────────────────
  var sheet = getSaleSheet();
  var rows  = sheet.getDataRange().getValues();
  var maxId = 0;
  for (var i = 1; i < rows.length; i++) {
    var id = parseInt(rows[i][0]) || 0;
    if (id > maxId) maxId = id;
  }
  var newId = maxId + 1;

  // 헤더 기반으로 컬럼 위치를 찾아 쓰기 (빈 컬럼이 중간에 있어도 안전)
  var headers = rows[0].map(function(h){ return String(h).trim(); });
  var totalCols = headers.length;
  var newRow = new Array(totalCols).fill('');
  var colMap = {
    'id':               newId,
    'date':             String(data.date          || ''),
    'account_id':       String(data.account_id    || ''),
    'owner':            String(data.owner         || ''),
    'account_name':     String(data.account_name  || ''),
    'ticker':           String(data.ticker        || ''),
    'name':             String(data.name          || ''),
    'market':           String(data.market        || 'KR'),
    'qty':              saleQty,
    'sell_price':       Number(data.sell_price)   || 0,
    'buy_price':        Number(data.buy_price)    || 0,
    'profit':           Number(data.profit)       || 0,
    'profit_rate':      Number(data.profit_rate)  || 0,
    'memo':             String(data.memo          || ''),
    'holding_snapshot': snapshotJson,
    'tags':             String((data.tags || []).join(',') || ''),
  };
  headers.forEach(function(h, i) {
    if (h && colMap.hasOwnProperty(h)) newRow[i] = colMap[h];
  });
  sheet.appendRow(newRow);
  return { ok: true, id: newId };
}

// ── 매도 내역 수정 ───────────────────────────────────────────
function updateSale(data) {
  var targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };

  var sheet    = getSaleSheet();
  var allRows  = sheet.getDataRange().getValues();
  var headers  = allRows[0].map(function(h){ return String(h).trim(); });

  var targetRowIdx = -1;
  var oldRow = {};
  for (var i = 1; i < allRows.length; i++) {
    if (String(allRows[i][0]).trim() === targetId) {
      targetRowIdx = i + 1; // 1-based 시트 행
      headers.forEach(function(h, j){ oldRow[h] = allRows[i][j]; });
      break;
    }
  }
  if (targetRowIdx < 0) return { error: '해당 실현수익 내역 없음: ' + targetId };

  var oldQty      = Number(oldRow.qty)      || 0;
  var newQty      = Number(data.qty)        || 0;
  var oldSnapshot = String(oldRow.holding_snapshot || '');
  var deltaQty    = newQty - oldQty; // 양수=추가매도, 음수=매도 줄임

  // ── 투자현황 수량 재조정 (skip_holding 아닌 경우만) ────────
  if (data.ticker && (oldQty > 0 || newQty > 0) && !data.skip_holding) {
    var found = findHoldingRow(data.account_id || String(oldRow.account_id), data.ticker);

    if (deltaQty > 0) {
      // 매도 수량 증가 → 투자현황에서 추가 차감
      if (!found) {
        return { error: '투자현황에서 해당 종목을 찾을 수 없습니다 (추가 차감 불가)' };
      }
      var curQty = parseFloat(found.rowData[5]) || 0;
      if (deltaQty > curQty) {
        return { error: '추가 매도 수량(' + deltaQty + ')이 잔여 보유 수량(' + curQty + ')을 초과합니다' };
      }
      var newRemain = curQty - deltaQty;
      var hSheet2 = SS.getSheetByName(SHEET.HOLDINGS);
      if (newRemain === 0) {
        hSheet2.deleteRow(found.rowIndex);
      } else {
        hSheet2.getRange(found.rowIndex, 6).setValue(newRemain);
      }

    } else if (deltaQty < 0) {
      // 매도 수량 감소 → 투자현황에 수량 반환
      var returnQty = -deltaQty;
      if (found) {
        // 아직 보유 중 → 수량 추가
        var hSheet3 = SS.getSheetByName(SHEET.HOLDINGS);
        var presentQty = parseFloat(found.rowData[5]) || 0;
        hSheet3.getRange(found.rowIndex, 6).setValue(presentQty + returnQty);
      } else {
        // 완전매도로 행이 삭제된 상태 → 스냅샷으로 복원 후 수량 설정
        if (!oldSnapshot) return { error: '투자현황 행이 없고 복원 스냅샷도 없습니다' };
        var snap2;
        try { snap2 = JSON.parse(oldSnapshot); } catch(e) { return { error: '스냅샷 파싱 실패' }; }
        snap2.quantity = returnQty; // 반환할 수량으로 복원
        var restoreResult = restoreHoldingFromSnapshot(JSON.stringify(snap2));
        if (restoreResult.error) return restoreResult;
      }
    }
    // deltaQty === 0 이면 투자현황 변경 없음
  }

  // ── 실현수익 시트 행 업데이트 ───────────────────────────────
  var colMap = {};
  headers.forEach(function(h, j){ colMap[h] = j + 1; }); // 1-based

  function setCol(field, value) {
    if (colMap[field]) sheet.getRange(targetRowIdx, colMap[field]).setValue(value);
  }
  setCol('date',        String(data.date         || oldRow.date));
  setCol('account_id',  String(data.account_id   || oldRow.account_id));
  setCol('owner',       String(data.owner        || oldRow.owner));
  setCol('account_name',String(data.account_name || oldRow.account_name));
  setCol('ticker',      String(data.ticker       || oldRow.ticker));
  setCol('name',        String(data.name         || oldRow.name));
  setCol('market',      String(data.market       || oldRow.market));
  setCol('qty',         newQty);
  setCol('sell_price',  Number(data.sell_price)  || Number(oldRow.sell_price)  || 0);
  setCol('buy_price',   Number(data.buy_price)   || Number(oldRow.buy_price)   || 0);
  setCol('profit',      Number(data.profit)      || Number(oldRow.profit)      || 0);
  setCol('profit_rate', Number(data.profit_rate) || Number(oldRow.profit_rate) || 0);
  setCol('memo',        data.memo != null ? String(data.memo) : String(oldRow.memo || ''));
  // tags: 배열 또는 문자열 모두 처리
  var newTags = data.tags != null
    ? (Array.isArray(data.tags) ? data.tags.join(',') : String(data.tags))
    : String(oldRow.tags || '');
  setCol('tags', newTags);

  return { ok: true, id: targetId };
}

// ── 매도 내역 삭제 + 투자현황 복원 ──────────────────────────
function deleteSale(data) {
  var targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };

  var sheet   = getSaleSheet();
  var allRows = sheet.getDataRange().getValues();
  var headers = allRows[0].map(function(h){ return String(h).trim(); });

  for (var i = 1; i < allRows.length; i++) {
    if (String(allRows[i][0]).trim() !== targetId) continue;

    var row = {};
    headers.forEach(function(h, j){ row[h] = allRows[i][j]; });

    var saleQty    = Number(row.qty) || 0;
    var snapshot   = String(row.holding_snapshot || '');
    var accountId  = String(row.account_id);
    var ticker     = String(row.ticker);

    // ── 투자현황 복원 ─────────────────────────────────────────
    if (saleQty > 0 && ticker) {
      var found = findHoldingRow(accountId, ticker);
      if (found) {
        // 아직 보유 중 → 수량 반환
        var hSheet = SS.getSheetByName(SHEET.HOLDINGS);
        var curQty = parseFloat(found.rowData[5]) || 0;
        hSheet.getRange(found.rowIndex, 6).setValue(curQty + saleQty);
      } else if (snapshot) {
        // 완전매도로 행 삭제됨 → 스냅샷으로 복원
        var snap;
        try { snap = JSON.parse(snapshot); } catch(e) { snap = null; }
        if (snap) {
          snap.quantity = saleQty; // 되돌릴 수량
          var res = restoreHoldingFromSnapshot(JSON.stringify(snap));
          if (res.error) return res;
        }
      }
    }

    // ── 실현수익 시트에서 행 삭제 ─────────────────────────────
    sheet.deleteRow(i + 1);
    return { ok: true, id: targetId };
  }
  return { error: '해당 실현수익 내역 없음: ' + targetId };
}

// ============================================================
// 스냅샷 저장 및 조회
// ============================================================

// 오후 4시~5시 사이, 오늘 날짜로 아직 저장 안된 경우에만 저장
function saveSnapshotIfNeeded() {
  const now  = new Date();
  const hour = now.getHours();
  if (hour < 16 || hour >= 17) return; // 오후 4시~5시만
  const today = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');

  // 스냅샷 시트 확인/생성
  var sheet = SS.getSheetByName(SHEET.SNAPSHOT);
  if (!sheet) {
    sheet = SS.insertSheet(SHEET.SNAPSHOT);
    sheet.appendRow(['date', 'owner', 'account_id', 'broker', 'account_type', 'eval_amount', 'cost_amount']);
    sheet.getRange(1, 1, 1, 7).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 오늘 이미 저장됐는지 확인
  const rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    const rowDate = rows[i][0] ? Utilities.formatDate(new Date(rows[i][0]), 'Asia/Seoul', 'yyyy-MM-dd') : '';
    if (rowDate === today) {
      Logger.log('스냅샷: 오늘(' + today + ') 이미 저장됨 — 스킵');
      return;
    }
  }

  saveSnapshot();
}

// 스냅샷 강제 저장 (수동 실행용)
function saveSnapshot() {
  const now   = new Date();
  const today = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
  const data  = getPortfolio();
  const usdKrw = parseFloat((data.config || {}).USD_KRW) || 1450;

  // 계좌별 집계
  const acctMap = {};
  (data.holdings || []).forEach(function(h) {
    const key = String(h.account_id);
    if (!acctMap[key]) {
      acctMap[key] = {
        owner:        h.owner        || '',
        account_id:   h.account_id   || '',
        broker:       h.broker       || '',
        account_type: h.account_type || '',
        eval_amount:  0,
        cost_amount:  0,
      };
    }
    acctMap[key].eval_amount += (h.eval_amount  || 0);
    acctMap[key].cost_amount += (h.cost_amount  || 0);
  });

  var sheet = SS.getSheetByName(SHEET.SNAPSHOT);
  if (!sheet) {
    sheet = SS.insertSheet(SHEET.SNAPSHOT);
    sheet.appendRow(['date', 'owner', 'account_id', 'broker', 'account_type', 'eval_amount', 'cost_amount']);
    sheet.getRange(1, 1, 1, 7).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  }

  // ── 오늘 날짜 기존 행 삭제 (덮어쓰기) ──────────────────────
  // 뒤에서 앞으로 순회해야 deleteRow 시 인덱스 안 밀림
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    var rowDate = values[i][0]
      ? Utilities.formatDate(new Date(values[i][0]), 'Asia/Seoul', 'yyyy-MM-dd')
      : '';
    if (rowDate === today) {
      sheet.deleteRow(i + 1);
    }
  }

  const newRows = Object.values(acctMap).map(function(a) {
    return [today, a.owner, a.account_id, a.broker, a.account_type,
            Math.round(a.eval_amount), Math.round(a.cost_amount)];
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 7).setValues(newRows);
    Logger.log('스냅샷 저장 완료: ' + today + ' / ' + newRows.length + '개 계좌 (기존 오늘 데이터 교체)');
  }
  return { ok: true, date: today, accounts: newRows.length };
}

// 스냅샷 조회 API
// ?action=snapshot&from=2026-01-01&to=2026-05-29
function getSnapshot(e) {
  const params = (e && e.parameter) || {};
  const from   = params.from || '';
  const to     = params.to   || '';

  var sheet = SS.getSheetByName(SHEET.SNAPSHOT);
  if (!sheet) return { rows: [] };

  const data    = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows: [] };
  const headers = data[0].map(function(h) { return String(h).trim(); });

  const rows = [];
  for (var i = 1; i < data.length; i++) {
    const row = {};
    headers.forEach(function(h, j) { row[h] = data[i][j]; });
    const dateStr = row.date ? Utilities.formatDate(new Date(row.date), 'Asia/Seoul', 'yyyy-MM-dd') : '';
    if (from && dateStr < from) continue;
    if (to   && dateStr > to)   continue;
    row.date = dateStr;
    rows.push(row);
  }
  return { rows: rows };
}

// ============================================================
// 3-2. 계좌 그룹 관리
// ============================================================
function saveAccountGroup(data) {
  // data: { groupName, accountIds: ['1','2',...], displayLabels: ['본인 · 미래에셋 일반',...] }
  const groupName     = String(data.groupName || '').trim();
  if (!groupName) return { error: '그룹명을 입력하세요' };
  const accountIds    = (data.accountIds    || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
  const displayLabels = (data.displayLabels || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
  if (accountIds.length === 0) return { error: '계좌를 1개 이상 선택하세요' };

  const sheet = SS.getSheetByName(SHEET.CONFIG);
  if (!sheet) return { error: 'config 시트 없음' };

  // 저장 형식: "accountId1|displayLabel1,accountId2|displayLabel2,..."
  const entries = accountIds.map(function(id, i) {
    return id + '|' + (displayLabels[i] || id);
  });
  const key   = 'ACCOUNT_GROUP_' + groupName;
  const value = entries.join(',');
  const data2 = sheet.getDataRange().getValues();

  for (var i = 1; i < data2.length; i++) {
    if (String(data2[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return { ok: true, action: 'updated', groupName: groupName };
    }
  }
  sheet.appendRow([key, value]);
  return { ok: true, action: 'created', groupName: groupName };
}

function deleteAccountGroup(data) {
  const groupName = String(data.groupName || '').trim();
  if (!groupName) return { error: '그룹명 필요' };

  const sheet = SS.getSheetByName(SHEET.CONFIG);
  if (!sheet) return { error: 'config 시트 없음' };

  const key   = 'ACCOUNT_GROUP_' + groupName;
  const rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.deleteRow(i + 1);
      return { ok: true, groupName: groupName };
    }
  }
  return { error: '그룹을 찾을 수 없음: ' + groupName };
}

// ============================================================
// 4. 종목 검색
// ============================================================
function searchTicker(q) {
  q = String(q).trim();
  if (!q) return [];
  const results = [];
  const qLower  = q.toLowerCase();
  const isNum   = /^\d+$/.test(q);

  // ── KR: KRX종목코드온라인 시트 검색 ─────────────────────────
  const krxSheet = SS.getSheetByName(SHEET.KRX_ONLINE);
  if (krxSheet) {
    const krxData = krxSheet.getDataRange().getValues();
    for (var i = 1; i < krxData.length && results.length < 15; i++) {
      const name = String(krxData[i][0] || '').trim();
      const code = String(krxData[i][1] || '').trim().padStart(6, '0');
      const exch = String(krxData[i][2] || '').trim();
      if (!name || !code) continue;
      const matched = isNum ? code.includes(q) : name.toLowerCase().includes(qLower) || code.includes(q);
      if (matched) results.push({ name: name, ticker: code, market: 'KR', exchange: exch });
    }
  }

  // ── US: 투자현황 시트의 실제 보유 종목 우선 + 기본 리스트 보완 ──
  const holdingUsMap = {};
  const hSheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (hSheet) {
    const hData = hSheet.getDataRange().getValues();
    const hHeaders = hData[0].map(function(h) { return String(h).trim().toLowerCase(); });
    const iTicker = hHeaders.indexOf('ticker');
    const iName   = hHeaders.indexOf('name');
    const iMarket = hHeaders.indexOf('market');
    if (iTicker >= 0 && iMarket >= 0) {
      for (var j = 1; j < hData.length; j++) {
        const mkt = String(hData[j][iMarket] || '').trim().toUpperCase();
        if (mkt !== 'US') continue;
        const tk  = String(hData[j][iTicker] || '').trim();
        const nm  = iName >= 0 ? String(hData[j][iName] || '').trim() : tk;
        if (!tk || tk.startsWith('CASH')) continue;
        if (!holdingUsMap[tk]) holdingUsMap[tk] = { name: nm, ticker: tk, market: 'US', exchange: 'US' };
      }
    }
  }

  // 기본 리스트 (보유 종목에 없는 메이저 종목 보완용)
  const US_DEFAULT = [
    { name: 'Apple',              ticker: 'AAPL',  exchange: 'NASDAQ' },
    { name: 'Microsoft',          ticker: 'MSFT',  exchange: 'NASDAQ' },
    { name: 'NVIDIA',             ticker: 'NVDA',  exchange: 'NASDAQ' },
    { name: 'Amazon',             ticker: 'AMZN',  exchange: 'NASDAQ' },
    { name: 'Alphabet (Google)',  ticker: 'GOOGL', exchange: 'NASDAQ' },
    { name: 'Meta',               ticker: 'META',  exchange: 'NASDAQ' },
    { name: 'Tesla',              ticker: 'TSLA',  exchange: 'NASDAQ' },
    { name: 'Berkshire Hathaway', ticker: 'BRK-B', exchange: 'NYSE'   },
    { name: 'QQQ ETF',            ticker: 'QQQ',   exchange: 'NASDAQ' },
    { name: 'S&P500 ETF (SPY)',   ticker: 'SPY',   exchange: 'NYSE'   },
    { name: 'S&P500 ETF (VOO)',   ticker: 'VOO',   exchange: 'NYSE'   },
    { name: 'SOXX 반도체 ETF',    ticker: 'SOXX',  exchange: 'NASDAQ' },
    { name: 'SOXL 반도체 3배',    ticker: 'SOXL',  exchange: 'NYSE'   },
    { name: 'TQQQ 나스닥 3배',    ticker: 'TQQQ',  exchange: 'NASDAQ' },
    { name: 'SCHD 배당 ETF',      ticker: 'SCHD',  exchange: 'NYSE'   },
    { name: 'JEPI 커버드콜 ETF',  ticker: 'JEPI',  exchange: 'NYSE'   },
    { name: 'VTI 전체시장 ETF',   ticker: 'VTI',   exchange: 'NYSE'   },
    { name: 'ARKK 혁신 ETF',      ticker: 'ARKK',  exchange: 'NYSE'   },
    { name: 'Palantir',           ticker: 'PLTR',  exchange: 'NYSE'   },
  ];
  US_DEFAULT.forEach(function(u) {
    if (!holdingUsMap[u.ticker]) holdingUsMap[u.ticker] = u;
  });

  // 검색어 필터링 — 보유 종목이 상단에 오도록 정렬
  Object.values(holdingUsMap).forEach(function(u) {
    if (results.length >= 20) return;
    if (u.name.toLowerCase().includes(qLower) || u.ticker.toLowerCase().includes(qLower)) {
      results.push({ name: u.name, ticker: u.ticker, market: 'US', exchange: u.exchange });
    }
  });

  return results;
}

// ============================================================
// 5. 데이터 쓰기
// ============================================================
function addHolding(data) {
  const sheet  = SS.getSheetByName(SHEET.HOLDINGS);
  const market = (data.market || 'KR').toUpperCase();
  const ticker = normalizeTicker(data.ticker || '', market);

  // account_id 정규화 (id= 포함 문자열 → 숫자)
  let accountId = data.account_id;
  if (typeof accountId === 'string' && accountId.includes('id=')) {
    const m = accountId.match(/id=(\d+)/);
    if (m) accountId = parseInt(m[1]);
  }
  accountId = String(accountId).trim();

  const assetRegion = (data.asset_region || market).toUpperCase();
  const newRow = [
    accountId, ticker, data.name || '', market,
    data.sector || '기타', parseFloat(data.quantity) || 0,
    parseFloat(data.avg_price) || 0, assetRegion,
  ];

  // ── 같은 account_id의 마지막 행 바로 아래에 삽입 ──────────
  const lastRow = sheet.getLastRow();
  var insertAfterRow = -1; // -1이면 appendRow 사용

  if (lastRow >= 2) {
    const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = colA.length - 1; i >= 0; i--) {
      const cellVal = String(colA[i][0] || '').trim();
      // 정규화: "본인 · 나무해외 · 일반 (id=7)" → "7", 또는 "7" → "7"
      const cellId = cellVal.includes('id=')
        ? (cellVal.match(/id=(\d+)/) || ['',''])[1]
        : cellVal;
      if (cellId === accountId) {
        insertAfterRow = i + 2; // +1(헤더 오프셋) +1(0-based→1-based)
        break;
      }
    }
  }

  if (insertAfterRow > 0) {
    sheet.insertRowAfter(insertAfterRow);
    // A열 유효성 검사 제거 (숫자 account_id는 드롭다운 허용목롹에 없일로 유효성 위배)
    sheet.getRange(insertAfterRow + 1, 1).clearDataValidations();
    sheet.getRange(insertAfterRow + 1, 1, 1, newRow.length).setValues([newRow]);
    Logger.log('addHolding: ' + ticker + ' → 시트 ' + (insertAfterRow + 1) + '행에 삽입 (account_id=' + accountId + ')');
  } else {
    // appendRow 젴전: A열 유효성을 잠시 제거 후 추가
    var lastRowNum = sheet.getLastRow();
    sheet.getRange(lastRowNum + 1, 1).clearDataValidations();
    sheet.appendRow(newRow);
    Logger.log('addHolding: ' + ticker + ' → 맨 끝에 추가 (account_id 행 없음)');
  }

  syncToTickerMaster(ticker, data.name || ticker, market, data.sector || '기타');
  // v2: 신규 종목 가격은 Python 수집기가 다음 auto 실행에서 채운다.
  return { success: true };
}

function updateHolding(data) {
  // ── account_id + 원본ticker로 행 탐색 (행 번호 기반은 추가/삭제 시 밀림) ──
  const sheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (!sheet) return { error: '투자현황 시트 없음' };

  var accountId  = String(data.orig_account_id || data.account_id || '').trim();
  var origTicker = String(data.orig_ticker || data.ticker || '').trim();
  var market     = String(data.market || 'KR').toUpperCase();

  var found = findHoldingRow(accountId, origTicker);

  // 못 찾으면 id 기반 폴백 (하위 호환)
  if (!found) {
    var rowNum = parseInt(data.id);
    if (rowNum && rowNum >= 1) {
      var sheetRow2 = rowNum + 1;
      if (sheetRow2 <= sheet.getLastRow()) {
        found = { rowIndex: sheetRow2, rowData: sheet.getRange(sheetRow2, 1, 1, 8).getValues()[0] };
      }
    }
    if (!found) return { error: '해당 종목 행을 찾을 수 없습니다: ' + origTicker };
  }

  var sheetRow = found.rowIndex;

  // 새 ticker (수정된 경우 normalizeTicker 적용)
  var newTicker = data.ticker != null
    ? normalizeTicker(String(data.ticker).trim(), market)
    : null;

  if (newTicker         != null) sheet.getRange(sheetRow, 2).setValue(newTicker);
  if (data.name         != null) sheet.getRange(sheetRow, 3).setValue(data.name);
  if (data.market       != null) sheet.getRange(sheetRow, 4).setValue(market);
  if (data.sector       != null) sheet.getRange(sheetRow, 5).setValue(data.sector);
  if (data.quantity     != null) sheet.getRange(sheetRow, 6).setValue(parseFloat(data.quantity));
  if (data.avg_price    != null) sheet.getRange(sheetRow, 7).setValue(parseFloat(data.avg_price));
  if (data.asset_region != null) sheet.getRange(sheetRow, 8).setValue(data.asset_region.toUpperCase());

  // 방안1: ticker/market/name/sector 변경 시 종목코드 시트 동시 업데이트
  var finalTicker = newTicker || origTicker;
  var finalName   = data.name   != null ? data.name   : String(found.rowData[2] || '');
  var finalSector = data.sector != null ? data.sector : String(found.rowData[4] || '');
  syncToTickerMasterUpdate(finalTicker, finalName, market, finalSector);

  return { success: true };
}

function deleteHolding(data) {
  const sheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (!sheet) return { error: '투자현황 시트 없음' };

  // account_id + ticker로 행 탐색 (행 번호 기반 오류 방지)
  var accountId = String(data.account_id || '').trim();
  var ticker    = String(data.ticker     || '').trim();
  var found     = accountId && ticker ? findHoldingRow(accountId, ticker) : null;

  // 못 찾으면 id 기반 폴백
  if (!found) {
    var rowNum = parseInt(data.id);
    if (!rowNum || rowNum < 1) return { error: '유효하지 않은 ID' };
    var sheetRow = rowNum + 1;
    if (sheetRow > sheet.getLastRow()) return { error: '행을 찾을 수 없음' };
    sheet.deleteRow(sheetRow);
    return { success: true };
  }

  sheet.deleteRow(found.rowIndex);
  return { success: true };
}

function addAccount(data) {
  const sheet = SS.getSheetByName(SHEET.ACCOUNTS);
  const newId = sheet.getLastRow();
  sheet.appendRow([newId, data.owner, data.broker, data.account_type]);
  return { success: true, id: newId };
}

// 종목코드 시트 US ticker 한글 오염 복구 함수
// GAS 편집기에서 한 번 실행하면 됩니다
// 투자현황 B열 ticker 복원 함수
// 종목코드 시트와 name 컬럼을 기반으로 빈 ticker를 복원
// ============================================================
function normalizeHoldingAccountIds() {
  var sheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (!sheet) { SpreadsheetApp.getUi().alert('투자현황 시트 없음'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('데이터 없음'); return; }

  var normalized = 0;
  var blanksRemoved = 0;

  // 아래에서 위로 순회 (행 삭제 시 인덱스 밀림 방지)
  for (var i = lastRow; i >= 2; i--) {
    var rowVals = sheet.getRange(i, 1, 1, 9).getValues()[0];
    var isEmpty = rowVals.every(function(v) { return String(v || '').trim() === ''; });
    if (isEmpty) {
      sheet.deleteRow(i);
      blanksRemoved++;
      continue;
    }
    var cell = sheet.getRange(i, 1);
    var val  = String(cell.getValue() || '').trim();
    if (val.includes('id=')) {
      var m = val.match(/id=(\d+)/);
      if (m) { cell.setValue(parseInt(m[1])); normalized++; }
    }
  }

  SpreadsheetApp.getUi().alert(
    '\u2705 투자현황 정비 완료!\n\n'
    + 'account_id 정규화: ' + normalized + '개\n'
    + '빈 행 제거: ' + blanksRemoved + '개\n\n'
    + '\u26a1 "지금 즉시 현재가 갱신"을 실행하세요.'
  );
}

// 디버그: addHolding 조건 진단 (심행 거든 후 확인)
function diagHoldingAccountIds() {
  var sheet = SS.getSheetByName(SHEET.HOLDINGS);
  var lastRow = sheet.getLastRow();
  var colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var log = [];
  // account_id=2, 7츨 행만 추출
  for (var i = 0; i < colA.length; i++) {
    var raw = colA[i][0];
    var val = String(raw || '').trim();
    var cellId = val.includes('id=') ? (val.match(/id=(\d+)/) || ['',''])[1] : val;
    if (cellId === '2' || cellId === '7') {
      log.push('행' + (i+2) + ': raw=[' + raw + '] type=' + typeof raw + ' cellId=' + cellId);
    }
  }
  Logger.log(log.join('\n'));
  SpreadsheetApp.getUi().alert(log.slice(0,20).join('\n') || '해당 account_id 행 없음');
}

function restoreHoldingTickers() {
  var holdingSheet = SS.getSheetByName(SHEET.HOLDINGS);
  var masterSheet  = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!holdingSheet || !masterSheet) {
    SpreadsheetApp.getUi().alert('시트 없음');
    return;
  }

  // 종목코드 시트에서 name → ticker 맵 구성
  var masterData = masterSheet.getDataRange().getValues();
  var nameToTicker = {}; // name(소문자) → ticker
  var tickerToTicker = {}; // ticker(소문자) → ticker (정규화용)
  for (var i = 1; i < masterData.length; i++) {
    var t = String(masterData[i][0] || '').trim();
    var n = String(masterData[i][2] || '').trim(); // name은 3번째 컬럼
    if (t) {
      nameToTicker[n.toLowerCase()] = t;
      tickerToTicker[t.toLowerCase()] = t;
    }
  }

  // 투자현황 B열 복원
  var holdingData = holdingSheet.getDataRange().getValues();
  var restored = 0;
  var notFound = [];

  for (var r = 1; r < holdingData.length; r++) {
    var ticker = String(holdingData[r][1] || '').trim();
    var name   = String(holdingData[r][2] || '').trim();
    var market = String(holdingData[r][3] || '').trim().toUpperCase();

    // ticker가 비어있고 name이 있는 경우만 복원 시도
    if (!ticker && name) {
      // 1. name으로 종목코드 시트에서 ticker 찾기
      var found = nameToTicker[name.toLowerCase()];
      // 2. name 자체가 ticker인 경우 (AMD, SPYM 등 영문)
      if (!found && /^[A-Z0-9]+$/.test(name)) {
        found = name.toUpperCase();
      }
      // 3. ticker(소문자)로 찾기
      if (!found) {
        found = tickerToTicker[name.toLowerCase()];
      }

      if (found) {
        holdingSheet.getRange(r + 1, 2).setValue(found);
        Logger.log('복원: ' + (r+1) + '행 [' + name + '] → [' + found + ']');
        restored++;
      } else {
        notFound.push((r+1) + '행: ' + name);
        Logger.log('미발견: ' + (r+1) + '행 [' + name + ']');
      }
    }
  }

  var msg = '✅ ticker 복원 완료\n'
    + '복원: ' + restored + '개\n'
    + (notFound.length > 0 ? '수동 입력 필요:\n' + notFound.join('\n') : '');
  SpreadsheetApp.getUi().alert(msg);
  Logger.log(msg);
}

function fixCorruptedUSTickers() {
  var sheet = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!sheet) { SpreadsheetApp.getUi().alert('종목코드 시트 없음'); return; }

  var data = sheet.getDataRange().getValues();
  var removed = [];
  var fixed   = [];

  // 뒤에서 앞으로 순회 (deleteRow 시 인덱스 밀림 방지)
  for (var i = data.length - 1; i >= 1; i--) {
    var ticker = String(data[i][0] || '').trim();
    var market = String(data[i][2] || '').trim().toUpperCase();

    // US 종목인데 ticker에 한글이 포함된 경우 → 삭제
    if (market === 'US' && /[가-힣]/.test(ticker)) {
      removed.push(ticker);
      sheet.deleteRow(i + 1);
    }
    // KR 종목인데 ticker에 한글이 포함된 경우 → 삭제
    if (market === 'KR' && /[가-힣]/.test(ticker)) {
      removed.push(ticker + '(KR)');
      sheet.deleteRow(i + 1);
    }
  }

  var msg = '✅ 한글 오염 ticker 제거 완료\n'
    + '제거된 항목(' + removed.length + '개):\n'
    + removed.join('\n');
  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);

  // 제거 후 투자현황 → 종목코드 재동기화
  syncHoldingsToTickerMaster();
  SpreadsheetApp.getUi().alert('종목코드 재동기화 완료!\n이제 ⚡ 지금 즉시 현재가 갱신을 실행하세요.');
}

function syncToTickerMaster(ticker, name, market, sector) {
  const sheet = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!sheet) return;
  const tickers = sheet.getDataRange().getValues().slice(1).map(function(r) { return String(r[0]).trim(); });
  if (!tickers.includes(ticker)) {
    sheet.getRange(sheet.getLastRow() + 1, 1).setNumberFormat('@');
    sheet.appendRow([ticker, name, market, sector]);
  }
}

// 종목코드 시트 업데이트 (이미 있는 ticker는 market/name/sector 갱신, 없으면 신규 추가)
function syncToTickerMasterUpdate(ticker, name, market, sector) {
  if (!ticker) return;
  var sheet = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === ticker) {
      // 이미 있으면 market/name/sector 모두 갱신
      if (market) sheet.getRange(i + 1, 3).setValue(market);
      if (name)   sheet.getRange(i + 1, 2).setValue(name);
      if (sector) sheet.getRange(i + 1, 4).setValue(sector);
      Logger.log('syncToTickerMasterUpdate: ' + ticker + ' market=' + market);
      return;
    }
  }
  // 없으면 신규 추가
  sheet.getRange(sheet.getLastRow() + 1, 1).setNumberFormat('@');
  sheet.appendRow([ticker, name, market, sector]);
  Logger.log('syncToTickerMasterUpdate: ' + ticker + ' 신규 추가 market=' + market);
}

function normalizeTicker(ticker, market) {
  ticker = String(ticker).trim().toUpperCase();
  if (market === 'KR' && /^\d+$/.test(ticker) && ticker.length < 6) {
    ticker = ticker.padStart(6, '0');
  }
  return ticker;
}

// ============================================================
// 6. 현재가 자동 업데이트 (10분마다)
// ============================================================
// KV 캐시 강제 초기화 후 즉시 재갱신
function clearCloudflareKV() {
  const connection = getV2ConnectionConfig_();
  const workerUrl = connection.workerUrl;
  const secret    = connection.secret;
  if (!workerUrl || !secret) {
    SpreadsheetApp.getUi().alert('❌ Script Properties의 WORKER_URL 또는 SSTFOLIO_SECRET 미설정');
    return;
  }
  try {
    // 1. KV 캐시 전체 삭제
    const clearRes = UrlFetchApp.fetch(workerUrl + '/api/cache-clear', {
      method: 'post',
      muteHttpExceptions: true,
      headers: {
        'Content-Type':      'application/json',
        'X-Sstfolio-Secret': secret,
      },
    });
    Logger.log('캐시 삭제 응답: ' + clearRes.getResponseCode() + ' ' + clearRes.getContentText());

    // 2. 바로 현재가 갱신 + KV 재저장
    updateAllPrices();

    SpreadsheetApp.getUi().alert('✅ KV 캐시 초기화 및 재갱신 완료!\n웹사이트를 새로고침하세요.');
  } catch(e) {
    SpreadsheetApp.getUi().alert('❌ 오류: ' + e.message);
  }
}

// 방안2: 투자현황 시트 기준으로 종목코드 시트 market 불일치 자동 보정
// 투자현황에서 수정했은데 종목코드에 반영 안 된 경우 자동 보정
// 신규 추가된 종목 1개의 현재가만 즉시 조회하여 현재가 시트에 저장
// addHolding() 에서 호출
function updateSinglePrice(ticker, market, name) {
  // v2 호환용: GAS에서 시세 사이트를 직접 호출하지 않는다.
  return requestPriceRefresh_('auto', 'legacy_updateSinglePrice_' + String(ticker || ''));
}

function syncTickerMasterFromHoldings() {
  var holdingSheet = SS.getSheetByName(SHEET.HOLDINGS);
  var masterSheet  = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!holdingSheet || !masterSheet) return;

  // 투자현황에서 ticker \u2192 market 맵 구성
  var hData = holdingSheet.getDataRange().getValues();
  var holdingMarketMap = {}; // ticker \u2192 market
  for (var i = 1; i < hData.length; i++) {
    var t = normalizeTicker(String(hData[i][1] || '').trim(), String(hData[i][3] || 'KR').trim());
    var m = String(hData[i][3] || '').trim().toUpperCase();
    if (t && m) holdingMarketMap[t] = m;
  }

  // 종목코드 시트에서 불일치 한목 보정
  var mData   = masterSheet.getDataRange().getValues();
  var fixed   = 0;
  for (var j = 1; j < mData.length; j++) {
    var mt = String(mData[j][0] || '').trim();
    var mm = String(mData[j][2] || '').trim().toUpperCase();
    if (!mt) continue;
    var correctMarket = holdingMarketMap[mt];
    if (correctMarket && correctMarket !== mm) {
      masterSheet.getRange(j + 1, 3).setValue(correctMarket);
      Logger.log('[syncTickerMaster] ' + mt + ': ' + mm + ' \u2192 ' + correctMarket + ' 보정');
      fixed++;
    }
  }
  if (fixed > 0) Logger.log('[syncTickerMaster] 보정 완료: ' + fixed + '개');
}

function updateAllPrices() {
  // v2에서는 GAS가 네이버/Yahoo 가격을 직접 수집하거나 KV에 가격을 쓰지 않는다.
  // 기존 메뉴 호환을 위해 이 함수는 GitHub Actions 긴급 전체 최신화만 요청한다.
  var result = requestPriceRefresh_('emergency_full', 'gas_manual_updateAllPrices');
  try {
    SpreadsheetApp.getUi().alert(
      result.ok
        ? '✅ SSTfolio v2 긴급 전체 최신화를 요청했습니다.\n웹 화면에서 완료 여부를 확인하세요.'
        : '❌ 최신화 요청 실패: ' + (result.error || 'unknown')
    );
  } catch(e) {}
  return result;
}

// sstfolio Cloudflare Worker KV 갱신
// Script Properties에 WORKER_URL, SSTFOLIO_SECRET 설정 필요
// GitHub Actions workflow_dispatch 트리건 — 지금 수집 버튼용
// Script Properties: GITHUB_TOKEN, GITHUB_REPO (owner/repo 형식)
// ── Watchdog: GitHub Actions cron 누락 감지 및 재트리거 ──────────────
// GAS 10분 트리거로 실행 — KV updated_at 확인 후 누락 시 GitHub Actions 재트리거
// ── Watchdog 트리거 등록 ──────────────────────────────────────
function registerWatchdogTrigger() {
  // 기존 watchdog 트리거 삭제 후 재등록
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'watchdogTrigger') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('watchdogTrigger')
    .timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert('✅ Watchdog 트리거 등록 완료!\n10분마다 GitHub Actions 누락 여부를 감지합니다.');
}

// ── 환율 트리거 등록 ──────────────────────────────────────────
function registerExchangeRateTrigger() {
  // 기존 환율 트리거 삭제 후 재등록
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'updateExchangeRate') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('updateExchangeRate')
    .timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('✅ 환율 트리거 등록 완료!\n1시간마다 USD/KRW 환율을 갱신합니다.');
}

// ── 이메일 알림 발송 ─────────────────────────────────────────
function sendAlertEmail(subject, body) {
  var props = PropertiesService.getScriptProperties();
  var recipients = String(props.getProperty('ALERT_EMAILS') || '')
    .split(',').map(function(v) { return v.trim(); }).filter(function(v) { return v; });
  if (recipients.length === 0) {
    Logger.log('ALERT_EMAILS 미설정 — 이메일 발송 스킵: ' + subject);
    return;
  }

  var fullBody = [
    body,
    '',
    '──────────────────────────────────────',
    'SSTfolio v2 자동 점검 안내',
    '1. Worker /api/health의 updated_at, collector.status 확인',
    '2. GitHub Actions fetch-realtime.yml 실행 로그 확인',
    '3. CF_KV_NAMESPACE_ID와 Worker SSTFOLIO_KV binding이 같은 v2 KV인지 확인',
    '4. v2 Worker의 GAS_URL, GITHUB_REPO, GITHUB_TOKEN 확인',
    '',
    '이 메일은 SSTfolio v2 GAS watchdogTrigger에서 자동 발송되었습니다.'
  ].join('\n');

  try {
    recipients.forEach(function(email) {
      MailApp.sendEmail(email, '[SSTfolio v2 알림] ' + subject, fullBody);
    });
    Logger.log('알림 이메일 발송 완료: ' + recipients.join(', '));
  } catch(e) {
    Logger.log('이메일 발송 실패: ' + e.message);
  }
}

// ── 이메일 중복 발송 방지 (1시간 내 동일 알림 재발송 차단) ──
function shouldSendAlert(alertKey) {
  var props = PropertiesService.getScriptProperties();
  var lastSent = props.getProperty('alert_last_' + alertKey);
  if (lastSent) {
    var diffMin = (Date.now() - parseInt(lastSent)) / 60000;
    if (diffMin < 60) {
      Logger.log('알림 스킵 (최근 ' + diffMin.toFixed(0) + '분 전 발송됨): ' + alertKey);
      return false;
    }
  }
  props.setProperty('alert_last_' + alertKey, String(Date.now()));
  return true;
}

function watchdogTrigger() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = String(props.getProperty('WORKER_URL') || '').replace(/\/$/, '');
  var staleMin = Number(props.getProperty('WATCHDOG_STALE_MINUTES') || 15);
  var alertMin = Number(props.getProperty('WATCHDOG_ALERT_MINUTES') || 60);
  var cooldownMin = Number(props.getProperty('WATCHDOG_RETRY_COOLDOWN_MINUTES') || 30);
  var nowMs = Date.now();

  function canRetry_() {
    var last = Number(props.getProperty('WATCHDOG_LAST_TRIGGER_MS') || 0);
    return !last || (nowMs - last) / 60000 >= cooldownMin;
  }
  function retry_() {
    if (!canRetry_()) {
      Logger.log('watchdog: 재트리거 cooldown 중');
      return { ok: false, cooldown: true };
    }
    var result = triggerGithubActions('auto');
    if (result.ok) props.setProperty('WATCHDOG_LAST_TRIGGER_MS', String(nowMs));
    return result;
  }

  if (!workerUrl) {
    var noUrlResult = retry_();
    if (shouldSendAlert('worker_url_missing')) {
      sendAlertEmail('WORKER_URL 미설정', 'Script Property WORKER_URL이 없습니다. GitHub 재트리거 결과: ' + JSON.stringify(noUrlResult));
    }
    return;
  }

  try {
    var res = UrlFetchApp.fetch(workerUrl + '/api/health', {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'sstfolio-v2-watchdog/2.0' }
    });
    if (res.getResponseCode() !== 200) {
      var badResult = retry_();
      Logger.log('watchdog: Worker HTTP ' + res.getResponseCode());
      if (shouldSendAlert('worker_unreachable')) {
        sendAlertEmail('Cloudflare Worker 응답 이상', 'Worker HTTP ' + res.getResponseCode() + '\nGitHub 재트리거 결과: ' + JSON.stringify(badResult));
      }
      return;
    }

    var health = JSON.parse(res.getContentText());
    var updatedAt = health.updated_at || '';
    var collectorStatus = health.collector && health.collector.status;
    if (!updatedAt) {
      var nullResult = retry_();
      if (shouldSendAlert('kv_not_ready')) {
        sendAlertEmail('v2 가격 KV 미준비', 'portfolio_data.updated_at이 없습니다.\nGitHub 재트리거 결과: ' + JSON.stringify(nullResult));
      }
      return;
    }

    var diffMin = (nowMs - new Date(updatedAt).getTime()) / 60000;
    Logger.log('watchdog: 마지막 공개 데이터 ' + diffMin.toFixed(1) + '분 전, collector=' + collectorStatus);
    if (diffMin > staleMin) {
      var staleResult = retry_();
      Logger.log('watchdog 재트리거: ' + JSON.stringify(staleResult));
    }
    if ((diffMin > alertMin || collectorStatus === 'failed') && shouldSendAlert('price_stale')) {
      sendAlertEmail(
        '현재가 갱신 이상',
        '마지막 공개 데이터: ' + updatedAt + '\n경과: ' + diffMin.toFixed(1) + '분\ncollector: ' + collectorStatus
      );
    }
  } catch(e) {
    var errorResult = retry_();
    Logger.log('watchdog 오류: ' + e.message);
    if (shouldSendAlert('watchdog_exception')) {
      sendAlertEmail('watchdog 실행 오류', e.message + '\nGitHub 재트리거 결과: ' + JSON.stringify(errorResult));
    }
  }
}

function triggerGithubActions(modeOrForce) {
  var props = PropertiesService.getScriptProperties();
  var token = String(props.getProperty('GITHUB_TOKEN') || '').trim();
  var repo = String(props.getProperty('GITHUB_REPO') || '').trim();
  var workflow = String(props.getProperty('GITHUB_WORKFLOW') || 'fetch-realtime.yml').trim();
  var branch = String(props.getProperty('GITHUB_BRANCH') || 'main').trim();
  var mode = (modeOrForce === true) ? 'emergency_full' : String(modeOrForce || 'auto').trim();
  var allowed = ['auto', 'sync', 'kr', 'us', 'emergency_full'];
  if (allowed.indexOf(mode) < 0) mode = 'auto';

  if (!token || !repo) {
    return { ok: false, error: 'GITHUB_TOKEN 및 GITHUB_REPO Script Property가 필요합니다.' };
  }

  var url = 'https://api.github.com/repos/' + repo + '/actions/workflows/' + workflow + '/dispatches';
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ ref: branch, inputs: { mode: mode } }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 204) {
      Logger.log('GitHub Actions 트리거 성공: mode=' + mode);
      return { ok: true, mode: mode };
    }
    var body = res.getContentText();
    Logger.log('GitHub Actions 트리거 실패: ' + code + ' ' + body);
    return { ok: false, error: 'GitHub HTTP ' + code + ': ' + body.substring(0, 300) };
  } catch(e) {
    Logger.log('GitHub Actions 트리거 오류: ' + e.message);
    return { ok: false, error: e.message };
  }
}


function requestPriceRefresh_(mode, reason) {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = String(props.getProperty('WORKER_URL') || '').replace(/\/$/, '');
  var secret = String(props.getProperty('SSTFOLIO_SECRET') || '');
  if (!workerUrl || !secret) {
    return { ok: false, error: 'WORKER_URL 및 SSTFOLIO_SECRET Script Property가 필요합니다.' };
  }
  try {
    var response = UrlFetchApp.fetch(workerUrl + '/api/refresh', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Sstfolio-Secret': secret },
      payload: JSON.stringify({ mode: mode || 'sync', reason: reason || 'gas_request' }),
      muteHttpExceptions: true
    });
    var body = response.getContentText();
    var parsed = {};
    try { parsed = JSON.parse(body); } catch(e) { parsed = { raw: body }; }
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      return { ok: true, response: parsed };
    }
    return { ok: false, error: 'Worker HTTP ' + response.getResponseCode(), response: parsed };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

function removeV2Triggers() {
  var handlers = ['watchdogTrigger', 'updateExchangeRate', 'crawlKRXStocks', 'saveSnapshotIfNeeded', 'updateAllPrices'];
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('v2 트리거 삭제: ' + removed + '개');
  try { SpreadsheetApp.getUi().alert('SSTfolio v2 트리거 ' + removed + '개를 삭제했습니다.'); } catch(e) {}
}

function pushToCloudflare() {
  // 레거시 함수명 호환용. GAS 포트폴리오를 KV에 쓰지 않고 Python sync만 요청한다.
  return requestPriceRefresh_('sync', 'gas_data_change');
}

// ── 환율 ────────────────────────────────────────────────────
function updateExchangeRate() {
  // 방법 1: 네이버 금융 API
  try {
    const urls = [
      'https://m.stock.naver.com/api/forex/FX_USDKRW',
      'https://api.exchangerate-api.com/v4/latest/USD',
    ];
    const res = UrlFetchApp.fetch(urls[0], {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    Logger.log('환율 API 응답코드: ' + res.getResponseCode());
    Logger.log('환율 API 응답: ' + res.getContentText().substring(0, 200));
    if (res.getResponseCode() === 200) {
      const json = JSON.parse(res.getContentText());
      // 네이버 응답 모든 필드 시도
      var rate = 0;
      var fields = ['closePrice','nv','price','close','last','rate','currentPrice','stockEndPrice'];
      for (var i = 0; i < fields.length; i++) {
        if (json[fields[i]]) {
          rate = parseFloat(String(json[fields[i]]).replace(/,/g, ''));
          if (rate > 900 && rate < 2500) {
            Logger.log('환율 필드 ' + fields[i] + ': ' + rate);
            break;
          }
        }
      }
      if (rate > 900 && rate < 2500) {
        setConfig('USD_KRW', Math.round(rate));
        setConfig('rate_updated', new Date().toLocaleString('ko-KR'));
        Logger.log('✅ 환율 저장: ' + rate);
        return;
      }
    }
  } catch(e) { Logger.log('환율 네이버 실패: ' + e.message); }

  // 방법 2: ExchangeRate-API (무료)
  try {
    const res2 = UrlFetchApp.fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      muteHttpExceptions: true
    });
    if (res2.getResponseCode() === 200) {
      const json2 = JSON.parse(res2.getContentText());
      const rate2 = parseFloat(json2.rates && json2.rates.KRW);
      if (rate2 > 900 && rate2 < 2500) {
        setConfig('USD_KRW', Math.round(rate2));
        setConfig('rate_updated', new Date().toLocaleString('ko-KR'));
        Logger.log('✅ 환율(ExchangeRate-API): ' + rate2);
        return;
      }
    }
  } catch(e) { Logger.log('환율 ExchangeRate-API 실패: ' + e.message); }

  // 방법 3: Google Finance
  try {
    const rate3 = getGoogleFinanceValue('CURRENCY:USDKRW', 'price');
    Logger.log('환율(GF): ' + rate3);
    if (rate3 > 900 && rate3 < 2500) {
      setConfig('USD_KRW', Math.round(rate3));
      setConfig('rate_updated', new Date().toLocaleString('ko-KR'));
      Logger.log('✅ 환율(GF): ' + rate3);
    }
  } catch(e) { Logger.log('환율 GF 실패: ' + e.message); }
}

// ── 한국 주식 현재가 ─────────────────────────────────────────
// SST 방식: 네이버 fetchAll() 병렬 + fluctuationsRatio 파싱
function updateKoreanPrices() {
  // v2 호환용: KR 가격 수집은 GitHub Actions Python으로 위임한다.
  return triggerGithubActions('kr');
}

// ── 미국 주식 현재가 ─────────────────────────────────────────
// Yahoo Finance fetchAll() 병렬 조회
function updateUSPrices() {
  // v2 호환용: US 가격 수집은 GitHub Actions Python으로 위임한다.
  return triggerGithubActions('us');
}

// ── v1 가격 수집 호환 함수(비활성) ───────────────────────
function _naverPollingBatch(codes) {
  Logger.log('SSTfolio v2: GAS 네이버 가격 수집은 비활성입니다. GitHub Actions를 사용하세요.');
  return {};
}

function fetchNaverPC(ticker) {
  Logger.log('SSTfolio v2: GAS 네이버 PC 가격 fallback은 비활성입니다: ' + String(ticker || ''));
  return 0;
}

// GoogleFinance 임시 시트 수식 조회
function getGoogleFinanceValue(symbol, attr) {
  try {
    var tmpSheet = SS.getSheetByName('_tmp_gf_') || SS.insertSheet('_tmp_gf_');
    tmpSheet.hideSheet();
    tmpSheet.getRange('A1').setFormula('=IFERROR(GOOGLEFINANCE("' + symbol + '","' + attr + '"),0)');
    SpreadsheetApp.flush();
    Utilities.sleep(2000);
    const val = tmpSheet.getRange('A1').getValue();
    tmpSheet.getRange('A1').clearContent();
    return (typeof val === 'number' && val > 0) ? val : 0;
  } catch(e) { return 0; }
}

// ── 현재가 시트 저장 헬퍼 (빠른 버전) ────────────────────────
// rowMap: { ticker → 행번호(1-based) } — 미리 구성해서 전달
// 헤더: A=ticker B=market C=name D=price E=change_rate F=updated_at
function savePriceFast(sheet, rowMap, ticker, market, name, price, changeRate, now) {
  const existRow = rowMap[ticker];
  if (existRow) {
    sheet.getRange(existRow, 3).setValue(name || '');
    sheet.getRange(existRow, 4).setValue(price);
    sheet.getRange(existRow, 5).setValue(changeRate || '');
    sheet.getRange(existRow, 6).setValue(now);
  } else {
    const newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1).setNumberFormat('@').setValue(ticker);
    sheet.getRange(newRow, 2).setValue(market);
    sheet.getRange(newRow, 3).setValue(name || '');
    sheet.getRange(newRow, 4).setValue(price);
    sheet.getRange(newRow, 5).setValue(changeRate || '');
    sheet.getRange(newRow, 6).setValue(now);
    rowMap[ticker] = newRow; // 캐시 갱신
  }
}

// 종목명 캐시 구성 (투자현황 + 종목코드 + KRX온라인 한번에)
function buildNameCache() {
  const cache = {};
  // 투자현황
  const hSheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (hSheet) {
    const vals = hSheet.getDataRange().getDisplayValues();
    for (var i = 1; i < vals.length; i++) {
      const t = normalizeTicker(String(vals[i][1]||'').trim(), String(vals[i][3]||'').trim());
      const n = String(vals[i][2]||'').trim();
      if (t && n && !cache[t]) cache[t] = n;
    }
  }
  // 종목코드
  const mSheet = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (mSheet) {
    const vals = mSheet.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      const t = normalizeTicker(String(vals[i][0]||'').trim(), String(vals[i][2]||'').trim());
      const n = String(vals[i][1]||'').trim();
      if (t && n && !cache[t]) cache[t] = n;
    }
  }
  return cache;
}

function setConfig(key, value) {
  const sheet  = SS.getSheetByName(SHEET.CONFIG);
  const values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === key) { sheet.getRange(i+1, 2).setValue(value); return; }
  }
  sheet.appendRow([key, value]);
}

// ============================================================
// 7. 현재가 시트 정리
// ============================================================
function cleanupPricesSheet() {
  const sheet = SS.getSheetByName(SHEET.PRICES);
  if (!sheet) { SpreadsheetApp.getUi().alert('현재가 시트 없음'); return; }

  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(function(h) { return String(h).trim().toLowerCase(); });

  // 컬럼 위치 자동 감지 (구버전 5컬럼 / 신버전 6컬럼 모두 처리)
  const hasName    = header.includes('name');
  const priceCol   = hasName ? 3 : 2;
  const rateCol    = hasName ? 4 : 3;
  const updCol     = hasName ? 5 : 4;

  // 이름 캐시
  const nameCache = buildNameCache();

  // 중복 제거: ticker → 최신 데이터만 유지
  const map = {};
  for (var i = 1; i < data.length; i++) {
    const rawT  = String(data[i][0] || '').trim();
    const mkt   = String(data[i][1] || '').trim().toUpperCase() || 'KR';
    if (!rawT) continue;
    const t     = normalizeTicker(rawT, mkt);
    const price = parseFloat(String(data[i][priceCol] || '0').replace(/[^0-9.]/g,'')) || 0;
    const rate  = String(data[i][rateCol] || '').trim();
    const upd   = String(data[i][updCol]  || '').trim();
    if (!map[t] || price > 0) {
      map[t] = { market: mkt, price: price, rate: rate, upd: upd };
    }
  }

  // 시트 완전 초기화 후 재작성
  sheet.clearContents();

  // 헤더
  const newHeader = ['ticker','market','name','price','change_rate','updated_at'];
  sheet.getRange(1, 1, 1, 6).setValues([newHeader]);
  sheet.getRange(1, 1, 1, 6).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');

  // 서식
  sheet.getRange('A:C').setNumberFormat('@');
  sheet.getRange('D:D').setNumberFormat('0.##');
  sheet.getRange('E:F').setNumberFormat('@');

  // 데이터 일괄 입력
  const rows = Object.keys(map);
  if (rows.length > 0) {
    const writeData = rows.map(function(t) {
      const v = map[t];
      return [t, v.market, nameCache[t] || '', v.price, v.rate, v.upd];
    });
    sheet.getRange(2, 1, writeData.length, 6).setValues(writeData);
  }

  Logger.log('현재가 시트 정리 완료: ' + rows.length + '개');
  SpreadsheetApp.getUi().alert(
    '✅ 현재가 시트 정리 완료!\n\n'
    + '· 중복 제거 (총 ' + rows.length + '개 종목)\n'
    + '· ticker 0패딩 정규화\n'
    + '· 종목명(name) 컬럼 추가\n\n'
    + '이제 지금 즉시 현재가 갱신 을 실행하세요.'
  );
}

// ============================================================
// 8. 투자현황 → 종목코드 시트 일괄 동기화 (수동 실행)
// ============================================================
function syncHoldingsToTickerMaster() {
  const holdingSheet = SS.getSheetByName(SHEET.HOLDINGS);
  const masterSheet  = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!holdingSheet || !masterSheet) { SpreadsheetApp.getUi().alert('시트를 찾을 수 없습니다.'); return; }

  const holdings = holdingSheet.getDataRange().getDisplayValues();
  const masters  = masterSheet.getDataRange().getValues();
  const existingTickers = new Set(masters.slice(1).map(function(r) { return String(r[0]).trim(); }).filter(function(t) { return t; }));

  var added = 0;
  holdings.slice(1).forEach(function(row) {
    var ticker = normalizeTicker(String(row[1]||'').trim(), String(row[3]||'KR').trim());
    var name   = String(row[2]||'').trim();
    var market = String(row[3]||'KR').trim().toUpperCase();
    var sector = String(row[4]||'기타').trim();
    if (!ticker || ticker === 'CASH_KR' || ticker === 'CASH_US') return;
    if (existingTickers.has(ticker)) return;
    masterSheet.getRange(masterSheet.getLastRow() + 1, 1).setNumberFormat('@');
    masterSheet.appendRow([ticker, name, market, sector]);
    existingTickers.add(ticker);
    added++;
    Logger.log('추가: ' + ticker + ' / ' + name);
  });

  Logger.log('동기화 완료: ' + added + '개 추가');
  SpreadsheetApp.getUi().alert(
    '✅ 동기화 완료!\n\n종목코드 시트에 ' + added + '개 종목 추가됨\n\n이제 지금 즉시 현재가 갱신 을 실행하세요.'
  );
}

// ============================================================
// 9. 트리거
// ============================================================
function setupTriggers() {
  // v2 전용 GAS 프로젝트에서만 실행한다. v1 프로젝트에서는 실행 금지.
  var handlers = ['watchdogTrigger', 'updateExchangeRate', 'crawlKRXStocks', 'saveSnapshotIfNeeded', 'updateAllPrices'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('watchdogTrigger').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('updateExchangeRate').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('crawlKRXStocks').timeBased().atHour(6).everyDays(1).create();
  ScriptApp.newTrigger('saveSnapshotIfNeeded').timeBased().atHour(16).everyDays(1).create();

  try {
    SpreadsheetApp.getUi().alert(
      '✅ SSTfolio v2 트리거 설정 완료!\n\n' +
      '· watchdog: 10분마다\n' +
      '· 환율: 1시간마다\n' +
      '· KRX 종목코드: 매일 오전 6시\n' +
      '· 스냅샷: 매일 오후 4시\n\n' +
      'GAS 직접 현재가 수집 트리거는 등록하지 않았습니다.'
    );
  } catch(e) { Logger.log('v2 트리거 설정 완료'); }
}

// ============================================================
// 10. 투자현황 드롭다운 설정
// ============================================================
function setupHoldingsDropdown() {
  const holdingSheet = SS.getSheetByName(SHEET.HOLDINGS);
  const krxSheet     = SS.getSheetByName(SHEET.KRX_ONLINE);
  const acctSheet    = SS.getSheetByName(SHEET.ACCOUNTS);

  if (!holdingSheet) { SpreadsheetApp.getUi().alert('❌ 투자현황 시트 없음'); return; }
  if (!acctSheet)    { SpreadsheetApp.getUi().alert('❌ 계좌 시트 없음'); return; }

  const krxSheetName = krxSheet ? krxSheet.getName() : null;
  const lastKrxRow   = krxSheet ? Math.max(krxSheet.getLastRow(), 2) : 2;

  // A열: 계좌 드롭다운
  const acctData   = acctSheet.getDataRange().getValues();
  const acctLabels = [];
  for (var i = 1; i < acctData.length; i++) {
    const id = acctData[i][0], owner = acctData[i][1], brok = acctData[i][2], type = acctData[i][3];
    if (id === '' || id === null || id === undefined) continue;
    acctLabels.push(owner + ' · ' + brok + ' ' + type + ' (id=' + id + ')');
  }
  if (acctLabels.length === 0) { SpreadsheetApp.getUi().alert('⚠️ 계좌 시트에 데이터가 없습니다.'); return; }
  holdingSheet.getRange('A2:A300').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(acctLabels, true).setAllowInvalid(false).build()
  );

  // C열: KRX 종목명 드롭다운
  if (krxSheet) {
    holdingSheet.getRange('C2:C300').setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(krxSheet.getRange('A2:A' + lastKrxRow), true)
        .setAllowInvalid(true).build()
    );
  }

  // D열: market 드롭다운
  holdingSheet.getRange('D2:D300').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['KR', 'US'], true).build()
  );

  // B열: ticker VLOOKUP 수식 — 값이 이미 있는 셀은 건드리지 않음 (US 종목 보호)
  if (krxSheetName) {
    var bData = holdingSheet.getRange(2, 2, 299, 1).getValues();
    for (var bi = 0; bi < 299; bi++) {
      var currentVal = String(bData[bi][0] || '').trim();
      // 이미 값(수식 포함)이 있으면 건드리지 않음
      if (currentVal !== '') continue;
      var bcell = holdingSheet.getRange(bi + 2, 2);
      bcell.setNumberFormat('@');
      var r  = bi + 2;
      var kn = krxSheetName;
      var f  = '=IF(C'+r+'="","",IF(C'+r+'="예수금",IF(D'+r+'="US","CASH_US","CASH_KR"),'
             + "IFERROR(TEXT(VLOOKUP(C"+r+",'"+kn+"'!A:B,2,FALSE),\"000000\"),\"\")))"
      bcell.setFormula(f);
    }
  }

  // E열: 섹터 드롭다운
  const sectors = getSectorList();
  holdingSheet.getRange('E2:E300').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(sectors, true).setAllowInvalid(true).build()
  );

  // H열: asset_region 드롭다운
  holdingSheet.getRange('H2:H300').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['KR', 'US'], true).setAllowInvalid(false).build()
  );
  if (!holdingSheet.getRange(1, 8).getValue()) holdingSheet.getRange(1, 8).setValue('asset_region');

  SpreadsheetApp.getUi().alert(
    '✅ 설정 완료!\n\n'
    + '· A열: 계좌 드롭다운 (' + acctLabels.length + '개)\n'
    + '· B열: ticker 자동입력\n'
    + '· C열: KRX종목코드온라인 드롭다운\n'
    + '· D열: KR/US (거래통화)\n'
    + '· E열: 섹터 드롭다운\n'
    + '· F열: 수량\n'
    + '· G열: 평단가\n'
    + '· H열: KR/US (자산소재지)\n\n'
    + '💡 한국상장 미국ETF: D=KR, H=US\n'
    + '💡 예수금: C=예수금, D=KR또는US, G=금액'
  );
}

// ============================================================
// 11. KRX 종목코드 크롤링
// ============================================================
function crawlKRXStocks() {
  Logger.log('=== KRX 종목코드 갱신 시작 ' + new Date().toLocaleString('ko-KR') + ' ===');
  const allRows = [];

  // KOSPI+KOSDAQ
  const stockRows = fetchKRXFinder('dbms/comm/finder/finder_stkisu', 'ALL');
  stockRows.forEach(function(r) { allRows.push(r); });
  Logger.log('주식(KOSPI+KOSDAQ): ' + stockRows.length + '개');
  Utilities.sleep(1000);

  // ETF (네이버 etfItemList.nhn)
  const etfRows = fetchKRXETF();
  etfRows.forEach(function(r) { allRows.push(r); });
  Logger.log('ETF: ' + etfRows.length + '개');

  if (allRows.length === 0) {
    SpreadsheetApp.getUi().alert('KRX API 호출 실패\nGAS 실행 로그를 확인하세요.');
    return;
  }

  var sheet = SS.getSheetByName(SHEET.KRX_ONLINE);
  if (!sheet) { sheet = SS.insertSheet(SHEET.KRX_ONLINE); } else { sheet.clearContents(); }

  sheet.appendRow(['종목명','종목코드','시장구분']);
  sheet.getRange(1, 1, 1, 3).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange('B:B').setNumberFormat('@');
  sheet.getRange(2, 1, allRows.length, 3).setValues(allRows);

  Logger.log('=== 완료: 총 ' + allRows.length + '개 종목 저장 ===');
  // setupHoldingsDropdown은 수동 실행 (자동 호출 시 B열 ticker 덮어씀 위험)
}

function fetchKRXFinder(bld, mktsel) {
  var rows = [];
  try {
    var params = 'bld=' + encodeURIComponent(bld) + '&mktsel=' + encodeURIComponent(mktsel) + '&typeNo=0&searchText=';
    var res = UrlFetchApp.fetch('http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method: 'post', payload: params, muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
    });
    Logger.log('  ' + bld + ' HTTP ' + res.getResponseCode());
    if (res.getResponseCode() !== 200) return rows;
    var json = JSON.parse(res.getContentText('UTF-8'));
    var list = json.block1 || json.output || json.OutBlock_1 || [];
    Logger.log('  응답 건수: ' + list.length);
    list.forEach(function(item) {
      var code   = String(item.short_code || item.ISU_SRT_CD || '').trim().padStart(6, '0');
      var name   = String(item.codeName   || item.ISU_ABBRV  || item.ISU_NM || '').trim();
      var mktId  = String(item.mktId      || item.MKT_TP_NM  || '').trim();
      var market = mktId === 'STK' ? 'KOSPI' : mktId === 'KSQ' ? 'KOSDAQ' : mktId || '';
      if (code && name) rows.push([name, code, market]);
    });
  } catch(e) { Logger.log('fetchKRXFinder 오류: ' + e.message); }
  return rows;
}

function fetchKRXETF() {
  var rows = [];
  try {
    var res = UrlFetchApp.fetch('https://finance.naver.com/api/sise/etfItemList.nhn', {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/etf/' }
    });
    Logger.log('  네이버ETF HTTP ' + res.getResponseCode());
    if (res.getResponseCode() === 200) {
      var json  = JSON.parse(res.getContentText('EUC-KR'));
      var items = (json.result && json.result.etfItemList) || [];
      items.forEach(function(item) {
        var code = String(item.itemcode || '').trim().padStart(6, '0');
        var name = String(item.itemname || '').trim();
        if (code && code !== '000000' && name) rows.push([name, code, 'ETF']);
      });
      Logger.log('  네이버ETF: ' + rows.length + '개');
    }
  } catch(e) { Logger.log('fetchKRXETF 오류: ' + e.message); }
  return rows;
}

// ============================================================
// 12. 섹터 관리
// ============================================================
const DEFAULT_SECTORS = [
  '반도체','IT','바이오','자동차','2차전지','금융',
  '에너지','소재','현금성','ETF','해외ETF','로봇','전력기기','예수금','기타'
];

function getSectorList() {
  const cfg = getConfig();
  if (cfg.sectors && cfg.sectors.trim()) {
    return cfg.sectors.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
  }
  setConfig('sectors', DEFAULT_SECTORS.join(','));
  return DEFAULT_SECTORS;
}

function addSector() {
  const ui     = SpreadsheetApp.getUi();
  const result = ui.prompt('섹터 추가', '추가할 섹터명을 입력하세요:', ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;
  const newSector = result.getResponseText().trim();
  if (!newSector) { ui.alert('섹터명을 입력해주세요.'); return; }
  const current = getSectorList();
  if (current.includes(newSector)) { ui.alert('이미 존재하는 섹터입니다: ' + newSector); return; }
  current.push(newSector);
  setConfig('sectors', current.join(','));
  setupHoldingsDropdown();
}

function manageSectors() {
  const ui      = SpreadsheetApp.getUi();
  const sectors = getSectorList();
  const msg     = '현재 섹터 목록 (' + sectors.length + '개):\n\n'
                + sectors.map(function(s, i) { return (i+1) + '. ' + s; }).join('\n')
                + '\n\n삭제할 섹터 번호를 입력하세요 (취소: 빈칸):';
  const result  = ui.prompt('섹터 관리', msg, ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;
  const input = result.getResponseText().trim();
  if (!input) return;
  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= sectors.length) { ui.alert('올바른 번호를 입력해주세요.'); return; }
  const removed = sectors.splice(idx, 1)[0];
  setConfig('sectors', sectors.join(','));
  setupHoldingsDropdown();
  ui.alert('섹터 삭제 완료: ' + removed);
}

// ============================================================
// 13. 자산소재지 자동입력
// ============================================================
function autoFillAssetRegion() {
  const sheet = SS.getSheetByName(SHEET.HOLDINGS);
  const data  = sheet.getDataRange().getValues();
  const FOREIGN_KEYWORDS = [
    '미국','나스닥','nasdaq','s&p','sp500','달러','해외','차이나','중국',
    '일본','인도','유럽','글로벌','선진국','신흥국','msci','필라델피아',
    '미국채','하이일드','빅테크','etf'
  ];
  if (!data[0][7]) sheet.getRange(1, 8).setValue('asset_region');
  sheet.getRange('H:H').setNumberFormat('@');
  var filled = 0;
  for (var i = 1; i < data.length; i++) {
    const ticker = String(data[i][1] || '').trim();
    const name   = String(data[i][2] || '').toLowerCase();
    const market = String(data[i][3] || 'KR').toUpperCase();
    const curr   = String(data[i][7] || '').trim();
    if (!ticker || curr === 'KR' || curr === 'US') continue;
    var region = 'KR';
    if (ticker === 'CASH_US' || market === 'US') {
      region = 'US';
    } else if (/^\d{6}$/.test(ticker)) {
      region = FOREIGN_KEYWORDS.some(function(kw) { return name.includes(kw); }) ? 'US' : 'KR';
    } else if (/^[A-Z]/.test(ticker)) {
      region = 'US';
    }
    sheet.getRange(i + 1, 8).setValue(region);
    filled++;
  }
  sheet.getRange('H2:H300').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['KR', 'US'], true).setAllowInvalid(false).build()
  );
  SpreadsheetApp.getUi().alert(
    '✅ 자산소재지 자동입력 완료!\n\n' + filled + '개 종목에 asset_region 입력됨\n\n'
    + '⚠️ 자동 추론이므로 오류가 있을 수 있습니다.\n확인 후 잘못된 항목은 수동으로 수정하세요.'
  );
}

// ============================================================
// 14. 메뉴
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📈 주식관리')
    // ── 핵심 갱신 ─────────────────────────────────────────
    .addItem('⚡ 지금 즉시 현재가 갱신',     'updateAllPrices')
    .addItem('🐕 Watchdog 트리거 등록',       'registerWatchdogTrigger')
    .addItem('🕐 환율 트리거 등록 (1시간)',    'registerExchangeRateTrigger')
    .addItem('🔄 전체 재정비 (이상 시 최강)', 'refreshAll')
    .addItem('📸 추이 스냅샷 지금 저장',     'saveSnapshot')
    .addSeparator()
    // ── 시트 관리 ─────────────────────────────────────────
    .addItem('🎨 투자현황 계좌별 색상 구분', 'colorHoldingsByAccount')
    .addItem('📋 투자현황 드롭다운 설정',    'setupHoldingsDropdown')
    .addItem('🔧 투자현황 ticker 복원',      'restoreHoldingTickers')
    .addItem('🛠️ 투자현황 account_id 정비', 'normalizeHoldingAccountIds')
    .addItem('🧹 적립계획 중복컬럼 정리',     'cleanupPlanSheet')
    .addItem('🔢 적립계획 ticker 정규화',     'fixPlanTickers')
    .addItem('🔃 KRX 종목코드 지금 갱신',   'crawlKRXStocks')
    .addItem('🧹 현재가 시트 정리',          'cleanupPricesSheet')
    .addSeparator()
    // ── 시스템 ────────────────────────────────────────────
    .addItem('⚙️ 트리거 재설정',             'setupTriggers')
    .addItem('🔗 웹앱 URL 확인',             'showWebAppUrl')
    .addItem('☁️ Cloudflare 연동 설정',      'showCloudflareSetup')
    .addToUi();
}


// ============================================================
// 종목코드 시트 ticker 0패딩 정규화 (KR 종목 6자리)
// ============================================================
function normalizeTickerMasterSheet() {
  const sheet  = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!sheet) { SpreadsheetApp.getUi().alert('종목코드 시트 없음'); return; }
  const data   = sheet.getDataRange().getValues();
  var fixed = 0;
  for (var i = 1; i < data.length; i++) {
    const ticker = String(data[i][0] || '').trim();
    const market = String(data[i][2] || '').trim().toUpperCase();
    if (!ticker) continue;
    const normalized = normalizeTicker(ticker, market || 'KR');
    if (normalized !== ticker) {
      sheet.getRange(i + 1, 1).setNumberFormat('@').setValue(normalized);
      Logger.log('정규화: ' + ticker + ' → ' + normalized);
      fixed++;
    }
  }

  // 현재가 시트도 함께 정규화
  const pSheet = SS.getSheetByName(SHEET.PRICES);
  if (pSheet) {
    const pData = pSheet.getDataRange().getValues();
    for (var j = 1; j < pData.length; j++) {
      const ticker = String(pData[j][0] || '').trim();
      const market = String(pData[j][1] || '').trim().toUpperCase();
      if (!ticker) continue;
      const normalized = normalizeTicker(ticker, market || 'KR');
      if (normalized !== ticker) {
        pSheet.getRange(j + 1, 1).setNumberFormat('@').setValue(normalized);
        Logger.log('현재가 정규화: ' + ticker + ' → ' + normalized);
        fixed++;
      }
    }
  }

  // 투자현황 B열도 함께 정규화
  const hSheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (hSheet) {
    const hData = hSheet.getDataRange().getValues();
    for (var k = 1; k < hData.length; k++) {
      const ticker = String(hData[k][1] || '').trim();
      const market = String(hData[k][3] || '').trim().toUpperCase();
      if (!ticker) continue;
      const normalized = normalizeTicker(ticker, market || 'KR');
      if (normalized !== ticker) {
        hSheet.getRange(k + 1, 2).setNumberFormat('@').setValue(normalized);
        Logger.log('투자현황 정규화: ' + ticker + ' → ' + normalized);
        fixed++;
      }
    }
  }

  Logger.log('=== 정규화 완료: ' + fixed + '개 수정 ===');
  SpreadsheetApp.getUi().alert(
    '✅ ticker 0패딩 정규화 완료!\n\n'
    + fixed + '개 수정됨\n\n'
    + '이제 지금 즉시 현재가 갱신 을 실행하세요.'
  );
}

// ============================================================
// 투자현황 시트 계좌별 행 색상 구분
// ============================================================
function colorHoldingsByAccount() {
  const sheet = SS.getSheetByName(SHEET.HOLDINGS);
  if (!sheet) { SpreadsheetApp.getUi().alert('투자현황 시트 없음'); return; }

  const lastRow = sheet.getLastRow();
  const lastCol = 8; // A~H
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('데이터 없음'); return; }

  // 계좌별 색상 팔레트 (배경색 / 글자색)
  const PALETTE = [
    { bg: '#1a2744', fg: '#79b8ff' },
    { bg: '#1a3a2a', fg: '#85e89d' },
    { bg: '#3a1a2a', fg: '#f97583' },
    { bg: '#2a2a1a', fg: '#e3b341' },
    { bg: '#2a1a3a', fg: '#b392f0' },
    { bg: '#1a3a3a', fg: '#79c0ff' },
    { bg: '#3a2a1a', fg: '#ffa657' },
    { bg: '#1a1a3a', fg: '#d2a8ff' },
    { bg: '#2a3a1a', fg: '#a8cc88' },
    { bg: '#3a1a1a', fg: '#ff7b72' },
    { bg: '#1a2a3a', fg: '#58a6ff' },
    { bg: '#2a1a1a', fg: '#ffa8a8' },
  ];

  // A열 displayValues로 읽기 (드롭다운 수식 결과값 포함)
  const data = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();

  // 계좌 key 추출 함수
  function extractKey(raw) {
    raw = String(raw || '').trim();
    if (!raw) return null;
    var m = raw.match(/id=(\d+)/);
    return m ? m[1] : raw;
  }

  // 계좌 순서대로 색상 배정
  const acctOrder = [];
  const acctColorMap = {};
  data.forEach(function(row) {
    var key = extractKey(row[0]);
    if (!key) return;
    if (!acctColorMap[key]) {
      acctColorMap[key] = PALETTE[acctOrder.length % PALETTE.length];
      acctOrder.push(key);
    }
  });

  Logger.log('계좌 수: ' + acctOrder.length + '개');

  // 전체 테두리 초기화 + 배경/글자색 초기화
  sheet.getRange(2, 1, lastRow - 1, lastCol)
    .setBackground(null)
    .setFontColor(null)
    .setBorder(false, false, false, false, false, false);

  // 행별 색상 배열 구성 (setValues로 일괄 적용)
  var bgMatrix = [];
  var fgMatrix = [];
  for (var i = 0; i < data.length; i++) {
    var key   = extractKey(data[i][0]);
    var color = key && acctColorMap[key] ? acctColorMap[key] : { bg: null, fg: null };
    var bgRow = [];
    var fgRow = [];
    for (var c = 0; c < lastCol; c++) {
      bgRow.push(color.bg);
      fgRow.push(color.fg);
    }
    bgMatrix.push(bgRow);
    fgMatrix.push(fgRow);
  }
  sheet.getRange(2, 1, lastRow - 1, lastCol).setBackgrounds(bgMatrix).setFontColors(fgMatrix);

  SpreadsheetApp.getUi().alert(
    '✅ 색상 구분 완료!\n\n' + acctOrder.length + '개 계좌에 색상 적용됨\n\n'
    + '새로운 종목 추가 후 다시 실행하면 갱신됩니다.'
  );
}


// ============================================================
// 전체 갱신 (투자현황 시트 버튼에서 호출)
// ============================================================
function refreshAll() {
  const ss = getSpreadsheet_();

  ss.toast('1/6 ticker 복원 중...', '⏳ 전체 재정비', -1);
  restoreHoldingTickers_silent();

  ss.toast('2/6 종목코드 동기화 중...', '⏳ 전체 재정비', -1);
  syncHoldingsToTickerMaster_silent();

  ss.toast('3/6 ticker 정규화 중...', '⏳ 전체 재정비', -1);
  normalizeTickerMasterSheet_silent();

  ss.toast('4/6 KV 캐시 초기화 중...', '⏳ 전체 재정비', -1);
  const connection = getV2ConnectionConfig_();
  const workerUrl = connection.workerUrl;
  const secret    = connection.secret;
  if (workerUrl && secret) {
    try {
      UrlFetchApp.fetch(workerUrl + '/api/cache-clear', {
        method: 'post', muteHttpExceptions: true,
        headers: { 'Content-Type': 'application/json', 'X-Sstfolio-Secret': secret },
      });
      Logger.log('KV 캐시 삭제 완료');
    } catch(e) { Logger.log('KV 삭제 실패(무시): ' + e.message); }
  }

  ss.toast('5/6 현재가 갱신 + KV 재저장 중...', '⏳ 전체 재정비', -1);
  updateAllPrices();

  ss.toast('6/6 색상 적용 중...', '⏳ 전체 재정비', -1);
  colorHoldingsByAccount();

  ss.toast('완료! 웹사이트를 새로고침하세요.', '✅ 전체 재정비', 8);
}

// restoreHoldingTickers silent 버전 (alert 없이)
function restoreHoldingTickers_silent() {
  var holdingSheet = SS.getSheetByName(SHEET.HOLDINGS);
  var masterSheet  = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!holdingSheet || !masterSheet) return;
  var masterData = masterSheet.getDataRange().getValues();
  var nameToTicker = {};
  for (var i = 1; i < masterData.length; i++) {
    var t = String(masterData[i][0] || '').trim();
    var n = String(masterData[i][2] || '').trim();
    if (t) nameToTicker[n.toLowerCase()] = t;
  }
  var holdingData = holdingSheet.getDataRange().getValues();
  for (var r = 1; r < holdingData.length; r++) {
    var ticker = String(holdingData[r][1] || '').trim();
    var name   = String(holdingData[r][2] || '').trim();
    if (!ticker && name) {
      var found = nameToTicker[name.toLowerCase()];
      if (!found && /^[A-Z0-9]+$/.test(name)) found = name.toUpperCase();
      if (found) holdingSheet.getRange(r + 1, 2).setValue(found);
    }
  }
}

// silent 버전 — alert 없이 실행
function syncHoldingsToTickerMaster_silent() {
  const holdingSheet = SS.getSheetByName(SHEET.HOLDINGS);
  const masterSheet  = SS.getSheetByName(SHEET.TICKER_MASTER);
  if (!holdingSheet || !masterSheet) return;
  const holdings = holdingSheet.getDataRange().getDisplayValues();
  const masters  = masterSheet.getDataRange().getValues();
  const existingTickers = new Set(
    masters.slice(1).map(function(r) { return String(r[0]).trim(); }).filter(function(t) { return t; })
  );
  holdings.slice(1).forEach(function(row) {
    var ticker = normalizeTicker(String(row[1]||'').trim(), String(row[3]||'KR').trim());
    var name   = String(row[2]||'').trim();
    var market = String(row[3]||'KR').trim().toUpperCase();
    var sector = String(row[4]||'기타').trim();
    if (!ticker || ticker === 'CASH_KR' || ticker === 'CASH_US') return;
    if (existingTickers.has(ticker)) return;
    masterSheet.getRange(masterSheet.getLastRow() + 1, 1).setNumberFormat('@');
    masterSheet.appendRow([ticker, name, market, sector]);
    existingTickers.add(ticker);
  });
}

function normalizeTickerMasterSheet_silent() {
  var sheets = [
    { sheet: SS.getSheetByName(SHEET.TICKER_MASTER), tickerCol: 1, marketCol: 3 },
    { sheet: SS.getSheetByName(SHEET.PRICES),        tickerCol: 1, marketCol: 2 },
    { sheet: SS.getSheetByName(SHEET.HOLDINGS),      tickerCol: 2, marketCol: 4 },
  ];
  sheets.forEach(function(s) {
    if (!s.sheet) return;
    var data = s.sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var ticker = String(data[i][s.tickerCol - 1] || '').trim();
      var market = String(data[i][s.marketCol - 1] || '').trim().toUpperCase();
      if (!ticker) continue;
      var normalized = normalizeTicker(ticker, market || 'KR');
      if (normalized !== ticker) {
        s.sheet.getRange(i + 1, s.tickerCol).setNumberFormat('@').setValue(normalized);
      }
    }
  });
}

// 투자현황 시트에 [전체 갱신] 버튼 삽입 (최초 1회 실행)

// 버튼 생성 안내
function insertRefreshButton() {
  SpreadsheetApp.getUi().alert(
    '[ 전체 갱신 버튼 만들기 ]\n\n'
    + '1. 투자현황 시트 탭 클릭\n'
    + '2. 상단 메뉴 -> 삽입 -> 그림\n'
    + '3. 도형 아이콘 선택 -> 사각형 그리기\n'
    + '4. 텍스트 입력: 전체 갱신\n'
    + '5. 저장 후 닫기\n'
    + '6. 도형 선택 -> 점3개 메뉴 -> 스크립트 할당\n'
    + '7. refreshAll 입력 -> 확인\n\n'
    + '이후 버튼 클릭 시 모든 갱신이 자동 실행됩니다.'
  );
}
function showCloudflareSetup() {
  const connection = getV2ConnectionConfig_();
  const workerUrl = connection.workerUrl || '(미설정)';
  const secret = connection.secret ? '****' + connection.secret.slice(-4) : '(미설정)';
  SpreadsheetApp.getUi().alert(
    '[ SSTfolio v2 Cloudflare 연동 설정 ]\n\n'
    + 'Apps Script 프로젝트 설정 > Script Properties에 아래 값을 등록하세요:\n\n'
    + 'WORKER_URL = https://REPLACE_WITH_V2_WORKER_URL\n'
    + 'SSTFOLIO_SECRET = (Worker와 동일한 비밀 문자열)\n\n'
    + '현재 설정:\n'
    + 'WORKER_URL: ' + workerUrl + '\n'
    + 'SSTFOLIO_SECRET: ' + secret
  );
}

function showWebAppUrl() {
  try {
    const url = ScriptApp.getService().getUrl();
    SpreadsheetApp.getUi().alert('웹앱 URL:\n\n' + url + '\n\n이 URL을 웹사이트 설정 탭에 붙여넣으세요.');
  } catch(e) {
    SpreadsheetApp.getUi().alert('웹앱을 먼저 배포해야 URL이 생성됩니다.');
  }
}

// ============================================================
// 배당내역 시트 마이그레이션 (owner 컬럼 추가)
// ============================================================
function migrateDividendSheet() {
  const sheet = SS.getSheetByName(SHEET.DIVIDEND);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('배당내역 시트가 없습니다.');
    return;
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h) { return String(h).trim(); });

  // 이미 마이그레이션 됐는지 확인
  if (headers.indexOf('owner') >= 0) {
    SpreadsheetApp.getUi().alert('이미 owner 컬럼이 있습니다. 마이그레이션 불필요합니다.');
    return;
  }

  // account_id 다음(D열=인덱스3) 뒤에 owner 열 삽입
  const insertCol = 4; // D열 = 4번째
  sheet.insertColumnAfter(3); // C열(account_id) 뒤에 삽입

  // 헤더 설정
  sheet.getRange(1, insertCol).setValue('owner');
  sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');

  // 기존 account_name(이제 E열=5번째)에서 owner 분리
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('✅ owner 컬럼 추가 완료! (데이터 없음)');
    return;
  }

  // E열(account_name) 값 읽기
  const acctNameCol = 5; // E열
  const acctNames   = sheet.getRange(2, acctNameCol, lastRow - 1, 1).getValues();

  const owners     = [];
  const newAcctNames = [];

  acctNames.forEach(function(row) {
    const val  = String(row[0] || '').trim();
    const sep  = val.indexOf(' · ');
    if (sep >= 0) {
      owners.push([val.substring(0, sep).trim()]);
      newAcctNames.push([val.substring(sep + 3).trim()]);
    } else {
      owners.push([val]);
      newAcctNames.push([val]);
    }
  });

  // owner 컬럼 값 입력
  sheet.getRange(2, insertCol, lastRow - 1, 1).setValues(owners);

  // account_name 컬럼 값 업데이트 (소유자 부분 제거)
  sheet.getRange(2, acctNameCol, lastRow - 1, 1).setValues(newAcctNames);

  // 컬럼 너비 정리
  sheet.setColumnWidth(1, 50);   // id
  sheet.setColumnWidth(2, 100);  // date
  sheet.setColumnWidth(3, 80);   // account_id
  sheet.setColumnWidth(4, 80);   // owner
  sheet.setColumnWidth(5, 120);  // account_name
  sheet.setColumnWidth(6, 100);  // ticker
  sheet.setColumnWidth(7, 200);  // name
  sheet.setColumnWidth(8, 100);  // amount
  sheet.setColumnWidth(9, 150);  // memo

  SpreadsheetApp.getUi().alert(
    '✅ 마이그레이션 완료!\n\n'
    + '· owner 컬럼 추가 (D열)\n'
    + '· account_name에서 소유자 분리\n'
    + '· ' + (lastRow - 1) + '개 행 처리 완료'
  );
}
// ============================================================
// 입출금 관리
// ============================================================
// 입출금 시트 컬럼: id, date, account_id, account_name, amount, memo

function getCashflowSheet() {
  var sheet = SS.getSheetByName(SHEET.CASHFLOW);
  if (!sheet) {
    sheet = SS.insertSheet(SHEET.CASHFLOW);
    sheet.appendRow(['id','date','account_id','account_name','amount','memo']);
    sheet.getRange(1,1,1,6).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setColumnWidth(1, 50);
    sheet.setColumnWidth(2, 100);
    sheet.setColumnWidth(3, 80);
    sheet.setColumnWidth(4, 150);
    sheet.setColumnWidth(5, 120);
    sheet.setColumnWidth(6, 250);
  }
  return sheet;
}

function getCashflow(e) {
  var params     = (e && e.parameter) || {};
  var fromDate   = params.from       || '';
  var toDate     = params.to         || '';
  var accountId  = params.account_id || '';

  var sheet = getCashflowSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows: [] };

  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    headers.forEach(function(h, j) { row[h] = data[i][j]; });
    var dateStr = row.date ? Utilities.formatDate(new Date(row.date), 'Asia/Seoul', 'yyyy-MM-dd') : '';
    if (fromDate && dateStr < fromDate) continue;
    if (toDate   && dateStr > toDate)   continue;
    if (accountId && String(row.account_id) !== accountId) continue;
    row.date   = dateStr;
    row.amount = Number(row.amount) || 0;
    rows.push(row);
  }
  return { rows: rows };
}

function addCashflow(data) {
  if (!data.date || !data.account_id || !data.amount) {
    return { error: '날짜, 계좌, 금액은 필수입니다' };
  }
  var sheet = getCashflowSheet();
  var rows  = sheet.getDataRange().getValues();
  var maxId = 0;
  for (var i = 1; i < rows.length; i++) {
    var id = parseInt(rows[i][0]) || 0;
    if (id > maxId) maxId = id;
  }
  var newId = maxId + 1;
  sheet.appendRow([
    newId,
    String(data.date         || ''),
    String(data.account_id   || ''),
    String(data.account_name || ''),
    Number(data.amount)      || 0,
    String(data.memo         || ''),
  ]);
  return { ok: true, id: newId };
}

function deleteCashflow(data) {
  var targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };
  var sheet = getCashflowSheet();
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === targetId) {
      sheet.deleteRow(i + 1);
      return { ok: true, id: targetId };
    }
  }
  return { error: '해당 입출금 내역 없음: ' + targetId };
}

function updateCashflow(data) {
  var targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };
  var sheet = getCashflowSheet();
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === targetId) {
      sheet.getRange(i + 1, 2).setValue(String(data.date         || ''));
      sheet.getRange(i + 1, 3).setValue(String(data.account_id   || ''));
      sheet.getRange(i + 1, 4).setValue(String(data.account_name || ''));
      sheet.getRange(i + 1, 5).setValue(Number(data.amount)      || 0);
      sheet.getRange(i + 1, 6).setValue(String(data.memo         || ''));
      return { ok: true, id: targetId };
    }
  }
  return { error: '해당 입출금 내역 없음: ' + targetId };
}

// ============================================================
// 외부자산 관리
// ============================================================
// 외부자산 시트 컬럼: id, account_id, account_name, name, amount, memo

function getExternalAssetSheet() {
  var sheet = SS.getSheetByName(SHEET.EXTERNAL_ASSET);
  if (!sheet) {
    sheet = SS.insertSheet(SHEET.EXTERNAL_ASSET);
    sheet.appendRow(['id','account_id','account_name','name','amount','memo']);
    sheet.getRange(1,1,1,6).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setColumnWidth(1, 50);
    sheet.setColumnWidth(2, 80);
    sheet.setColumnWidth(3, 150);
    sheet.setColumnWidth(4, 200);
    sheet.setColumnWidth(5, 120);
    sheet.setColumnWidth(6, 250);
  }
  return sheet;
}

function getExternalAsset(e) {
  var params    = (e && e.parameter) || {};
  var accountId = params.account_id  || '';

  var sheet = getExternalAssetSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { rows: [] };

  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    headers.forEach(function(h, j) { row[h] = data[i][j]; });
    if (accountId && String(row.account_id) !== accountId) continue;
    row.amount = Number(row.amount) || 0;
    rows.push(row);
  }
  return { rows: rows };
}

function addExternalAsset(data) {
  if (!data.name || !data.amount) {
    return { error: '자산명, 금액은 필수입니다' };
  }
  var sheet = getExternalAssetSheet();
  var rows  = sheet.getDataRange().getValues();
  var maxId = 0;
  for (var i = 1; i < rows.length; i++) {
    var id = parseInt(rows[i][0]) || 0;
    if (id > maxId) maxId = id;
  }
  var newId = maxId + 1;
  sheet.appendRow([
    newId,
    String(data.account_id   || ''),
    String(data.account_name || ''),
    String(data.name         || ''),
    Number(data.amount)      || 0,
    String(data.memo         || ''),
  ]);
  return { ok: true, id: newId };
}

function deleteExternalAsset(data) {
  var targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };
  var sheet = getExternalAssetSheet();
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === targetId) {
      sheet.deleteRow(i + 1);
      return { ok: true, id: targetId };
    }
  }
  return { error: '해당 외부자산 없음: ' + targetId };
}

function updateExternalAsset(data) {
  var targetId = String(data.id || '').trim();
  if (!targetId) return { error: 'id 필요' };
  var sheet = getExternalAssetSheet();
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === targetId) {
      sheet.getRange(i + 1, 2).setValue(String(data.account_id   || ''));
      sheet.getRange(i + 1, 3).setValue(String(data.account_name || ''));
      sheet.getRange(i + 1, 4).setValue(String(data.name         || ''));
      sheet.getRange(i + 1, 5).setValue(Number(data.amount)      || 0);
      sheet.getRange(i + 1, 6).setValue(String(data.memo         || ''));
      return { ok: true, id: targetId };
    }
  }
  return { error: '해당 외부자산 없음: ' + targetId };
}

function fixMissingPrices() {
  // v2에서는 개별 종목마다 GAS에서 가격을 조회하지 않고 한 번의 긴급 전체 수집을 요청한다.
  return requestPriceRefresh_('emergency_full', 'gas_fixMissingPrices');
}

function testChangeRate() {
  Logger.log('SSTfolio v2: GAS 직접 시세 테스트는 비활성입니다. GitHub Actions 로그를 확인하세요.');
}

function testNaverOne() {
  Logger.log('SSTfolio v2: GAS 직접 네이버 테스트는 비활성입니다. GitHub Actions를 수동 실행하세요.');
}

function testGetSale() {
  var result = getSale(null);
  Logger.log('총 rows: ' + result.rows.length);
  result.rows.slice(-5).forEach(function(r) {
    Logger.log(r.id + ' | ' + r.date + ' | ' + r.ticker + ' | tags: ' + r.tags);
  });
}

function testTes() {
  Logger.log('SSTfolio v2: GAS 직접 시세 테스트는 비활성입니다.');
}

function testTesTicker() {
  var sheet = getSpreadsheet_().getSheetByName('투자현황');
  var data = sheet.getDataRange().getValues();
  // 테스 행 찾기
  data.forEach(function(row, i) {
    if (String(row[2]).includes('테스') || String(row[1]).includes('95610')) {
      Logger.log('행 ' + (i+1) + ': ticker raw=' + JSON.stringify(row[1]) + 
                 ' type=' + typeof row[1]);
    }
  });
}

function testTesRaw() {
  var holdings = getHoldings();
  holdings.forEach(function(h) {
    if (String(h.ticker).includes('95610') || String(h.name).includes('테스')) {
      Logger.log(JSON.stringify(h));
    }
  });
}

function testTesPortfolio() {
  var result = getPortfolio();
  result.holdings.forEach(function(h) {
    if (String(h.ticker).includes('95610') || String(h.name).includes('테스')) {
      Logger.log(JSON.stringify(h));
    }
  });
}