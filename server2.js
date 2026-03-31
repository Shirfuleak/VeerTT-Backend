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
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ],
        protocolTimeout: 120000
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

async function handleMessage(message) {
    try {
        if (!message.from.includes('@g.us')) return;
        if (!message.body) return;

        const text = message.body.toLowerCase();

        // ✅ INCLUDE
        if (!keywords.some(k => text.includes(k))) return;

        // ❌ EXCLUDE (avoid wrong leads)
        const excludeKeywords = [
            "available", "free", "got cab", "i have",
            "vacant", "empty"
        ];
        if (excludeKeywords.some(k => text.includes(k))) return;

        // 🚀 SAFE DATA (NO PUPPETEER CALLS)
        // const senderRaw = message.author || message.from;
        const senderRaw = message.author || message.from;
        // const senderNumber = senderRaw.split('@')[0];

        // const senderNumber = senderRaw.replace(/@.*/, "");
        const senderNumber =
    message._data?.participant?.split('@')[0] ||
    senderRaw.split('@')[0];
        const groupId = message.from.replace(/@.*/, "");

        const senderName =
            message._data?.notifyName ||
            message._data?.pushname ||
            senderNumber;

        // const groupName =
        //     message._data?.chat?.name ||
        //     groupId;
        const groupName =
    message._data?.chat?.formattedTitle ||
    message._data?.chat?.name ||
    "Unknown Group";

        console.log("🚨 LEAD:", senderName, message.body);

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

app.listen(5000, () => {
    console.log("🚀 Server running on http://localhost:5000");
});