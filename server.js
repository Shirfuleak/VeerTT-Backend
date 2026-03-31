const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   🔐 STATE
========================= */
const contactCache = new Map();
const groupCache = new Map();

const recentMessages = new Map();
const DUPLICATE_WINDOW = 5 * 60 * 1000; // 5 minutes

let latestQR = null;
let isReady = false;
let userInfo = null;

/* =========================
   📊 LEAD STORAGE
========================= */
let leads = [];
const MAX_LEADS = 500;

/* =========================
   🌐 API ROUTES
========================= */

// Health
app.get('/', (req, res) => {
    res.send("✅ Lead server + bot running");
});

// QR
app.get('/qr', (req, res) => {
    if (isReady) return res.send({ status: "connected" });
    if (!latestQR) return res.send({ status: "waiting" });
    res.send({ qr: latestQR });
});

// Status
app.get('/status', (req, res) => {
    res.send({ isReady, user: userInfo });
});

// Logout
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
        console.error("❌ Logout error:", err);
        res.status(500).send({ error: "Logout failed" });
    }
});

// Leads
app.get('/leads', (req, res) => {
    res.json(leads);
});

// Search
app.get('/search', (req, res) => {
    const q = req.query.q?.toLowerCase() || "";

    const filtered = leads.filter(l =>
        l.message.toLowerCase().includes(q) ||
        l.groupName?.toLowerCase().includes(q) ||
        l.senderName?.toLowerCase().includes(q)
    );

    res.json(filtered);
});

// Delete
app.delete('/lead/:id', (req, res) => {
    const id = Number(req.params.id);
    leads = leads.filter(l => l.id !== id);
    res.send({ status: "deleted" });
});

// Clear all
app.delete('/leads', (req, res) => {
    leads = [];
    res.send({ status: "all cleared" });
});

/* =========================
   📥 ADD LEAD
========================= */
function addLead(newLead) {
    const lead = {
        ...newLead,
        id: Date.now(),
        time: new Date()
    };

    const isDuplicate = leads.some(
        l => l.message === lead.message && l.senderNumber === lead.senderNumber
    );

    if (!isDuplicate) {
        leads.unshift(lead);
        if (leads.length > MAX_LEADS) leads.pop();
    }
}

/* =========================
   🤖 WHATSAPP BOT
========================= */

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    }
});

const keywords = [
    "pune", "mumbai",
    "cab", "car", "taxi", "vehicle", "ride",
    "drop", "pickup", "travels", "booking",
    "need", "required", "looking", "anyone",
    "book", "call", "urgent",
    "ertiga", "dzire", "swift", "innova",
    "गाडी", "कार", "कॅब", "टॅक्सी",
    "पुणे", "मुंबई",
    "हवी", "पाहिजे", "हवी आहे",
    "बुकिंग", "प्रवास",
    "कोणी आहे का"
];

// QR
client.on('qr', async (qr) => {
    console.log('📱 QR RECEIVED');

    isReady = false;
    qrcode.generate(qr, { small: true });

    try {
        latestQR = await QRCode.toDataURL(qr);
    } catch (err) {
        console.error("❌ QR conversion error:", err);
    }
});

// Ready
client.on('ready', async () => {
    console.log('⚡ WhatsApp bot is ready');

    isReady = true;
    latestQR = null;

    try {
        const info = client.info;
        userInfo = {
            name: info.pushname,
            number: info.wid.user
        };
    } catch (err) {
        console.error("❌ Error getting user info:", err);
    }
});

// 🚀 FAST & SAFE MESSAGE HANDLER
client.on('message_create', (message) => {
    setImmediate(() => handleMessage(message));
});

function extractPhoneNumbers(text) {
    const matches = text.match(/\b\d{10,13}\b/g);
    return matches || [];
}


function isDuplicateMessage(senderNumber, messageText) {
    const cleanText = messageText
        .toLowerCase()
        .replace(/[^\w\s]/gi, '')   // remove symbols
        .replace(/\s+/g, ' ')
        .trim();

    const key = senderNumber + "_" + cleanText; // ✅ NO group

    const now = Date.now();

    if (recentMessages.has(key)) {
        const lastTime = recentMessages.get(key);

        if (now - lastTime < DUPLICATE_WINDOW) {
            return true; // ❌ duplicate
        }
    }

    // ✅ store
    recentMessages.set(key, now);

    // 🧹 cleanup
    setTimeout(() => {
        recentMessages.delete(key);
    }, DUPLICATE_WINDOW);

    return false;
}

async function handleMessage(message) {
    try {
     
        // ✅ Allow both group + personal
        const isGroup = message.from.includes('@g.us');
        const isPersonal = message.from.includes('@c.us');

        if (!isGroup && !isPersonal) return;
        if (!message.body) return;

        const text = message.body.toLowerCase();

        // ✅ INCLUDE
        if (!keywords.some(k => text.includes(k))) return;

        // ❌ EXCLUDE
        const excludeKeywords = [
            "available", "free", "got cab", "i have",
            "vacant", "empty"
        ];
        if (excludeKeywords.some(k => text.includes(k))) return;

        const senderRaw = message.author || message.from;

        // ✅ FIX number for personal chat
        let senderNumber = senderRaw.split('@')[0];

        if (message.from.includes('@c.us')) {
            senderNumber = message.from.split('@')[0];
        }

        // let senderNumber = senderRaw.split('@')[0];
        let senderName = senderNumber;
        let groupName = message.from.split('@')[0];

        // 🔥 CHECK CACHE FIRST
        if (contactCache.has(senderRaw)) {
            const data = contactCache.get(senderRaw);
            senderName = data.name;
            senderNumber = data.number;
        }

        if (groupCache.has(message.from)) {
            groupName = groupCache.get(message.from);
        }

        // 🔥 ONLY FETCH IF NOT IN CACHE (VERY IMPORTANT)
        if (!contactCache.has(senderRaw) || !groupCache.has(message.from)) {
            try {
                const contact = await message.getContact();
                const chat = await message.getChat();

                // 👤 CONTACT
                if (contact) {
                    senderName = contact.pushname || contact.name || senderNumber;

                    // ⚡ BEST NUMBER SOURCE
                    senderNumber = contact.number || senderNumber;

                    contactCache.set(senderRaw, {
                        name: senderName,
                        number: senderNumber
                    });
                }

                // 👥 GROUP
                if (chat) {
                    groupName = chat.name || groupName;
                    groupCache.set(message.from, groupName);
                }

            } catch (err) {
                console.log("⚠️ Fetch skipped (safe)");
            }
        }

        console.log("🚨 LEAD:", senderName, groupName, senderNumber);

        // ❌ skip duplicate check for personal chat
        if (message.from.includes('@g.us')) {
            if (isDuplicateMessage(senderNumber, message.body)) {
                console.log("⛔ Duplicate skipped");
                return;
            }
        }

        addLead({
            groupName,
            senderName,
            senderNumber,
            message: message.body
        });

    } catch (err) {
        console.error("❌ Error:", err);
    }
}

// Reconnect
client.on('disconnected', (reason) => {
    console.log('❌ Disconnected:', reason);
    client.initialize();
});

client.initialize();

/* =========================
   🚀 START SERVER
========================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});