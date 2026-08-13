const express = require('express');
const cors = require('cors');
const pdfParseModule = require('pdf-parse');
const pdfParse = typeof pdfParseModule === 'function'
  ? pdfParseModule
  : (pdfParseModule.pdf || pdfParseModule.default || pdfParseModule.PDFParse);
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.options('*', cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json({ limit: '20mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const MAX_CHARS_PER_PDF = 30000;

async function flatten(content) {
  if (typeof content === 'string') return content;

  const parts = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'document' && block.source?.data) {
      const title = block.title || 'document.pdf';
      try {
        const buffer = Buffer.from(block.source.data, 'base64');
        const parsed = await pdfParse(buffer);
        let text = (parsed.text || '').trim();

        if (!text) {
          parts.push(`--- ${title} ---\n[No extractable text. This PDF may be a scanned image.]`);
          continue;
        }

        if (text.length > MAX_CHARS_PER_PDF) {
          text = text.slice(0, MAX_CHARS_PER_PDF) + '\n[truncated]';
        }

        parts.push(`--- ${title} ---\n${text}`);
      } catch (err) {
        console.error('PDF parse failed for', title, err.message);
        parts.push(`--- ${title} ---\n[Could not read this PDF.]`);
      }
    }
  }

  return parts.join('\n\n');
}

app.post('/api/chat', async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'Groq API key not configured on server' });
  }

  try {
    const groqMessages = [
      { role: 'system', content: system || 'You are a helpful assistant.' }
    ];

    for (const m of messages) {
      groqMessages.push({ role: m.role, content: await flatten(m.content) });
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        messages: groqMessages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Groq API error' });
    }

    const reply = data.choices?.[0]?.message?.content;
    if (!reply) {
      return res.status(500).json({ error: 'No response from Groq' });
    }

    res.json({ content: [{ text: reply }] });

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

setInterval(() => {
  fetch('https://rag-based-llm-backend.onrender.com/health')
    .then(() => console.log('keep-alive ping'))
    .catch(() => {});
}, 10 * 60 * 1000);