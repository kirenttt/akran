const http = require('http');
const https = require('https');

const B24_WEBHOOK = 'https://maxiprom124.bitrix24.ru/rest/179/fzs7x4e5vv9q9rex';
const PORT = 3000;

// Simple CORS + JSON request helper
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

// Parse multipart/form-data manually (no dependencies)
function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];

  let start = 0;
  while (start < buffer.length) {
    const boundaryIdx = buffer.indexOf(boundaryBuf, start);
    if (boundaryIdx === -1) break;
    const headerStart = boundaryIdx + boundaryBuf.length + 2; // skip \r\n
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(headerStart, headerEnd).toString();
    const dataStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundaryBuf, dataStart);
    const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2; // strip \r\n
    const data = buffer.slice(dataStart, dataEnd);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const ctMatch = headers.match(/Content-Type:\s*(.+)/i);

    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        files[name] = {
          filename: filenameMatch[1],
          contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
          data: data,
        };
      } else {
        fields[name] = data.toString();
      }
    }
    start = nextBoundary === -1 ? buffer.length : nextBoundary;
  }
  return { fields, files };
}

const server = http.createServer((req, res) => {
  // CORS headers — allow requests from GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  // Collect request body
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);

      if (!boundaryMatch) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
        return;
      }

      const { fields, files } = parseMultipart(buffer, boundaryMatch[1]);

      const { name, phone, email, company, comment } = fields;

      // Step 1: Create lead
      const leadParams = {
        fields: {
          TITLE: 'Заявка с сайта АКРАН',
          NAME: name || '',
          PHONE: [{ VALUE: phone || '', VALUE_TYPE: 'WORK' }],
          EMAIL: [{ VALUE: email || '', VALUE_TYPE: 'WORK' }],
          SOURCE_ID: 'WEB',
          SOURCE_DESCRIPTION: 'Сайт АКРАН — akran.ru',
        }
      };
      if (company) {
        leadParams.fields.COMPANY_TITLE = company;
      }
      let fullComment = '';
      if (company) fullComment += 'Компания: ' + company + '\n';
      if (comment) fullComment += comment;
      if (fullComment) leadParams.fields.COMMENTS = fullComment.trim();

      const leadResult = await b24Request('/crm.lead.add.json', leadParams);

      if (!leadResult.result) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to create lead', detail: leadResult }));
        return;
      }

      const leadId = leadResult.result;

      // Step 2: Upload file if present
      const fileKey = Object.keys(files)[0];
      if (fileKey) {
        const file = files[fileKey];
        const base64 = file.data.toString('base64');

        await b24Request('/crm.lead.update.json', {
          id: leadId,
          fields: {
            [`UF_CRM_1769057513043_session_id`]: {
              fileData: [file.filename, base64]
            }
          }
        });
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, leadId }));

    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
