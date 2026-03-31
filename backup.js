const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

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

// Health check
app.get('/', (req, res) => {
    res.send("✅ Lead server + bot running");
});


app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send({ status: "connected" });
    }

    if (!latestQR) {
        return res.send({ status: "waiting" });
    }

    res.send({ qr: latestQR });
});

app.post('/logout', async (req, res) => {
    try {
        await client.logout();
        await client.destroy();

        // reset state
        isReady = false;
        userInfo = null;
        latestQR = null;

        // restart client
        client.initialize();

        res.send({ status: "logged out" });

    } catch (err) {
        console.error("❌ Logout error:", err);
        res.status(500).send({ error: "Logout failed" });
    }
});

// Receive lead (from bot internally)
function addLead(newLead) {
    const lead = {
        ...newLead,
        id: Date.now(),
        time: new Date()
    };

    // ❌ Avoid duplicates
    const isDuplicate = leads.some(
        l => l.message === lead.message && l.senderNumber === lead.senderNumber
    );

    if (!isDuplicate) {
        leads.unshift(lead);

        if (leads.length > MAX_LEADS) {
            leads.pop();
        }
    }
}

// Get leads
app.get('/leads', (req, res) => {
    res.json(leads);
});

// Search leads
app.get('/search', (req, res) => {
    const q = req.query.q?.toLowerCase() || "";

    const filtered = leads.filter(l =>
        l.message.toLowerCase().includes(q) ||
        l.groupName?.toLowerCase().includes(q) ||
        l.senderName?.toLowerCase().includes(q)
    );

    res.json(filtered);
});

app.get('/status', (req, res) => {
    res.send({
        isReady,
        user: userInfo
    });
});

// Delete one lead
app.delete('/lead/:id', (req, res) => {
    const id = Number(req.params.id);
    leads = leads.filter(l => l.id !== id);
    res.send({ status: "deleted" });
});

// Clear all leads
app.delete('/leads', (req, res) => {
    leads = [];
    res.send({ status: "all cleared" });
});

/* =========================
   🤖 WHATSAPP BOT
========================= */

const client = new Client({
    authStrategy: new LocalAuth()
});

const keywords = [
    "pune", "mumbai",
    "cab", "car", "taxi", "vehicle", "ride",
    "drop", "pickup", "travels", "booking",
    "need", "required", "looking", "anyone",
    "available", "book", "call", "urgent",
    "ertiga", "dzire", "swift", "innova",
    "गाडी", "कार", "कॅब", "टॅक्सी",
    "पुणे", "मुंबई",
    "हवी", "पाहिजे", "हवी आहे",
    "बुकिंग", "प्रवास",
    "कोणी आहे का", "उपलब्ध"
];


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

// Message listener
client.on('message_create', async message => {
    try {
        if (!message.from.includes('@g.us')) return;
        if (!message.body) return;

        const text = message.body.toLowerCase();

        if (!keywords.some(k => text.includes(k))) return;

        const contact = await message.getContact();
        const chat = await message.getChat();

        const senderName = contact.pushname || contact.number;
        const senderNumber = contact.number;
        const groupName = chat.name;

        console.log("🚨 LEAD:", message.body);

        // Save lead
        addLead({
            groupName,
            senderName,
            senderNumber,
            message: message.body
        });

        // Send alert to yourself
        await client.sendMessage(
            client.info.wid._serialized,
            `🚨 *NEW LEAD* 🚨

👥 Group: ${groupName}
👤 Name: ${senderName}
📞 Number: ${senderNumber}

📩 Message:
${message.body}`
        );

    } catch (err) {
        console.error("❌ Error:", err);
    }
});

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