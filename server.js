const http = require('http');
const https = require('https');

const B24_WEBHOOK = 'https://maxiprom124.bitrix24.ru/rest/179/fzs7x4e5vv9q9rex';
const PORT = 3000;

function b24Request(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const url = new URL(B24_WEBHOOK + '/' + method + '.json');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = {};
  const sep = Buffer.from('\r\n--' + boundary);
  const start = Buffer.from('--' + boundary + '\r\n');

  let pos = buffer.indexOf(start);
  if (pos === -1) return { fields, files };
  pos += start.length;

  while (pos < buffer.length) {
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headers = buffer.slice(pos, headerEnd).toString('utf8');

    const nextBoundary = buffer.indexOf(sep, headerEnd + 4);
    const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary;
    const data = buffer.slice(headerEnd + 4, dataEnd);

    const nameMatch = headers.match(/name="([^"]+)"/i);
    const filenameMatch = headers.match(/filename="([^"]+)"/i);
    const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        files[name] = {
          filename: filenameMatch[1],
          contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
          data: data,
        };
      } else {
        fields[name] = data.toString('utf8');
      }
    }

    if (nextBoundary === -1) break;
    pos = nextBoundary + sep.length;
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
    pos += 2;
  }

  return { fields, files };
}

// Вспомогательная функция: ищет поле по нескольким возможным именам
function getField(fields, ...keys) {
  for (const key of keys) {
    if (fields[key] !== undefined && fields[key] !== '') return fields[key];
  }
  return '';
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} origin=${req.headers.origin || '-'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/lead') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      console.log('Content-Type:', contentType);
      console.log('Body size:', buffer.length);

      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
        return;
      }

      const { fields, files } = parseMultipart(buffer, boundaryMatch[1].trim());
      console.log('Fields received:', JSON.stringify(Object.keys(fields)));
      console.log('All field values:', JSON.stringify(fields));
      console.log('Files received:', JSON.stringify(Object.keys(files)));

      // Ищем поля по нескольким вариантам имён — на случай разного кодирования браузером
      const name    = getField(fields, 'fields[NAME]',            'fields%5BNAME%5D',            'NAME');
      const phone   = getField(fields, 'fields[PHONE][0][VALUE]', 'fields%5BPHONE%5D%5B0%5D%5BVALUE%5D', 'PHONE');
      const email   = getField(fields, 'fields[EMAIL][0][VALUE]', 'fields%5BEMAIL%5D%5B0%5D%5BVALUE%5D', 'EMAIL');
      const company = getField(fields, 'fields[COMPANY_TITLE]',   'fields%5BCOMPANY_TITLE%5D',   'COMPANY_TITLE');
      const comment = getField(fields, 'fields[COMMENTS]',        'fields%5BCOMMENTS%5D',        'COMMENTS');

      console.log('Parsed → name:', name, '| phone:', phone, '| email:', email, '| company:', company);

      // Шаг 1: создаём контакт
      const contactFields = { NAME: name, SOURCE_ID: 'WEB' };
      if (phone)   contactFields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }];
      if (email)   contactFields.EMAIL = [{ VALUE: email, VALUE_TYPE: 'WORK' }];
      if (company) contactFields.COMPANY_TITLE = company;

      console.log('Creating contact...');
      const contactResult = await b24Request('crm.contact.add', { fields: contactFields });
      console.log('Contact result:', JSON.stringify(contactResult));
      const contactId = contactResult.result || null;

      // Шаг 2: создаём сделку
      let dealTitle = 'Заявка с сайта АКРАН';
      if (name)    dealTitle += ' — ' + name;
      if (company) dealTitle += ' (' + company + ')';

      let fullComment = '';
      if (company) fullComment += 'Компания: ' + company + '\n';
      if (comment) fullComment += comment;

      const dealFields = {
        TITLE: dealTitle,
        SOURCE_ID: 'WEB',
        SOURCE_DESCRIPTION: 'Сайт АКРАН — akran.ru',
      };
      if (contactId)          dealFields.CONTACT_ID = contactId;
      if (fullComment.trim()) dealFields.COMMENTS   = fullComment.trim();

      console.log('Creating deal...');
      const dealResult = await b24Request('crm.deal.add', { fields: dealFields });
      console.log('Deal result:', JSON.stringify(dealResult));

      if (!dealResult.result) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to create deal', detail: dealResult }));
        return;
      }

      const dealId = dealResult.result;

      // Шаг 3: прикрепляем файл
      const fileKey = Object.keys(files)[0];
      if (fileKey) {
        const file = files[fileKey];
        console.log('Uploading file:', file.filename, file.data.length, 'bytes');
        const base64 = file.data.toString('base64');
        const fileResult = await b24Request('crm.deal.update', {
          id: dealId,
          fields: { UF_CRM_1769057513043: { fileData: [file.filename, base64] } }
        });
        console.log('File result:', JSON.stringify(fileResult));
      }

      console.log('Success! dealId:', dealId, 'contactId:', contactId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dealId, contactId }));

    } catch (err) {
      console.error('Error:', err.message, err.stack);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on port 3000`);
});
