const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const PQueue = require('p-queue').default;

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   🔐 STATE
========================= */
const contactCache = new Map();
const groupCache = new Map();

const recentMessages = new Map();
const DUPLICATE_WINDOW = 5 * 60 * 1000;

let latestQR = null;
let isReady = false;
let userInfo = null;

/* =========================
   📊 LEAD STORAGE
========================= */
let leads = [];
const MAX_LEADS = 500;

const queue = new PQueue({ concurrency: 1 });

/* =========================
   🌐 API ROUTES
========================= */

app.get('/', (req, res) => {
  res.send("✅ Lead server + bot running");
});

app.get('/qr', (req, res) => {
  if (isReady) {
    return res.json({ status: "connected" });
  }

  if (!latestQR) {
    return res.json({ status: "waiting" });
  }

  return res.json({
    status: "qr",
    qr: latestQR
  });
});

app.get('/status', (req, res) => {
  res.send({ isReady, user: userInfo });
});

app.post('/logout', async (req, res) => {
  try {
    await client.logout();
    await client.destroy();

    isReady = false;
    userInfo = null;
    latestQR = null;

    client.initialize();

    res.send({ status: "logged out" });
  } catch (err) {
    res.status(500).send({ error: "Logout failed" });
  }
});

app.get('/leads', (req, res) => res.json(leads));

/* =========================
   📥 ADD + UPDATE LEADS
========================= */

function addLead(newLead) {
  const lead = {
    ...newLead,
    id: Date.now(),
    time: new Date(),
    senderRaw: newLead.senderRaw,
    groupRaw: newLead.groupRaw
  };

  leads.unshift(lead);
  if (leads.length > MAX_LEADS) leads.pop();
}

function updateOldLeads(senderRaw, groupRaw, name, number, group) {
  leads = leads.map(lead => {
    if (lead.senderRaw === senderRaw || lead.groupRaw === groupRaw) {
      return {
        ...lead,
        senderName: name,
        senderNumber: number,
        groupName: group
      };
    }
    return lead;
  });
}

/* =========================
   🤖 WHATSAPP BOT
========================= */

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // 👈 IMPORTANT
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  }
});

const keywords = [
  "pune","mumbai","cab","car","taxi","vehicle","ride",
  "drop","pickup","travels","booking",
  "need","required","looking","anyone",
  "book","call","urgent"
];



client.on('qr', async (qr) => {
  console.log("📱 QR EVENT TRIGGERED"); // 👈 ADD THIS

  isReady = false;

  const qrImage = await QRCode.toDataURL(qr);
  latestQR = qrImage;

  console.log("✅ QR STORED");
});

client.on('ready', () => {
  console.log("✅ CLIENT READY");

  isReady = true;
  latestQR = null;

  userInfo = {
    name: client.info.pushname,
    number: client.info.wid.user
  };
});

client.on('message_create', (message) => {
  queue.add(() => handleMessage(message));
});

client.on('loading_screen', (percent, message) => {
  console.log(`Loading: ${percent}% - ${message}`);
});

/* =========================
   🧠 DUPLICATE CHECK
========================= */

function isDuplicateMessage(senderNumber, messageText) {
  const clean = messageText.toLowerCase().replace(/\W+/g, ' ').trim();
  const key = senderNumber + "_" + clean;
  const now = Date.now();

  if (recentMessages.has(key)) {
    if (now - recentMessages.get(key) < DUPLICATE_WINDOW) {
      return true;
    }
  }

  recentMessages.set(key, now);
  setTimeout(() => recentMessages.delete(key), DUPLICATE_WINDOW);

  return false;
}

/* =========================
   📩 MESSAGE HANDLER
========================= */

async function handleMessage(message) {
  try {
    if (!message.body) return;

    const text = message.body.toLowerCase();
    if (!keywords.some(k => text.includes(k))) return;

    const exclude = ["available","free","got cab","i have"];
    if (exclude.some(k => text.includes(k))) return;

    const senderRaw = message.author || message.from;
    const senderId = senderRaw.split('@')[0];

    const groupRaw = message.from;
    const groupId = groupRaw.split('@')[0];

    let senderName = senderId;
    let senderNumber = senderId;
    let groupName = groupId;

    let cached = false;

    // ✅ cache check
    if (contactCache.has(senderRaw)) {
      const c = contactCache.get(senderRaw);
      senderName = c.name;
      senderNumber = c.number;
      cached = true;
    }

    if (groupCache.has(groupRaw)) {
      groupName = groupCache.get(groupRaw);
      cached = true;
    }

    // 🔥 fetch if not cached
    if (!cached) {
      try {
        const contact = await message.getContact();
        const chat = await message.getChat();

        if (contact) {
          senderName = contact.pushname || senderId;
          senderNumber = contact.number || senderId;

          contactCache.set(senderRaw, {
            name: senderName,
            number: senderNumber
          });
        }

        if (chat) {
          groupName = chat.name || groupId;
          groupCache.set(groupRaw, groupName);
        }

        // 🔥 update old leads
        updateOldLeads(senderRaw, groupRaw, senderName, senderNumber, groupName);

      } catch (err) {}
    }

    if (isDuplicateMessage(senderNumber, message.body)) return;

    addLead({
      groupName,
      senderName,
      senderNumber,
      message: message.body,
      senderRaw,
      groupRaw
    });

  } catch (err) {
    console.error(err.message);
  }
}

/* =========================
   🔄 RECOVERY
========================= */

client.on('disconnected', () => {
  setTimeout(() => client.initialize(), 5000);
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

console.log("App initializing...");

client.initialize();


/* =========================
   🚀 START SERVER
========================= */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));