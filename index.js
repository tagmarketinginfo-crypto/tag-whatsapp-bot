// TAG WhatsApp Cloud API bot
// Flow: WhatsApp -> Meta webhook -> this server -> Claude (Anthropic API) -> reply -> WhatsApp Cloud API
//
// Required env vars (set them in your hosting provider's dashboard, never in code):
//   VERIFY_TOKEN             - any string you make up yourself, used only for the Meta webhook handshake
//   WHATSAPP_TOKEN           - permanent/System User access token from Meta (WhatsApp > API Setup / System Users)
//   WHATSAPP_PHONE_NUMBER_ID - the "Phone number ID" shown in Meta Developers > WhatsApp > API Setup
//   ANTHROPIC_API_KEY        - API key from console.anthropic.com
//   APP_SECRET               - (optional) App Secret from Meta app > Settings > Basic, verifies webhook calls

const express = require('express');
const crypto = require('crypto');

const app = express();

app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
}));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET;

const seenMessageIds = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;

function alreadyHandled(id) {
    const now = Date.now();
    for (const [k, t] of seenMessageIds) {
          if (now - t > DEDUP_TTL_MS) seenMessageIds.delete(k);
    }
    if (seenMessageIds.has(id)) return true;
    seenMessageIds.set(id, now);
    return false;
}

const SYSTEM_PROMPT = `Ty - II-assistent kompanii Total Advertising Group (TAG), reklamnogo agentstva v Dushanbe (tag.tj).
Otvechay v WhatsApp-chate klientu: korotko, druzhelyubno, po-russki, bez kantselyarita, 2-5 predlozheniy maksimum.

Fakty o kompanii:
- Uslugi: strategicheskoe planirovanie, brending i dizayn, prodakshn video/audio, media-reklama (TV, radio, naruzhnaya reklama, pressa), digital-marketing (Google, Yandeks, MyTarget, Viber, SMM/Instagram), BTL i promo-aktivnosti, analitika i mediaplaning.
- Ofis: ul. Ayni 48, Hilton Dushanbe, 2 etazh, Dushanbe.
- Telefon: +992 44 610 58 38
- Email: info@tag.tj
- Sayt: tag.tj
- Tochnuyu stoimost proekta agentstvo nikogda ne nazyvaet bez brifa. Esli sprashivayut tsenu, poprosi korotko opisat biznes i tsel, poobeshchay chto menedzher poschitaet i vernyotsya s tsiframi.
- Primery keysov ne nazyvay po imenam klientov, skazhi chto primery est na sayte tag.tj v razdele Keysy.

Kogda peredavat cheloveku: esli vopros slozhnyy, klient prosit menedzhera/cheloveka/operatora, zhaluetsya, ili ty ne uveren v otvete - skazhi chto podklyuchaesh menedzhera.

Format: obychnyy tekst bez markdown, prostye emodzi po smyslu, ne v kazhdom soobshchenii.`;

async function askClaude(userText) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
                  'content-type': 'application/json',
                  'x-api-key': ANTHROPIC_API_KEY,
                  'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
                  model: 'claude-3-5-haiku-20241022',
                  max_tokens: 400,
                  system: SYSTEM_PROMPT,
                  messages: [{ role: 'user', content: userText }],
          }),
    });
    if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error('Anthropic API error', resp.status, errText.slice(0, 300));
          throw new Error('ai_request_failed');
    }
    const data = await resp.json();
    return data.content?.[0]?.text?.trim() || 'Izvinite, ne smog otvetit. Podklyuchayu menedzhera.';
}

async function sendWhatsAppMessage(to, text) {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    const resp = await fetch(url, {
          method: 'POST',
          headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${WHATSAPP_TOKEN}`,
          },
          body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to,
                  type: 'text',
                  text: { body: text },
          }),
    });
    if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error('WhatsApp send error', resp.status, errText.slice(0, 300));
    }
    return resp.ok;
}

function verifySignature(req) {
    if (!APP_SECRET) return true;
    const signature = req.get('x-hub-signature-256');
    if (!signature || !req.rawBody) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
    try {
          return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
          return false;
    }
}

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
          return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

           if (!verifySignature(req)) {
                 console.error('Webhook signature verification failed');
                 return;
           }

           try {
                 const entry = req.body.entry?.[0];
                 const change = entry?.changes?.[0];
                 const value = change?.value;
                 if (!value) return;

      if (value.statuses) return;

      const message = value.messages?.[0];
                 if (!message) return;

      if (message.from === PHONE_NUMBER_ID) return;

      if (alreadyHandled(message.id)) {
              console.log('Duplicate webhook delivery, skipping', message.id);
              return;
      }

      if (message.type !== 'text') {
              await sendWhatsAppMessage(message.from, 'Poka umeyu otvechat tolko na tekstovye soobshcheniya.');
              return;
      }

      const userText = message.text?.body || '';
                 console.log('Incoming message', { from: message.from, id: message.id, len: userText.length });

      const reply = await askClaude(userText);
                 await sendWhatsAppMessage(message.from, reply);
           } catch (err) {
                 console.error('Error handling webhook payload:', err.message);
           }
});

app.get('/', (req, res) => {
    res.send('TAG WhatsApp bot is running.');
});

app.listen(PORT, () => {
    console.log(`TAG WhatsApp bot listening on port ${PORT}`);
});
