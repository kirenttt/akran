const http = require('http');
const https = require('https');

const B24_WEBHOOK = 'https://maxiprom124.bitrix24.ru/rest/179/fzs7x4e5vv9q9rex';
const PORT = 3000;

function b24Request(path, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const url = new URL(B24_WEBHOOK + path);
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
        catch (e) { reject(e); }
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
    // Find end of headers
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headers = buffer.slice(pos, headerEnd).toString('utf8');

    // Find end of this part
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
    // Skip \r\n after boundary or -- (end marker)
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
    pos += 2; // skip \r\n
  }

  return { fields, files };
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
      console.log('Fields:', Object.keys(fields));
      console.log('Files:', Object.keys(files));

      const name    = fields['fields[NAME]'] || '';
      const phone   = fields['fields[PHONE][0][VALUE]'] || '';
      const email   = fields['fields[EMAIL][0][VALUE]'] || '';
      const company = fields['fields[COMPANY_TITLE]'] || '';
      const comment = fields['fields[COMMENTS]'] || '';

      const leadParams = {
        fields: {
          TITLE: 'Заявка с сайта АКРАН',
          NAME: name,
          PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
          EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }],
          SOURCE_ID: 'WEB',
          SOURCE_DESCRIPTION: 'Сайт АКРАН — akran.ru',
        }
      };
      if (company) leadParams.fields.COMPANY_TITLE = company;
      if (comment) leadParams.fields.COMMENTS = comment;

      console.log('Creating lead for:', name, phone);
      const leadResult = await b24Request('/crm.lead.add.json', leadParams);
      console.log('Lead result:', JSON.stringify(leadResult));

      if (!leadResult.result) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to create lead', detail: leadResult }));
        return;
      }

      const leadId = leadResult.result;

      // Upload file if present
      const fileKey = Object.keys(files)[0];
      if (fileKey) {
        const file = files[fileKey];
        console.log('Uploading file:', file.filename, file.data.length, 'bytes');
        const base64 = file.data.toString('base64');

        const fileResult = await b24Request('/crm.lead.update.json', {
          id: leadId,
          fields: {
            UF_CRM_1781144284968: {
              fileData: [file.filename, base64]
            }
          }
        });
        console.log('File result:', JSON.stringify(fileResult));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, leadId }));

    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
