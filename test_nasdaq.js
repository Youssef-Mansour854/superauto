const fs = require('fs');
const path = require('path');
const axios = require('axios');

function getApiKey() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^\s*TWELVEDATA_API_KEY\s*=\s*(.*)$/);
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return process.env.TWELVEDATA_API_KEY || 'demo';
}

const apiKey = getApiKey();
const symbols = ['^IXIC', 'IXIC', 'NDX'];
const outputFile = path.join(__dirname, 'test_nasdaq_output.txt');

fs.writeFileSync(outputFile, '=== TWELVE DATA NASDAQ SYMBOL TEST ===\n\n');

function appendLog(text) {
  console.log(text);
  fs.appendFileSync(outputFile, text + '\n');
}

async function testSymbol(symbol) {
  appendLog(`====================================================`);
  appendLog(`Testing Symbol: "${symbol}"`);
  appendLog(`====================================================`);

  // 1. Quote endpoint
  try {
    appendLog(`[1] Fetching Quote for "${symbol}"...`);
    const quoteRes = await axios.get('https://api.twelvedata.com/quote', {
      params: { symbol, apikey: apiKey },
      timeout: 10000,
      validateStatus: () => true
    });
    appendLog(`Quote HTTP Status: ${quoteRes.status}`);
    appendLog(`Quote Response: ${JSON.stringify(quoteRes.data, null, 2)}`);
  } catch (err) {
    appendLog(`Quote Error: ${err.message}`);
  }

  // 2. Time Series 5min endpoint
  try {
    appendLog(`\n[2] Fetching 5min Time Series for "${symbol}"...`);
    const tsRes = await axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol, interval: '5min', outputsize: 5, apikey: apiKey },
      timeout: 10000,
      validateStatus: () => true
    });
    appendLog(`Time Series HTTP Status: ${tsRes.status}`);
    appendLog(`Time Series Response: ${JSON.stringify(tsRes.data, null, 2)}`);
  } catch (err) {
    appendLog(`Time Series Error: ${err.message}`);
  }

  // 3. Symbol search
  try {
    appendLog(`\n[3] Searching Symbol info for "${symbol}"...`);
    const searchRes = await axios.get('https://api.twelvedata.com/symbol_search', {
      params: { symbol, apikey: apiKey },
      timeout: 10000,
      validateStatus: () => true
    });
    appendLog(`Symbol Search HTTP Status: ${searchRes.status}`);
    appendLog(`Symbol Search Response: ${JSON.stringify(searchRes.data, null, 2)}`);
  } catch (err) {
    appendLog(`Symbol Search Error: ${err.message}`);
  }

  appendLog('\n');
}

async function main() {
  for (const s of symbols) {
    await testSymbol(s);
  }
  appendLog('=== TEST COMPLETED ===');
}

main().catch(err => {
  appendLog(`FATAL: ${err.stack || err}`);
});
